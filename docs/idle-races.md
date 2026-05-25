# IDLE race conditions — imap-connector

This document analyses every race condition that can arise when implementing
the `idle()` and `watch()` methods described in Batch 3 of the roadmap.  The
analysis assumes the current architecture: a single-threaded Node.js event
loop, one `ImapReader` per connection that serialises all server data through
`#dispatchLine`, and promise-based commands that feed into a shared `#pending`
map.

---

## 1. DONE sent before IDLE continuation arrives

**Scenario.**  The client sends `IDLE\r\n`.  Before the server responds with
`+ idling`, the client decides to exit IDLE (e.g. a timeout fires, or the
caller breaks out of the `for await` loop).  The client sends `DONE\r\n`.
The server now receives `IDLE\r\nDONE\r\n` as a single pipeline.

**What happens.**  IMAP servers handle pipelined `IDLE` + `DONE` correctly:
they enter IDLE, immediately see the `DONE`, and respond with a tagged OK for
the IDLE command.  No untagged updates are sent.

**Risk.**  Low.  The IDLE promise resolves with an empty update set.  The
caller receives no events and the iterator ends cleanly.  This is valid
behaviour.

**Mitigation.**  Track an `#idleState` enum: `entering`, `idling`, `done`.
If `DONE` is sent before `+` arrives, queue it until `+` is received, then
send immediately.  This avoids sending `IDLE\r\nDONE\r\n` and instead sends
`IDLE\r\n` ... wait for `+` ... `DONE\r\n`.

---

## 2. Untagged update arrives after DONE is sent but before tagged OK

**Scenario.**  The client is in IDLE.  The server sends `* 5 EXISTS`.  At the
same moment, the caller breaks out of the `for await` loop.  The client sends
`DONE\r\n`.  Between sending `DONE` and receiving the tagged OK for the IDLE
command, the server sends another untagged response: `* 6 EXISTS`.

**What happens in IMAP.**  The server processes `DONE`, exits IDLE, and sends
the tagged OK.  The `* 6 EXISTS` was sent before the server processed `DONE`,
so it arrives before the tagged OK.  Both untagged responses (`* 5 EXISTS`
and `* 6 EXISTS`) are valid IDLE events that should be yielded to the caller.

**What happens in the current architecture.**  `#dispatchLine` processes lines
in order.  `* 5 EXISTS` is untagged, goes to `#handleUntagged`.  `* 6 EXISTS`
is untagged, goes to `#handleUntagged`.  Then the tagged OK for IDLE arrives.
If the IDLE iterator has already been "closed" by the caller (the `return()`
method was called), these events may be yielded after the loop has exited.

**Risk.**  **Medium.**  Events can be dropped if the iterator's `return()`
resolves the underlying promise before all buffered lines are processed.

**Mitigation.**  The IDLE iterator should drain all remaining untagged lines
after sending `DONE` and before resolving the `return()` promise.  The tagged
OK for IDLE is the signal that no more untagged responses will arrive for
this IDLE session.  The flow should be:

1. Caller calls `return()`.
2. Client sends `DONE`.
3. Client continues processing untagged lines, yielding events.
4. Tagged OK for IDLE arrives.
5. Iterator resolves `{ done: true }`.

---

## 3. IDLE tagged OK conflicts with a concurrent command's pending entry

**Scenario.**  The caller exits IDLE (`DONE` sent).  Before the tagged OK for
IDLE arrives, the caller issues a new command (e.g. `FETCH`).  The new
command gets tag `A0005`.  The IDLE tagged OK arrives for tag `A0004`.

**What happens.**  `#dispatchLine` dispatches by tag.  `A0004 OK` resolves the
IDLE promise (which was registered in `#pending` when IDLE was entered).
`A0005 OK` resolves the FETCH promise.  No conflict.

**Risk.**  Low *if* IDLE enters its tag into `#pending` like any other
command.  If IDLE uses a custom promise mechanism (bypassing `sendCommand`),
the tagged OK would be unmatched and silently ignored, causing the iterator
to hang.

