# Design decisions — imap-connector

## Why a new module

The project previously used `vendored/imap` ("imap-module"), an ESM fork of
the ancient `node-imap` library.  That library has an event/callback API that
requires substantial boilerplate to use with `async`/`await`:

- `connect()` fires `"ready"` → needs `new Promise` + `once("ready")`
- `openBox()` takes a callback → needs manual promisification
- `fetch()` returns an `EventEmitter` that emits `"message"` events, each of
  which is another `EventEmitter` that emits `"body"` with a stream → needs a
  wait-list to track in-flight messages plus stream-to-string conversion

Every consumer of `imap-module` was forced to reinvent these wrappers.  The
new module absorbs all of that complexity so callers get a flat promise-based
API and never see an event emitter or a raw stream.

## Zero dependencies

`imap-connector` has **no runtime dependencies**.  It speaks IMAP directly
over a `node:tls` socket (or a plain `node:net` socket when `tls: false`
is set — primarily used by the mock server in tests).  This means:

- No dependency on `imap-module` or any other IMAP library.
- No dependency on a streaming MIME parser — we return the raw RFC822 body
  and let the caller decide how to parse it (the project already uses
  `postal-mime` for that).
- The only external APIs are `node:tls` and `node:net`.

## Test infrastructure — MockImapServer

Every public method and protocol edge case is covered by unit tests that
run against a mock IMAP server (`mock.ts`) — no real network required.
The full suite runs in under 1 second.

### Design

`MockImapServer` binds to a random local port, accepts a connection, sends
a greeting, then replays a pre-configured **scenario** of expected commands
and canned responses.

```ts
server.scenario([
  { expect: /^A\d+ LOGIN /,         respond: "A0001 OK logged in" },
  { expect: /^A\d+ SELECT "INBOX"/, respond: ["* 3 EXISTS", "* 1 RECENT"] },
]);
```

Each step either matches the command (prompting a response) or, when
`allowExtra` is set, sends a dummy `OK` so the client doesn't hang.
Tagged `OK` completions are auto-appended to every step that doesn't
already include one.  Literals (`{size}`) are handled by sending the
data bytes raw followed by `\r\n`.

### Test isolation

Each test creates a fresh `MockImapServer` instance via a factory
function.  The factory registers the server in a cleanup list; `afterAll`
closes all of them.  No shared state between tests, so the suite runs
concurrently without locks.


`vendored/imap/Parser.js` is ~1000 lines of streaming parser that
tokenizes IMAP responses into structured objects (fetch attributes, envelope
structures, BODYSTRUCTURE trees, etc.).  Most of that complexity comes from
parsing parenthesized lists and nested MIME structures.

We don't need any of that.  The project's usage pattern is:

1. SELECT INBOX
2. UID SEARCH UNSEEN
3. UID FETCH ... BODY.PEEK[]  (full raw message)
4. UID STORE ... +FLAGS.SILENT (\Seen)

For this pattern we only need:

- **Line framing** — split the TCP byte stream on `\r\n` boundaries.
- **Literal handling** — when a line ends with `{size}`, read exactly `size`
  raw bytes followed by `\r\n`.
- **Simple regex matching** — extract UIDs from `* SEARCH`, extract message
  metadata from `* N FETCH (...)`, extract EXISTS/RECENT/UIDVALIDITY/etc.
  from SELECT responses.

`ImapReader` does exactly this in ~80 lines.  It maintains a single buffer,
looks for `\r\n` delimiters, and switches between line mode and literal mode
as dictated by `{size}` markers.  No parser generator, no recursive descent,
no intermediate AST.

## UID-only operations

The old API had a `seq` namespace for sequence-number-based operations
alongside the default UID-based methods.  Sequence numbers are fragile
(they change when messages are expunged) and are only useful for
mailbox-relative operations like "fetch the last N messages."

The new module uses UIDs exclusively.  If you need "the last message", do
`search(["ALL"])` and take the last UID.  This keeps the API surface small
and avoids the footgun of confusing UIDs with sequence numbers.

## Push events — IDLE support (Batch 3, in progress)

IDLE is the single most impactful missing feature: it enables real-time
notification of new mail without polling.  A detailed race-condition analysis
lives in `docs/idle-races.md`.

**Batch 3a (prerequisites) is complete** — four of five blockers are done:

1. ✅ **`+` continuation handling** — `ImapReader` detects `+` lines and
   routes them to `onContinue`.  `Connection` exposes
   `sendCommandWithContinuation()` for IDLE/APPEND.
2. ✅ **Socket error propagation** — `#failAllPending()` rejects all
   outstanding promises on socket `"close"` or `"error"`.  The mock server
   destroys the socket on unexpected commands rather than throwing.
3. ✅ **`fetch()` concurrency guard** — `fetch()` throws if another fetch
   is already in-flight.
4. ✅ **`#onLiteral` / `#handleFetchLine` safety** — `#handleFetchLine`
   returns early when no `#fetchResolve` is set, preventing unsolicited
   FETCH responses from leaking into fetch state.
