# Architecture — imap-connector

Current `connection.ts` is ~930 lines with collapsed concerns: socket I/O,
IMAP command dispatch, and session state all share the same class.  This
document describes a three-layer decomposition that separates those
concerns without changing the public API.

Tests (`connection.test.ts`, 47 + 2 todo) pass against the public API and
will continue to pass throughout the refactor.

---

## Layer 1 — Transport

**File:** `transport.ts`

**Responsibility:** turn a raw TCP stream into framed IMAP lines and back.
This is the only layer that knows about `\r\n`, `{size}` literals, `+`
continuations, and raw socket reads/writes.

### State

- `socket: Socket` — the underlying TCP/TLS socket.
- `buf`, `literalRemaining`, `literalChunks` — line/literal framing buffer
  (moved from `ImapReader`).
- `debugEnabled: boolean` — toggled via `setDebug()`.
- `dead: boolean` — true after socket close or error.

### Public interface

```
class Transport {
  constructor(socket: Socket, debug?: boolean)

  // Outbound
  send(raw: string): void          // write raw bytes (no CRLF added)

  // Inbound callbacks — each can be set once, replaces previous
  onLine(cb: (line: string) => void): void
  onLiteral(cb: (data: string) => void): void
  onContinue(cb: (line: string) => void): void
  onClose(cb: () => void): void
  onError(cb: (err: Error) => void): void

  // Raw-read hook for debug logging
  onRawRead(cb: ((raw: string) => void) | null): void

  // Lifecycle
  close(): void
  setDebug(enabled: boolean): void

  // Query
  get dead(): boolean
}
```

### What it does NOT know about

- Tags (A0001, A0002).
- OK / NO / BAD status.
- Any IMAP command or response meaning.
- That `+ idling` means "entering IDLE".

### Implementation notes

- Extracted directly from `ImapReader` (lines 92–205) plus `debugSocket`
  (lines 83–90) plus the socket lifecycle from `connect()` (lines 466–475,
  the `onReady` socket setup) plus the `"close"` / `"error"` handlers
  (lines 343–352, 423–443).
- `onClose` and `onError` callbacks are set by the Command layer to
  trigger `#failAllPending`.  Transport itself has no concept of pending
  commands — it just signals that the socket is gone.

---

## Layer 2 — CommandDispatcher

**File:** `dispatch.ts`

**Responsibility:** pair tagged commands with their responses.  Sends a
command with a unique tag, collects untagged lines that arrive before the
matching tagged OK/NO/BAD, and resolves (or rejects) the per-command
promise.  Also handles per-command timeouts.

### State

- `transport: Transport` — the transport to send on and receive lines from.
- `#tag: number` — auto-incrementing tag counter.
- `#pending: Map<tag, { resolve, reject, timer }>` — outstanding commands.
- `#untagged: string[]` — lines accumulated since the current command
  started (reset per command).

### Public interface

```
class CommandDispatcher {
  constructor(transport: Transport, defaultTimeout: number)

  // Send a tagged command.  Returns untagged lines on OK.
  sendCommand(cmd: string): Promise<string[]>

  // Send a command that expects a + continuation before the tagged
  // response.  Returns the continuation line.
  sendCommandWithContinuation(cmd: string): Promise<string>

  // Passthrough: lines the session layer should see that aren't
  // consumed by a pending command (unsolicited untagged, idle events).
  onUntagged(cb: (line: string) => void): void

  // Called by Transport when the socket closes.  Rejects all pending
  // promises and fires onDead.
  onDead(cb: () => void): void

  // Query
  get dead(): boolean
}
```

### What it does NOT know about

- LOGIN, SELECT, FETCH, IDLE semantics.
- Mailbox state (EXISTS, RECENT, UIDVALIDITY).
- Fetch result parsing.
- Capabilities.

### Implementation notes

- `sendCommand` and `sendCommandWithContinuation` move from `Connection`
  (lines 284–298 and 513–518).
- `#dispatchLine` (lines 522–553) becomes `dispatcher._onLine`.  Tagged
  responses are matched against `#pending`; untagged lines are forwarded
  to the session via the `onUntagged` callback.
- The `onDead` callback replaces the current pattern where `#failAllPending`
  directly manipulates `#idleHook` / `#idleEventResolve` / `#idleDrainResolve`
  — those belong in the Session layer.
- Transport's `onClose` / `onError` handlers call `dispatcher._onTransportDead()`.
- `CommandDispatcher.dead` mirrors `Transport.dead`.

---

## Layer 3 — ImapSession (public API)

**File:** `connection.ts` (renamed internal class, same public name)

**Responsibility:** IMAP protocol semantics.  Uses `CommandDispatcher` to
execute IMAP operations and interprets the responses.  This is the public
`Connection` class.

### State (moved out of Connection)

- `#dispatcher: CommandDispatcher` — how it talks to the server.
- `#mailboxInfo: MailboxInfo`
- `capabilities: Set<string>`
- `#fetchResolve`, `#fetchResults`, `#fetchPending`, `#fetchQueue`
- `#idleHook`, `#idleEventResolve`, `#idleDrainResolve`
- `#continuationResolve`