**Mitigation.**  IDLE MUST reuse `sendCommand` for both `IDLE` and the
implicit `DONE` completion.  The `sendCommand("IDLE")` promise resolves only
when the tagged OK arrives, which is after `DONE` is sent and the server
acknowledges.  This naturally sequences exit from IDLE.

---

## 4. Re-entering IDLE before the previous IDLE tagged OK arrives

**Scenario.**  The caller quickly exits and re-enters IDLE:

```
iterator.return()    → sends DONE
idle()               → sends IDLE
```

Now the wire has: `DONE\r\nIDLE\r\n`.  The server receives `DONE`, exits
IDLE, sends tagged OK for the first IDLE command.  Then receives `IDLE`,
enters IDLE, sends `+ idling`.

**What happens.**  The first IDLE's tagged OK resolves its `sendCommand`
promise.  The second `sendCommand("IDLE")` is waiting for its tagged OK.
But the server sent `+ idling` (a continuation), not a tagged OK.  The
continuation `+` is not a tagged response — it doesn't match `RE_TAGGED`.

**The `+` continuation is not handled by the current `#dispatchLine`.**  It
would be pushed to `#untagged` and ignored.  The second IDLE's
`sendCommand` promise would hang forever (until command timeout).

**Risk.**  **High.**  The `+` continuation is a fundamental IMAP protocol
element that the current line dispatcher does not handle.  It must be added
for IDLE to work at all.

**Mitigation.**  `#dispatchLine` must detect lines starting with `+` and route
them to a dedicated `#continuationCallback`.  During IDLE, this callback
resolves the "entering IDLE" sub-promise.  Both `IDLE` and `APPEND` use
continuations, so this is a general protocol requirement.

---

## 5. Unsolicited untagged responses during non-IDLE commands

**Scenario.**  The client sends `FETCH 1 (BODY.PEEK[])` and while waiting for
the response, the server sends `* 6 EXISTS` (a new message arrived in the
mailbox).  This is a legal IMAP behaviour: servers may send untagged EXISTS,
RECENT, EXPUNGE, and FETCH at any time.

**What happens.**  `#dispatchLine` receives `* 6 EXISTS`.  It's pushed to
`#untagged` and sent to `#handleUntagged`.  `#handleUntagged` updates
`#mailboxInfo.total`.  Then the FETCH response arrives.  The FETCH promise
resolves.  The `#untagged` array (which is cleared at the start of
`sendCommand`) includes `* 6 EXISTS`.  The caller receives the FETCH result
plus `* 6 EXISTS` in the untagged lines array.

**Risk when combined with IDLE.**  Low for the polling case.  But with IDLE,
these unsolicited updates are exactly the events we want to surface.  The
problem is that during an IDLE session, there is no `sendCommand` to clear
`#untagged`.  Unsolicited responses accumulate in `#untagged` indefinitely.

**Mitigation.**  The IDLE iterator should NOT rely on `#untagged`.  It should
hook directly into `#dispatchLine` (or a dedicated event emitter) to receive
untagged lines as they arrive, rather than collecting them.

---

## 6. EXPUNGE during a pending FETCH

**Scenario.**  The client sends `UID FETCH 1,2,3 (BODY.PEEK[])`.  Before the
FETCH completes, the server sends `* 2 EXPUNGE` (message 2 was deleted by
another client).  The server then sends FETCH responses for messages 1 and 3
only.  The client requested 3 messages but receives 2.

**What happens.**  The current `#handleFetchLine` does not track how many
FETCH responses are expected — it just collects them as they arrive.
`#maybeFinishFetch` resolves when `#fetchPending` hits 0 and the
`#fetchQueue` is empty.  This works correctly: the client gets 2 messages.
The `* 2 EXPUNGE` line is pushed to `#untagged` and processed by
`#handleUntagged` (which decrements `#mailboxInfo.total` via the `EXISTS`
update that typically follows an EXPUNGE).

**Risk.**  **Low for correctness, medium for debuggability.**  The caller
doesn't know that message 2 was expunged.  The returned array has messages
for UIDs 1 and 3, which is correct, but there's no notification of the
EXPUNGE.

**Mitigation.**  The `FetchedMessage` result set should not attempt to track
expected-vs-actual counts.  If the caller needs to know about EXPUNGEs, they
should use IDLE.

