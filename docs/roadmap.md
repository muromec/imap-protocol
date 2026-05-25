# Roadmap — imap-connector

A phased plan to grow the module from a project-specific polling client into
a general-purpose IMAP library while keeping the same principles: zero
dependencies, promise-based API, no streaming parser unless necessary.

## Status

| Batch | Scope | Status | Tests |
|---|---|---|---|
| 1 | Test infrastructure + existing API | ✅ Complete | 25 + 1 todo |
| 2 | Connection robustness | ✅ Complete | 33 + 2 todo |
| 3a | IDLE prerequisites | ✅ Complete | 37 + 2 todo |
| 3b | IDLE implementation + dead-connection guard | ✅ Complete | 46 + 2 todo |
| 4 | Mailbox management | Not started | — |
| 5 | Message mutation | Not started | — |
| 6 | Richer fetch | Not started | — |
| 7 | Advanced search and sort | Not started | — |
| 8 | Gmail extensions | Not started | — |

## Guiding principles

1. **Reject outdated servers.** If a required capability (e.g. `UIDPLUS`,
   `IDLE`) is missing, throw a descriptive error rather than silently
   degrading.
2. **Batch features by dependency.** Each batch builds on the previous one.
   No batch requires rewriting an earlier one.
3. **Testable in isolation.** Every new public method and every protocol
   edge case gets a unit test against a mock IMAP server.

---

## Batch 1 — test infrastructure ✅ COMPLETE

**Goal:** A mock IMAP server that speaks enough protocol to test the existing
module without a real mailbox.

### Delivered

`MockImapServer` (`mock.ts`) — binds to a random local port, accepts
connections, sends a greeting, then replays a pre-configured **scenario** of
expected commands and canned responses.  Key features:

- Regex-based command matching with auto-tagged `OK` completion.
- Literal `{size}` handling — raw data sent without extra `\r\n` framing.
- `allowExtra` mode for cleanup commands (LOGOUT, etc.) after scenario ends.
- Per-test isolation via a factory + `afterAll` cleanup list.

Sample use:

```ts
server.scenario([
  { expect: /^A\d+ LOGIN /,         respond: "A0001 OK logged in" },
  { expect: /^A\d+ SELECT "INBOX"/, respond: ["* 3 EXISTS", "* 1 RECENT"] },
]);
```

### Tests delivered (connection.test.ts)

25 passing + 1 `todo`:

| Group | Tests |
|---|---|
| `connect` | greeting + LOGIN, LOGIN NO rejection, LOGIN BAD rejection |
| `openBox` | SELECT parsing (EXISTS, RECENT, FLAGS, UIDVALIDITY, UIDNEXT, UNSEEN), EXAMINE flag, UNSEEN from OK code |
| `search` | UNSEEN results, empty SEARCH, nested FROM/HEADER/UID criteria, LARGER |
| `fetch` | single message, multiple messages (seqno/uid/flags pairing), empty input, custom body part (HEADER), empty flags |
| `fetch` (todo) | multi-body-part fetch on continuation lines |
| `addFlags` | single flag, missing backslash prefix, flag array, tagged NO rejection |
| `fetchUnseen` | search UNSEEN + fetch chain, empty when no unseen |
| `close` | LOGOUT sent, LOGOUT failure handled gracefully |

---

## Batch 2 — connection robustness ✅ COMPLETE

**Goal:** Production-grade connection handling.

### Delivered

All features implemented in `connection.ts`:

- `connTimeout`, `authTimeout`, `commandTimeout` — with `setTimeout`/`clearTimeout`.
- CAPABILITY detection — sent after LOGIN, populates `capabilities: Set<string>`.
- `serverSupports(cap)` — case-insensitive lookup.
- `openBox()` gates on `IMAP4REV1` when capabilities are known; skips check if CAPABILITY failed.
- `tlsOptions` config forwarded to both implicit TLS and STARTTLS upgrade paths.
- `autotls: "always" | "required"` — sends STARTTLS after greeting, upgrades socket, then LOGIN.
- `tls` now defaults to `true` (was required).

### Tests delivered (8 new, 33 total + 2 todo)