5. **Post-DONE drain** — deferred to the `idle()` implementation itself:
   the iterator will continue yielding events after `DONE` is sent until
   the tagged OK arrives.

The `idle()` method will return an `AsyncIterator<IdleEvent>` as described
in the roadmap.

## CAPABILITY negotiation

`connect()` sends `CAPABILITY` after LOGIN and populates `capabilities:
Set<string>`.  `serverSupports(cap)` provides case-insensitive lookups.
`openBox()` gates on `IMAP4REV1` when capabilities are known (gracefully
skips the check if the server didn't respond to CAPABILITY).

Future features (`MOVE`, `IDLE`, `CONDSTORE`) should gate on their
respective capabilities.  The Capability detection was added in Batch 2.

## Authentication: password only

The old module supported `xoauth` and `xoauth2` as well as password auth.
The new module only implements `LOGIN` with username/password.  The project
uses a plain password, so this is sufficient.  OAuth can be added as a
constructor option later.

## Fetch options: bodies only

The old `FetchOptions` supported `struct`, `envelope`, `size`, `modifiers`,
`extensions`, `markSeen`, etc.  We only implement `bodies` because the
project only ever requests `BODY.PEEK[]` (the full RFC822 message).
`flags` are parsed from the FETCH response directly via regex.

## Search criteria: nested-array API

The old module had a full search query builder (`buildSearchQuery`) that
handled nested `OR` groups, charset detection for UTF-8 strings, and literal
encoding for non-ASCII characters.  Our `buildSearchQuery` handles the
criteria the project uses (`UNSEEN`, `ALL`) plus string, numeric, and UID
criteria via a **nested-array format**:

```ts
// bare keyword
conn.search(["UNSEEN"])

// keyword with argument
conn.search([["FROM", "alice@example.com"], "UNSEEN"])

// two-argument form (HEADER)
conn.search([["HEADER", "X-Custom", "yes"]])
```

Flat arrays like `["FROM", "alice@example.com", "UNSEEN"]` are not
supported — callers must wrap criteria-with-arguments in their own array.
Charset detection and nested `OR` groups can be added when needed.

## Error handling philosophy

- **Connection errors** (TLS handshake failure, socket timeout) reject the
  `connect()` promise.
- **Protocol errors** (tagged NO/BAD responses) reject the command promise
  with the server's error text.
- **Timeouts** — `connTimeout`, `authTimeout`, and `commandTimeout` reject
  with descriptive messages.
- **Socket close/error propagation** — when the socket closes or errors,
  all outstanding `sendCommand` promises are rejected immediately via
  `#failAllPending()`.  Added in Batch 3a (fixes `untested.md` #7 and
  `idle-races.md` #10).
- **Untagged BYE** is not yet handled — the socket will emit `"close"` but
  no promise is rejected.  The next command will fail.  Tracked as a
  medium-risk concern in `docs/untested.md` (#6).
- **`fetch()` never rejects** on protocol errors — if the server returns
  fewer results than requested, the caller gets what was returned.  This
  matches the old `node-imap` behaviour where non-existent UIDs silently
  produce no results.
- **Concurrent `fetch()` calls** now throw rather than corrupting internal
  state.  Added in Batch 3a (fixes `idle-races.md` #7).

## Module structure

```
vendored/imap-connector/
├── package.json            workspace package, no runtime deps
├── index.ts                barrel re-export
├── connection.ts           ImapReader (line/literal framing) + Connection (async API)
├── mock.ts                 scenario-based mock IMAP server
├── connection.test.ts      37 unit tests + 2 todo (vitest, ~2.3s)
├── test-integration.ts     integration test against real server
└── docs/
    ├── design.md           this file
    ├── roadmap.md          phased feature plan (batches 1-8)
    ├── untested.md         catalogue of untested behaviours with risk assessments
    └── idle-races.md       race condition analysis for IDLE (prerequisites done)
```

## What the module is not

- **Not a general-purpose IMAP client.**  It does mailbox polling, not
  message composition.  It does UID-based operations, not sequence numbers.
  Push support (IDLE) is planned but not yet implemented.

- **Not a replacement for `imap-module`'s full API.**  It covers the ~15% of
  the API that the project uses (polling + robustness).  The remaining 85%
  (mailbox CRUD, COPY/MOVE, APPEND, IDLE, SORT, THREAD, quota, Gmail
  extensions, etc.) is tracked in the roadmap.

- **Not a streaming parser.**  `BODY.PEEK[]` returns the entire message as a
  single string.  For large messages with attachments, this could be
  memory-intensive.  A streaming fetch could be added via an
  `AsyncIterator<Buffer>` return type if needed.

- **Not a multi-body-part fetch parser.**  The current regex-based fetch
  handler only processes the first `BODY[...]` literal on each `* N FETCH`
  line.  Responses with multiple body parts on continuation lines require a
  proper FETCH response parser (tracked as a `todo` test).

- **Documented limitations.**  `docs/untested.md` catalogues 12 untested
  behaviours with risk assessments.  `docs/idle-races.md` analyses 12 race
  conditions for the planned IDLE feature.
