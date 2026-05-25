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
over a `node:tls` socket.  This means:

- No dependency on `imap-module` or any other IMAP library.
- No dependency on a streaming MIME parser — we return the raw RFC822 body
  and let the caller decide how to parse it (the project already uses
  `postal-mime` for that).
- The only external API surface is `node:tls`.

## Why a custom line/literal reader instead of a full IMAP parser

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

## No push events (IDLE, mailbox updates)

The old module emitted `"mail"`, `"expunge"`, and `"update"` events when the
server sent unsolicited untagged responses.  These require a persistent
connection with an event loop, which fundamentally conflicts with a
request/response promise model.

The new module is **polling-only**.  The caller runs a loop: open inbox,
search unseen, fetch, process, sleep, repeat.  This matches the project's
existing architecture (`server.ts` uses `setTimeout` + `pullInbox`) and
keeps the connection logic stateless between operations.

If push is needed later, it can be added as a separate `idle()` method that
returns an `AsyncIterator<UpdateEvent>`.

## No CAPABILITY negotiation

The old module tracked server capabilities via the `CAPABILITY` command and
exposed `serverSupports()`.  The new module does not negotiate capabilities.
It assumes a reasonably modern IMAP server that supports:

- `UID SEARCH`
- `UID FETCH`
- `UID STORE`
- Literal syntax `{size}`

These are universal on any server from the last 20 years.  If a specific
extension is needed (CONDSTORE, MOVE, etc.), capability detection can be
added to `connect()` and the relevant methods gated behind it.

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

## Search criteria: flat string builder

The old module had a full search query builder (`buildSearchQuery`) that
handled nested `OR` groups, charset detection for UTF-8 strings, and literal
encoding for non-ASCII characters.  Our `buildSearchQuery` is a simplified
version that handles the criteria the project uses (`UNSEEN`, `ALL`) plus a
few common ones.  It does not do charset detection or nested OR — those can
be added when needed.

## Error handling philosophy

- **Connection errors** (TLS handshake failure, socket timeout) reject the
  `connect()` promise.
- **Protocol errors** (tagged NO/BAD responses) reject the command promise
  with the server's error text.
- **Untagged BYE** is not yet handled — the socket will emit `"close"` but
  no promise is rejected.  The next command will fail.
- **`fetch()` never rejects** on protocol errors — if the server returns
  fewer results than requested, the caller gets what was returned.  This
  matches the old `node-imap` behaviour where non-existent UIDs silently
  produce no results.

## What the module is not

- **Not a general-purpose IMAP client.**  It does mailbox management, not
  message composition.  It does UID-based operations, not sequence numbers.
  It polls, it doesn't push.

- **Not a replacement for `imap-module`'s full API.**  It covers the ~10% of
  the API that the project actually uses.  The remaining 90% (mailbox CRUD,
  COPY/MOVE, APPEND, IDLE, SORT, THREAD, quota, Gmail extensions, etc.) is
  deliberately omitted.

- **Not a streaming parser.**  `BODY.PEEK[]` returns the entire message as a
  single string.  For large messages with attachments, this could be
  memory-intensive.  A streaming fetch could be added via an
  `AsyncIterator<Buffer>` return type if needed.