| Test | Status |
|---|---|
| `connect()` times out on slow greeting (unroutable address) | ✅ |
| `connect()` times out on slow LOGIN (authTimeout) | ✅ |
| Command timeout rejects when authTimeout fires | ✅ |
| CAPABILITY parsed into `capabilities` set | ✅ |
| `serverSupports("IMAP4rev1")` returns true | ✅ |
| `serverSupports("X-MADE-UP")` returns false | ✅ |
| `openBox()` throws when IMAP4rev1 missing | ✅ |
| `autotls: "required"` throws when STARTTLS unavailable | ✅ |
| STARTTLS upgrade happy path | todo (needs TLS-capable mock) |

### Deferred / untested

- **STARTTLS happy path** cannot be unit-tested with the plain-TCP mock server.
  The code path is exercised by inspection; a TLS-capable mock (self-signed
  cert) would be needed.  Not urgent: the project uses implicit TLS on port
  993, so STARTTLS is never triggered in production.
- **Per-command timeout** for non-LOGIN commands shares the same mechanism as
  `authTimeout` and is not independently tested.
- See `docs/untested.md` for a full catalogue of untested behaviours.

---

## Batch 3 — IDLE and push events

**Goal:** Real-time notification of new mail and mailbox changes without
polling.

### Batch 3a — Prerequisites ✅ COMPLETE

Four of five blockers identified in `docs/idle-races.md` have been addressed
in `connection.ts`.  These are independently useful improvements that also
unblock IDLE:

1. ✅ **`+` continuation handling** — `ImapReader` detects `+` lines and
   routes them to `onContinue`.  `Connection` exposes
   `sendCommandWithContinuation()` for IDLE/APPEND.  *(Race #4)*

2. ✅ **Socket error propagation** — `#failAllPending()` rejects all
   outstanding promises on socket `"close"` or `"error"`.  The mock server
   destroys the socket on unexpected commands.  *(Race #10, also fixes
   untested.md #7)*

3. ✅ **`fetch()` concurrency guard** — `fetch()` throws `"A fetch is
   already in progress"` if called while another fetch is in-flight.
   *(Race #7)*

4. ✅ **`#onLiteral` / `#handleFetchLine` safety** — `#handleFetchLine`
   returns early when no `#fetchResolve` is set, preventing unsolicited
   FETCH responses during IDLE from leaking into fetch state.  *(Race #9)*

The fifth prerequisite — **post-DONE event drain** *(Race #2)* — is deferred
to the `idle()` implementation itself (Batch 3b).

### Tests delivered (5 new, 37 total + 2 todo)

| Test | Status |
|---|---|
| Socket close rejects pending commands | ✅ |
| `fetch()` throws when called concurrently | ✅ |
| `sendCommandWithContinuation()` is callable | ✅ |
| Unsolicited FETCH during non-fetch is ignored | ✅ |
| Socket error propagation (socket error test) | merged into close test |

### Batch 3b — IDLE implementation ✅ COMPLETE

**Goal:** Real-time notification of new mail and mailbox changes.

### Delivered

`idle()` method returning `AsyncIterable<IdleEvent>`:

- Sends `IDLE`, waits for `+ idling` continuation via `sendCommandWithContinuation`.
- Uses an `#idleHook` callback in `#dispatchLine` to intercept untagged lines
  and parse them into `IdleEvent` objects (EXISTS, RECENT, EXPUNGE, FETCH
  flags, FLAGS changes).
- On `break` / `return()`: sends `DONE`, drains remaining untagged events
  until the tagged OK arrives, then resolves.
- Throws if the server lacks the `IDLE` capability.
- Command timeout applies while waiting for the tagged OK.

The hook-based approach avoids overriding the private `#dispatchLine` method
(which is not assignable in JavaScript).

Mock server (`mock.ts`) supports `+` continuations and `DONE` detection.

### Tests delivered (6 new, 43 total + 2 todo)

| Test | Status |
|---|---|
| `idle()` throws if server lacks IDLE capability | ✅ |
| Yields EXISTS event | ✅ |
| Yields EXPUNGE event | ✅ |
| Yields FETCH flags-change event (UID, FLAGS parsed) | ✅ |
| Yields RECENT event | ✅ |
| Post-DONE drain: events after DONE before tagged OK are yielded | ✅ |
| IDLE loop exits cleanly when socket closes | ✅ |
| `sendCommand` rejects immediately with `"Connection is dead"` after socket close | ✅ |
| `close()` returns immediately on a dead connection | ✅ |

### Deferred

- **`watch()` method** (auto-reconnecting IDLE loop) is deferred.  It
  requires socket-close-on-reconnect handling and a re-fetch-after-reconnect
  strategy, both of which are non-trivial.  Tracked as a future batch item.

---

## Batch 4 — mailbox management

**Goal:** Full mailbox CRUD plus status queries.

### Features

| Method | IMAP command | Notes |
|---|---|---|
| `closeBox(autoExpunge?)` | CLOSE / UNSELECT | Gated on `UNSELECT` cap for non-expunge close |
| `createBox(name)` | CREATE | UTF-7 encode name |
| `deleteBox(name)` | DELETE | |
| `renameBox(oldName, newName)` | RENAME | |
| `subscribeBox(name)` | SUBSCRIBE | |
| `unsubscribeBox(name)` | UNSUBSCRIBE | |
| `listBoxes(prefix?)` | LIST | Returns tree (matching `MailBoxes` from old API) |
| `listSubscribed(prefix?)` | LSUB | |
| `status(boxName)` | STATUS | Returns `MailboxInfo` for unselected mailbox |
| `expunge(uids?)` | EXPUNGE / UID EXPUNGE | Gated on `UIDPLUS` for UID EXPUNGE |

### Tests

- `createBox` sends `CREATE "name"`, resolves on OK, rejects on NO.
- `listBoxes` parses LIST responses into a nested tree.
- `status` parses STATUS response with MESSAGES, RECENT, UNSEEN, UIDVALIDITY,
  UIDNEXT.
- `renameBox` updates internal `#mailboxInfo.name` if renaming the currently
  open mailbox.
- `expunge([1, 2, 3])` sends `UID EXPUNGE 1,2,3` when UIDPLUS supported.
- `expunge()` (no args) sends plain `EXPUNGE`.

---

## Batch 5 — message mutation

**Goal:** Copy, move, append, and full flag/keyword management.

### Features

| Method | IMAP command | Notes |
|---|---|---|
| `copy(uids, destBox)` | UID COPY | |
| `move(uids, destBox)` | UID MOVE | Gated on `MOVE` cap; falls back to COPY + STORE + EXPUNGE |
| `append(data, mailbox?, flags?, date?)` | APPEND | `data` is `string | Buffer` (raw RFC822) |
| `delFlags(uids, flags)` | UID STORE -FLAGS.SILENT | |
| `setFlags(uids, flags)` | UID STORE FLAGS.SILENT | |
| `addKeywords(uids, keywords)` | UID STORE +KEYWORDS.SILENT | |
| `delKeywords(uids, keywords)` | UID STORE -KEYWORDS.SILENT | |
| `setKeywords(uids, keywords)` | UID STORE KEYWORDS.SILENT | |

### Tests

- `copy([1], "Archive")` sends `UID COPY 1 "Archive"`.
- `move` uses `UID MOVE` when capability present.
- `move` falls back to COPY+DELETE+EXPUNGE when MOVE unsupported.
- `append` sends literal data correctly with `{size}` syntax.
- `append` includes flags and date when provided.
- Keyword methods validate characters (reject `(`, `)`, `{`, `%`, `*`, etc.).

---

## Batch 6 — richer fetch

**Goal:** Fetch envelope, structure, headers, and individual body parts
without pulling the entire RFC822 message.

### Design

Extend `FetchOptions`:

```ts
interface FetchOptions {
  bodies?: string | string[];        // existing
  envelope?: boolean;                // ENVELOPE
  struct?: boolean;                  // BODYSTRUCTURE
  size?: boolean;                    // RFC822.SIZE
  markSeen?: boolean;                // use BODY (not .PEEK)
  modifiers?: Record<string, string>; // e.g. { CHANGEDSINCE: "123" }
}
```

Extend `FetchedMessage`:

```ts
interface FetchedMessage {
  uid: number;
  seqno: number;
  body?: string;                    // only if bodies requested
  flags: string[];
  envelope?: Envelope;              // if envelope: true
  struct?: BodyStructure;           // if struct: true
  size?: number;                    // if size: true
  modseq?: string;                  // if CONDSTORE
}
```

The `Envelope` and `BodyStructure` types come from the old `imap-module`
type definitions — they map directly to IMAP's ENVELOPE and BODYSTRUCTURE
response formats.

### Implementation note

This is the first batch that requires parsing parenthesized lists from IMAP
responses.  Rather than a full streaming parser, we can use a simple
recursive-descent parser that operates on a single response line (after the
literal handler has extracted any binary bodies).  The ENVELOPE and
BODYSTRUCTURE responses are well-formed S-expressions, so a ~100-line parser
is sufficient.

### Tests

- `fetch([1], { envelope: true })` parses ENVELOPE into structured object.
- `fetch([1], { struct: true })` parses BODYSTRUCTURE tree.
- `fetch([1], { bodies: ["HEADER"] })` returns only headers.
- `fetch([1], { bodies: ["1"], struct: true })` returns MIME part 1 body plus
  structure for all parts.
- `fetch([1], { markSeen: true })` sends `BODY[]` not `BODY.PEEK[]`.
- `fetch([1], { modifiers: { CHANGEDSINCE: "42" } })` includes modifiers in
  the FETCH command.

---

## Batch 7 — advanced search and sort

**Goal:** SORT, ESEARCH, THREAD, and the full search criteria set.

### Features

| Method | IMAP command | Notes |
|---|---|---|
| `sort(sorts, criteria)` | UID SORT | Gated on `SORT` capability |
| `esearch(criteria, options?)` | UID SEARCH RETURN (...) | Gated on `ESEARCH` capability |
| `thread(algorithm, criteria)` | UID THREAD | Gated on `THREAD=...` capability |

Full search criteria support in `buildSearchQuery`:
- Charset detection (UTF-8 vs US-ASCII).
- Nested `OR` groups.
- `HEADER field value` with empty-value support.
- Date criteria properly formatted (`DD-Mon-YYYY`).
- `LARGER` / `SMALLER` with integer validation.
- `NOT` / `!` prefix negation.
- `KEYWORD` criteria.

### Tests

- `sort(["-DATE"], ["UNSEEN"])` sends `UID SORT (REVERSE DATE) US-ASCII
  UNSEEN`.
- `thread("REFERENCES", ["ALL"])` returns threaded UID tree.
- `esearch(["UNSEEN"], ["MIN", "MAX"])` parses ESEARCH response.
- UTF-8 characters in search terms trigger CHARSET UTF-8 and literal
  encoding.
- Nested `OR` with three levels produces valid query.

---

## Batch 8 — Gmail extensions

**Goal:** Gmail-specific features.

### Features

| Feature | Capability gate |
|---|---|
| `addLabels(uids, labels)` | `X-GM-EXT-1` |
| `delLabels(uids, labels)` | `X-GM-EXT-1` |
| `setLabels(uids, labels)` | `X-GM-EXT-1` |
| `getSpecialUseBoxes()` (XLIST) | `XLIST` |

### Tests

- `addLabels` sends `UID STORE ... +X-GM-LABELS.SILENT (...)`.
- `getSpecialUseBoxes` parses XLIST response and sets `special_use_attrib` on
  Folder nodes.

---

## Summary

| Batch | Scope | Complexity | Tests | Depends on |
|---|---|---|---|---|
| 1 | Mock server + existing tests | Low | ~15 | — |
| 2 | Robust connection, capabilities | Medium | ~10 | 1 |
| 3 | IDLE / push events | High | ~7 | 1, 2 |
| 4 | Mailbox CRUD | Medium | ~8 | 1, 2 |
| 5 | Message mutation | Medium | ~8 | 1, 2 |
| 6 | Rich fetch (envelope, struct) | High | ~6 | 1, 2 |
| 7 | Advanced search and sort | Medium | ~6 | 1, 2 |
| 8 | Gmail extensions | Low | ~3 | 1, 2 |

Total: ~63 tests covering the full IMAP surface used by modern clients.

Batches 3–8 are independent of each other and can be implemented in any order
after batch 2.  Only batch 1 and 2 are required foundations.