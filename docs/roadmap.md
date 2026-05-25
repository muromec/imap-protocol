# Roadmap — imap-connector

A phased plan to grow the module from a project-specific polling client into
a general-purpose IMAP library while keeping the same principles: zero
dependencies, promise-based API, no streaming parser unless necessary.

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

### Prerequisites (must-fix from `docs/idle-races.md`)

Before IDLE can be implemented, five race conditions must be addressed.
These are blockers, not design choices:

1. **`+` continuation handling.**  `#dispatchLine` must detect `+` lines
   (IMAP continuations) and route them to a dedicated callback.  IDLE uses
   `+ idling` to signal entry into idle state; APPEND uses `+` for
   send-literal acknowledgement.  Without this, IDLE cannot work at all.
   *(Race #4)*

2. **Socket error propagation.**  A socket `"close"` or `"error"` during
   IDLE must reject pending promises (or yield a sentinel event) rather
   than hanging until command timeout.  The current architecture has no
   mechanism to propagate socket-level events to `#pending` entries.
   *(Race #10, also fixes untested.md #7)*

3. **`fetch()` concurrency guard.**  Concurrent `fetch()` calls overwrite
   each other's `#fetchResolve`, `#fetchResults`, and `#fetchQueue`.
   Either throw if a fetch is in-flight, or maintain per-tag fetch state
   in a `Map`.  *(Race #7)*

4. **`#onLiteral` safety when `#fetchQueue` is empty.**  During IDLE,
   unsolicited FETCH responses with body literals arrive with no queue
   entry.  `#onLiteral` currently calls `#fetchQueue?.shift()` which
   returns `undefined`, dropping the literal data silently.  Must either
   emit the literal as an IDLE event or skip it cleanly.  *(Race #9)*

5. **Post-DONE event drain.**  After sending `DONE`, the server may still
   send untagged responses before the tagged OK.  The IDLE iterator must
   continue yielding events until the tagged OK arrives.  Stopping early
   drops events.  *(Race #2)*

### Design

Once prerequisites are addressed, `IDLE` is modelled as an `AsyncIterator`:

```ts
interface IdleEvent {
  type: "exists" | "recent" | "expunge" | "fetch" | "flags";
  seqno?: number;
  count?: number;
  uid?: number;
  flags?: string[];
}

class Connection {
  // Enter IDLE. Returns an async iterator of events.
  // Call .return() on the iterator (or break out of the loop) to send DONE.
  idle(): AsyncIterable<IdleEvent>;

  // Convenience: idle + auto-reconnect on disconnect.
  // Yields events until manually stopped.
  watch(mailbox: string): AsyncIterable<IdleEvent>;
}
```

### Protocol flow

1. Client sends `IDLE\r\n`.
2. Server responds with `+ idling` (continuation).
3. Server sends untagged responses as events occur: `* 5 EXISTS`, `* 2
   EXPUNGE`, `* 4 FETCH (FLAGS (\Seen))`, etc.
4. Client sends `DONE\r\n` to exit IDLE.
5. Server sends tagged OK for the IDLE command.

The `idle()` method:
- Sends `IDLE`, waits for `+`.
- Yields parsed events from untagged responses.
- On `return()` / `break`, sends `DONE`, waits for tagged OK, returns.
- If the server doesn't support `IDLE` (checked via `serverSupports`),
  throws.

The `watch()` method:
- Opens the mailbox.
- Enters `idle()`, yields events.
- On any socket error or unexpected disconnect, reconnects, re-selects the
  mailbox, re-enters idle.  Transparent to the caller.

### Tests

- `idle()` yields EXISTS event when server sends `* N EXISTS`.
- `idle()` yields EXPUNGE event.
- `idle()` yields FETCH (flags change) event.
- Breaking out of the `for await` loop sends DONE and resolves.
- `idle()` throws if server lacks IDLE capability.
- `watch()` reconnects and resumes after socket close.
- `watch()` re-SELECTs the mailbox after reconnect.

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