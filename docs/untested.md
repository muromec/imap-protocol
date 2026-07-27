# Untested concerns — imap-connector

This document catalogues every behaviour in `connection.ts` that is **not**
covered by the current unit-test suite (`connection.test.ts`) or the
integration smoke test (`test-integration.ts`).  Each item includes a
judgement on what bugs could slip through as a result.

---

## 1. STARTTLS upgrade (happy path)

**What is untested.**  The `autotls: "always"` path sends `STARTTLS`, receives
`OK`, then calls `tls.connect({ socket: rawSocket })` to upgrade the plain
TCP connection to TLS.  The mock server speaks plain TCP and cannot complete
a TLS handshake.

**Risk.**  **Medium.**  The code path from receiving the `STARTTLS` tagged OK
through to `tls.connect()` is exercised only by inspection.  Bugs that could
hide here:

- The raw socket is not correctly passed to `tls.connect()` (type mismatch).
- The upgraded `ImapReader` instance is attached to the wrong socket.
- The `doLogin()` call after upgrade sends credentials over the plain socket
  instead of the TLS socket.
- `tlsOptions` are not forwarded to the upgrade `tls.connect()` call.

**Mitigation.**  This path is exercised every time the real server is used
with `autotls` (but the project currently uses implicit TLS on port 993, so
STARTTLS is never triggered in production).

---

## 2. Connection timeout on implicit TLS

**What is untested.**  `connTimeout` is tested against an unroutable address
(TEST-NET-1) with plain TCP.  The same timeout on a TLS socket
(`tls.connect()`) is not tested — TLS handshakes have different failure
modes (certificate errors, protocol version mismatches, hang during
handshake).

**Risk.**  **Low.**  The `setTimeout` / `clearTimeout` logic is shared
between both paths.  A bug would require the TLS handshake to suppress the
`"connect"` event while also not emitting `"error"`, which is unlikely in
practice.

---

## 3. Per-command timeout (non-auth)

**What is untested.**  The `commandTimeout` fires when a command other than
LOGIN does not receive a tagged response.  The current test only exercises
`authTimeout` (LOGIN).  There is no test for, e.g., a `SELECT` or `SEARCH`
that hangs.

**Risk.**  **Low.**  The mechanism (`setTimeout` in `sendCommand`,
`clearTimeout` in `#dispatchLine`, socket reset on expiry) is the same for
all commands.  A targeted test would be redundant with the auth-timeout
test.

---

## 4. TLS options passthrough

**What is untested.**  `tlsOptions` is merged into the `tls.connect()` call
for both implicit TLS and STARTTLS upgrades.  No test verifies that custom
options (e.g. `rejectUnauthorized: false`, `ca`, `cert`, `key`) reach
`tls.connect()`.

**Risk.**  **Low.**  This is a single `...spread` expression.  A regression
would require removing or misspelling the spread, which TypeScript would
catch (unknown properties on `ConnectionOptions`).

---

## 5. PREAUTH greeting ✅ FIXED

**What changed.** Greeting detection now reports whether the server sent
`* PREAUTH`. `connect()` skips LOGIN in that case and proceeds to
CAPABILITY discovery. A mock-server test verifies that LOGIN is not sent.

**Remaining risk.** **Low.** STARTTLS after PREAUTH is not a meaningful
combination in the current handshake and remains outside the test matrix.

---

## 6. Untagged BYE during a command ✅ FIXED

**What changed.** The dispatcher recognizes an untagged `* BYE`, forwards
the line to the session callback, marks the connection dead, and rejects
all pending commands with the BYE text. A mock-server regression test
covers a BYE without waiting for the socket to close.

**Remaining risk.** **Low.** The server may leave the TCP socket open, but
the dispatcher rejects new commands immediately after it becomes dead.

---

## 7. Socket error mid-command ✅ FIXED (Batch 3a)

**What was untested.**  Socket `"close"` and `"error"` events were not
propagated to pending promises.  Commands would hang until timeout (30 s).

**What changed.**  `#failAllPending(err)` rejects all outstanding
`sendCommand` promises and resolves any in-flight `fetch()` when the
socket closes or errors.  Wired into both implicit-TLS and STARTTLS
upgrade paths.  Tested in `connection.test.ts` (socket error propagation).