---

## 7. `#fetchResolve` overwritten by concurrent fetch

**Scenario.**  The caller calls `fetch([1,2])` and then, before the first
fetch resolves, calls `fetch([3,4])`.  The second call overwrites
`#fetchResults`, `#fetchPending`, `#fetchQueue`, and `#fetchResolve`.

**What happens.**  The first fetch's results are lost.  The first fetch's
promise never resolves (its `#fetchResolve` was replaced).  The second fetch
receives the combined results of both commands (the server pipelines them
and responds to both FETCH commands in order, but `#handleFetchLine` doesn't
know which FETCH command a response belongs to).

**Risk.**  **Medium.**  The current polling loop in `server.ts` never
overlaps commands, but a future IDLE-aware loop might.  The fix is to include
a tag in the fetch state and match FETCH responses to their originating
command.

**Mitigation.**  Either (a) throw if `fetch()` is called while another fetch
is in-flight, or (b) maintain per-tag fetch state in a `Map` keyed by the
FETCH command tag.  Option (a) is simpler and sufficient for single-consumer
usage.

---

## 8. `#mailboxInfo` updated by IDLE unsolicited responses during a command

**Scenario.**  The client exits IDLE and immediately calls `openBox("INBOX")`.
The IDLE session's final untagged responses (EXISTS, RECENT) are still in
`#untagged` when `openBox`'s `sendCommand("SELECT ...")` clears it.

**What happens.**  The IDLE session's updates are lost.  `openBox` sees a
clean slate.

**Risk.**  **Low.**  `openBox` re-fetches the mailbox state from the SELECT
response, so lost untagged updates are harmless.  However, if the caller
tracks `#mailboxInfo` between IDLE sessions without calling `openBox`, the
unsolicited EXISTS/RECENT updates from IDLE are the *only* source of truth,
and they could be lost if a command clears `#untagged`.

**Mitigation.**  `#handleUntagged` should update `#mailboxInfo` immediately
when an untagged line arrives, regardless of whether a command is pending.
This already happens.  The `#untagged` array is only used by `sendCommand`
to return accumulated lines to the command's caller.  The `#mailboxInfo`
object is mutated in-place and survives `#untagged` clearing.

---

## 9. ImapReader line/literal processing during IDLE

**Scenario.**  During IDLE, the server sends a FETCH response with a literal:
`* 3 FETCH (FLAGS (\Seen) BODY[] {5}\r\nhello`.  The `ImapReader` sees `{5}`
and switches to literal mode.  It consumes 5 bytes, then expects `\r\n`.

**What happens.**  If the caller is iterating IDLE events, the literal data
(`hello`) is consumed by the reader and delivered to `#onLiteral`.  But
`#onLiteral` is designed for explicit FETCH commands — it shifts from
`#fetchQueue`.  During IDLE, `#fetchQueue` is empty, so the literal data is
dropped silently.  The next line after the literal resumes normal line
processing.

**Risk.**  **Medium.**  Unsolicited FETCH responses with body parts (rare,
but possible with CONDSTORE or NOTIFY extensions) would corrupt the reader
state.  The `#fetchQueue.shift()` returning `undefined` means the literal is
swallowed, and the next line is processed correctly, so the impact is limited
to dropped data.

**Mitigation.**  `#onLiteral` should check if `#fetchQueue` is non-empty.  If
empty (IDLE mode), emit the literal data as an IDLE event of type `"fetch"`.

---

## 10. Socket close during IDLE

**Scenario.**  The server closes the connection while the client is in IDLE.
The `ImapReader`'s socket emits `"close"`.  The IDLE iterator is awaiting
the next event.

**What happens.**  The IDLE `sendCommand("IDLE")` promise never resolves (no
tagged OK arrives).  The iterator hangs until command timeout.  The caller
never learns about the disconnection.

**Risk.**  **High.**  A silent hang in the IDLE loop is the worst failure
mode.  The caller's `for await` loop blocks forever.

**Mitigation.**  Listen for socket `"close"` and `"error"` events.  When the
socket closes during IDLE, reject the IDLE promise (or yield a special
`{ type: "disconnected" }` sentinel event and then `{ done: true }`).  This
allows the caller to reconnect.