### Public interface (unchanged)

```
class Connection {
  constructor(config: ImapConfig)
  connect(): Promise<void>
  close(): Promise<void>
  openBox(name, readOnly?): Promise<MailboxInfo>
  search(criteria): Promise<number[]>
  fetch(uids, opts?): Promise<FetchedMessage[]>
  addFlags(uids, flags): Promise<void>
  fetchUnseen(): Promise<FetchedMessage[]>
  idle(): AsyncIterable<IdleEvent>
  serverSupports(cap): boolean
  get dead(): boolean
  setDebug(enabled): void
  sendCommand(cmd): Promise<string[]>       // kept for watcher
  sendCommandWithContinuation(cmd): Promise<string>  // kept for idle
}
```

### What it does NOT know about

- Socket lifecycle, line framing, literal handling.
- Tag counters, `#pending` map, per-command timeout timers.

### Implementation notes

- `connect()` creates the transport and dispatcher internally, then runs
  greeting → LOGIN → CAPABILITY → STARTTLS negotiation.
- `close()` delegates to `dispatcher.sendCommand("LOGOUT")` then
  `transport.close()`.  The dead-connection fast-path stays.
- `idle()` still uses the async generator pattern, but its `finally` block
  checks `dispatcher.dead` instead of `this.#idleHook != null`.  The socket
  close path: Transport → CommandDispatcher.onDead → rejects pending →
  Session's idle `#idleEventResolve(null)` → generator `finally` → sees
  `dispatcher.dead` → skips DONE/drain.
- The three `#idle*` fields stay in Session because they're session-level
  state machines — the Command layer doesn't need to know about IDLE events
  or drain phases.

---

## Migration plan

All steps keep `connection.test.ts` green.

### Step 1 — Extract Transport

- Create `transport.ts` with the `Transport` class.
- Move `ImapReader` internals (lines 92–205), `debugSocket` (83–90), and
  socket setup from `connect()` into `Transport`.
- `Connection` creates a `Transport` instance; accesses `send()`, `onLine()`,
  `onLiteral()`, `onContinue()`, `onRawRead()`, `close()` through it.
- Remove `ImapReader` class from `connection.ts`.
- Run tests — should pass identically.

### Step 2 — Extract CommandDispatcher

- Create `dispatch.ts` with the `CommandDispatcher` class.
- Move `sendCommand`, `sendCommandWithContinuation`, `#dispatchLine`,
  `#pending`, `#untagged`, `#tag`, `#failAllPending` (renamed to
  `#onTransportDead`), and the `#dead` flag from `Connection` into
  `CommandDispatcher`.
- `CommandDispatcher` takes a `Transport` in its constructor and wires
  `transport.onLine`, `transport.onClose`, `transport.onError`.
- `Connection` creates a `CommandDispatcher` after creating the `Transport`.
  It calls `dispatcher.sendCommand()` instead of `this.sendCommand()`.
- The untagged-line passthrough (`onUntagged`) feeds session-level handlers
  (`#handleUntagged`, `#handleFetchLine`, `#idleHook`).
- Run tests — should pass identically.

### Step 3 — Clean up Session

- `Connection` no longer has `#reader`, `#dead`, `#pending`, `#untagged`,
  `#tag`, `#failAllPending`, or `#dispatchLine`.
- Public `sendCommand` and `sendCommandWithContinuation` delegate to
  `#dispatcher`.
- `dead` getter delegates to `#dispatcher.dead`.
- The `idle()` generator's `finally` block uses `this.dead` /
  `dispatcher.dead` instead of `this.#idleHook != null`.
- Remove the `#idleDrainResolve` field — it was a cross-layer hack.  The
  new flow: Transport close → CommandDispatcher.onDead → rejects all pending
  AND resolves `#idleEventResolve(null)` via the session's callback.
  The `finally` block sees `this.dead` and skips DONE/drain entirely.
- Run tests — should pass identically.  May need to adjust a few test
  expectations if behavior changes slightly.

---

## Benefits

1. **Debuggability.**  Socket close handling is in one place (Transport).
   Command timeouts and tag matching are in one place (CommandDispatcher).
   IMAP semantics are in one place (Session).  No more invisible coupling
   through instance fields set by one layer and read by another.

2. **Testability.**  Transport can be tested with raw line in/out, no IMAP
   knowledge.  CommandDispatcher can be tested with a mock Transport that
   replays lines.  Session can be tested with a mock CommandDispatcher.

3. **Reuse.**  The Transport layer works for any line-based protocol with
   literals (SMTP, POP3).  The CommandDispatcher works for any tagged-command
   protocol.  Only the Session layer is IMAP-specific.

4. **State visibility.**  Each layer's fields are only accessed within that
   layer.  No `#reader!.send(...)` assertions — the Session never touches
   the socket.  No `#idleDrainResolve` — the socket close path doesn't
   need to know about the IDLE drain state machine.

5. **Smaller files.**  `transport.ts` ~150 lines, `dispatch.ts` ~130 lines,
   `connection.ts` ~500 lines (down from ~930).