**Risk.**  Resolved.

---

## 8. Multiple concurrent commands

**What is untested.**  IMAP allows pipelining — sending multiple commands
before waiting for responses.  The `#pending` map supports multiple
outstanding tags, and `#dispatchLine` dispatches by tag.  But no test sends
two commands concurrently (other than CAPABILITY during `connect()`).

**Risk.**  **Low for current usage.**  The project never pipelines commands
(`server.ts` awaits each call).  `fetch()` now throws if called concurrently
(Batch 3a), which prevents the most dangerous overlap.  The `#untagged`
array is cleared in `sendCommand`, so general-purpose pipelining would still
cause untagged responses from one command to leak into another.  If
pipelining is needed, `#untagged` should be keyed by tag in a `Map`.

---

## 9. CAPABILITY response with multiple lines

**What is untested.**  Some servers send capabilities across multiple
`* CAPABILITY ...` lines.  The current code joins them all into the
`capabilities` set, but no test verifies deduplication or multi-line
parsing.

**Risk.**  **Low.**  Multi-line CAPABILITY responses are rare in practice.
If they occur, the code handles them correctly (each line is parsed
independently).

---

## 10. Fetch with inline body (no literal)

**What is untested.**  Short message bodies may be returned inline (without
`{size}` literal syntax) as `BODY[] {data}` directly in the fetch line.
The `#handleFetchLine` code has an `else` branch for this, but no test
covers it.

**Risk.**  **Low.**  Modern servers use literals for all but the smallest
bodies.  If an inline body is returned, it is parsed via a regex that
captures everything after `BODY[...] ` — which may include trailing
parentheses from later fetch attributes.

---

## 11. FETCH response with MODSEQ / X-GM-* extensions

**What is untested.**  The code does not request `MODSEQ` or Gmail
extensions, but servers may send them unsolicited.  The regex-based fetch
parser may misparse lines containing these extra attributes.

**Risk.**  **Low for current usage.**  The project only requests
`UID FLAGS BODY.PEEK[]`.  If a server adds unsolicited attributes, they
appear after `FLAGS` and before `BODY[]`, potentially breaking the regex.

---

## 12. `search()` with SEARCH response that has MODSEQ ✅ FIXED

**What changed.** `search()` strips a trailing `(MODSEQ number)`
decoration before parsing UID tokens. A mock-server test covers the
decorated response.

**Remaining risk.** **Low.** ESEARCH and other response forms remain
separate protocol features rather than being accepted by this parser.

---

## 13. `IdleEvent` types and `idle()` / `watch()` methods

**What is untested.**  These are part of Batch 3 in the roadmap and not yet
implemented.  No risk assessment applies.

---

## Summary

| # | Concern | Risk | Status |
|---|---|---|---|
| 1 | STARTTLS happy path | Medium | todo (needs TLS-capable mock) |
| 2 | connTimeout on TLS | Low | Untested |
| 3 | Per-command timeout | Low | Shared mechanism |
| 4 | TLS options passthrough | Low | TypeScript-guarded |
| 5 | PREAUTH greeting | Low | ✅ Fixed and tested |
| 6 | Untagged BYE mid-command | Low | ✅ Fixed and tested |
| 7 | Socket error mid-command | — | ✅ Fixed (Batch 3a) |
| 8 | Concurrent commands | Low | Guarded for fetch (Batch 3a) |
| 9 | Multi-line CAPABILITY | Low | Rare |
| 10 | Inline body fetch | Low | Rare |
| 11 | Unsolicited MODSEQ/Gmail | Low | Not requested |
| 12 | SEARCH with MODSEQ | Low | ✅ Fixed and tested |

**Overall judgement.**  The test suite provides
good coverage of the happy-path polling loop (`connect` → `openBox` →
`search` → `fetch` → `addFlags` → `close`) plus connection robustness
(timeouts, capability detection, STARTTLS gating, PREAUTH, BYE, and
CONDSTORE SEARCH decoration). **STARTTLS happy path** (item 1) remains
untestable without a TLS-capable mock server but is not exercised in production
(KPN uses implicit TLS on port 993).