The `watch()` convenience method in the roadmap handles this by transparently
reconnecting, but it still needs the underlying `idle()` to signal
disconnection rather than hang.

---

## 11. `watch()` reconnection races with server state

**Scenario.**  `watch()` calls `idle()`.  The socket disconnects.  `watch()`
reconnects, calls `openBox("INBOX")`, then calls `idle()` again.  Between
`openBox` and the second `idle()`, a new message arrives.

**What happens.**  The new message triggers an EXISTS update from the server
during the `SELECT` (EXAMINE) response, which `openBox` returns in
`MailboxInfo`.  The caller sees the updated message count.  But the message
itself is not fetched — it's just a count.  The caller would need to
`search(["UNSEEN"])` + `fetch()` after every reconnect to catch up.

**Risk.**  **Low for correctness, medium for latency.**  The caller misses
the message content until the next explicit fetch.  This is inherent to
polling-based architectures — `watch()` just automates the reconnect.

**Mitigation.**  `watch()` should accept a callback or emit an event that
signals reconnection happened, so the caller can re-fetch unseen messages.
Alternatively, `watch()` could return not just `IdleEvent` but also a
`{ type: "reconnected", mailbox: MailboxInfo }` event.

---

## 12. DONE not sent if the process crashes

**Scenario.**  The Node.js process exits while in IDLE (e.g. uncaught
exception, SIGTERM).  `DONE` is never sent.

**What happens.**  The server keeps the connection in IDLE state until a
TCP keepalive or server-side timeout fires.  No data loss — the server
simply waits.  On reconnect, the client authenticates and continues.

**Risk.**  **Very low.**  IMAP servers handle this gracefully.  The worst
case is a stale connection consuming a server slot for a few minutes.

**Mitigation.**  Register a `process.on("exit")` or `process.on("SIGTERM")`
handler that sends `DONE` and `LOGOUT`.  This is a nice-to-have, not
required for correctness.

---

## Summary

| # | Race condition | Risk | Status |
|---|---|---|---|
| 1 | DONE before `+` arrives | Low | No fix needed (pipelining is fine) |
| 2 | Events after DONE, before tagged OK | Medium | **Deferred to IDLE impl** (post-DONE drain) |
| 3 | Tag conflict between IDLE and next command | Low | No fix needed (tags are unique) |
| 4 | `+` continuation not handled | — | ✅ **Fixed** (Batch 3a) — `onContinue` callback |
| 5 | Unsolicited untagged during non-IDLE | Low | No fix needed |
| 6 | EXPUNGE during FETCH | Low | No fix needed |
| 7 | Concurrent fetch overwrite | — | ✅ **Fixed** (Batch 3a) — `fetch()` throws if in-flight |
| 8 | IDLE updates lost when command clears #untagged | Low | No fix needed (#mailboxInfo is mutated in-place) |
| 9 | Literal during IDLE with no fetchQueue | — | ✅ **Fixed** (Batch 3a) — `#handleFetchLine` guards on `#fetchResolve` |
| 10 | Socket close during IDLE | — | ✅ **Fixed** (Batch 3a) — `#failAllPending` propagates to all promises |
| 11 | watch() reconnect gap | Low | Nice-to-have |
| 12 | DONE not sent on crash | Very low | Nice-to-have |

**Prerequisites before implementing IDLE:**

1. ✅ `+` continuation handling — `ImapReader.onContinue` + `Connection.sendCommandWithContinuation()` (race #4).
2. ✅ Socket `"close"` / `"error"` propagation — `#failAllPending()` rejects all outstanding promises (race #10, also fixes `untested.md` #7).
3. ✅ Guard `fetch()` against concurrent calls — throws if `#fetchResolve` is already set (race #7).
4. ✅ Make `#onLiteral` / `#handleFetchLine` safe — `#handleFetchLine` returns early when no fetch is in progress (race #9).
5. **Post-DONE drain** — the IDLE iterator must continue yielding untagged lines after `DONE` is sent until the tagged OK arrives (race #2).  This is the sole remaining blocker and will be addressed during the `idle()` implementation itself (Batch 3b).