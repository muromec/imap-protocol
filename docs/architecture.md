# Architecture — imap-connector

`imap-connector` is decomposed into four files with clear layer boundaries.
The public API (`Connection`) is unchanged; the internals are split across
Transport, CommandDispatcher, connection setup, and the session layer.

Tests: `connection.test.ts` — 47 passed, 2 todo (vitest, ~3s).

---

## Layer 1 — Transport (`transport.ts`, 210 lines)

**Responsibility:** turn a raw TCP stream into framed IMAP lines/literals/
continuations and back.  The only layer that knows about `\r\n`, `{size}`
literals, `+` continuations, and raw socket reads/writes.  Has no knowledge
of IMAP semantics — no tags, no OK/NO/BAD, no command meanings.

### State

- `socket: Socket` — the underlying TCP or TLS socket (already connected
  when passed to the constructor).
- `buf`, `literalRemaining`, `literalChunks` — line/literal framing buffer.
- `dead: boolean` — set on socket close or error.
- Callbacks: `onLine`, `onLiteral`, `onContinue`, `onClose`, `onError`,
  `onRawRead` — single-slot each (setting replaces previous).

### Public interface

| Method | Description |
|---|---|
| `constructor(socket, debug?)` | Wrap a connected socket.  Registers `data`, `close`, `error` handlers.  If debug is enabled, wraps `socket.write` for logging. |
| `send(raw)` | Write bytes to the socket.  CRLF is appended automatically. |
| `onLine(cb)` | Callback for each complete framed line (excluding `+` lines and literal data). |
| `onLiteral(cb)` | Callback for each literal body (after `{size}` synchronisation). |
| `onContinue(cb)` | Callback for `+` continuation lines. |
| `onClose(cb)` | Socket closed. |
| `onError(cb)` | Socket error (ECONNRESET is silently ignored as normal TCP teardown). |
| `onRawRead(cb)` | Raw-read hook for debug logging. |
| `close()` | Gracefully close the socket. |
| `setDebug(enabled)` | Toggle debug logging at runtime. |
| `dead` | Whether the socket has closed or errored. |

### Debug logging

When enabled, raw socket writes are logged with `→` and reads with `←`
(both JSON-escaped).  Output goes to stderr with `[imap]` prefix and
ISO timestamps.  Writes are intercepted via a `socket.write` monkey-patch;
reads are logged from the `data` event handler.

---

## Layer 2 — CommandDispatcher (`dispatch.ts`, 153 lines)

**Responsibility:** pair tagged IMAP commands with their tagged responses.
Sends a command with a unique `A0001`-style tag, collects untagged lines
that arrive before the matching tagged OK/NO/BAD, and resolves or rejects
the per-command promise.  Also handles per-command timeouts.

Has no knowledge of IMAP semantics — does not know what LOGIN, SELECT,
FETCH, or IDLE mean.

### State

- `#tag: number` — auto-incrementing tag counter.
- `#pending: Map<tag, { resolve, reject, timer }>` — outstanding commands.
- `#untagged: string[]` — lines accumulated since the current command
  started (reset per `sendCommand` call).
- `#dead: boolean` — set when the transport dies.
- Callbacks: `onUntagged`, `onDead` — single-slot each.

### Public interface

| Method | Description |
|---|---|
| `constructor(transport, defaultTimeout)` | Takes the Transport and wires `transport.onLine`, `transport.onClose`, `transport.onError`. |
| `sendCommand(cmd)` | Send a tagged command.  Returns untagged lines that arrived before the tagged OK.  Rejects on tagged NO/BAD or timeout. |
| `nextTag()` | Generate a fresh tag without sending anything.  Used by the Session's `idle()` which manages its own tag lifecycle. |
| `onUntagged(cb)` | Callback for lines not consumed by a pending tagged command.  The Session layer uses this for mailbox updates, fetch parsing, and idle events. |
| `onDead(cb)` | Called when the transport dies.  The Session layer uses this to clean up idle resolvers and fetch state. |
| `dead` | Whether the transport has died. |

### Line dispatch logic

```
#onLine(line):
  if line matches RE_TAGGED (A\d+ OK/NO/BAD):
    if tag is in #pending → resolve/reject the command promise
    else → forward to onUntagged callback (for idle DONE/OK detection)
  else:
    push to #untagged
    forward to onUntagged callback

#onTransportDead(err):
  set #dead = true
  reject all #pending promises
  fire onDead callback
```

Unmatched tagged responses (e.g. the IDLE command's tagged OK after the
DONE handshake) are forwarded to `onUntagged` so the Session layer can
detect them via `#idleHook`.  This is the only IMAP-specific awareness in
the dispatcher — all other tagged/untagged routing is generic.

---

## Layer 3 — Connection setup (`connect.ts`, 190 lines)

**Responsibility:** establish an authenticated IMAP connection.  Creates
the socket, negotiates TLS/STARTTLS, authenticates with LOGIN, and fetches
CAPABILITY.  Returns a fully-initialised Transport + CommandDispatcher +
capabilities set.

### Exported function

```ts
async function connect(
  config: ImapConfig,
  debugEnabled: boolean,
): Promise<{
  transport: Transport;
  dispatcher: CommandDispatcher;
  capabilities: Set<string>;
}>
```

### Internal flow (sequential async)

1. **`createSocket(config)`** — `tls.connect()` or `new Socket().connect()`
   with `connTimeout`.  Returns a connected socket.

2. **`waitForGreeting(dispatcher, config)`** — hooks into the dispatcher's
   `onUntagged` callback.  Waits for the first `* OK` or `* PREAUTH` line.
   Parses the greeting for `STARTTLS` capability.  Returns
   `{ starttls: boolean }`.

3. **`starttls(dispatcher, socket, transport, config)`** — sends the
   STARTTLS command, upgrades the plain socket to TLS via
   `tls.connect({ socket })`, returns a new Transport and CommandDispatcher
   wrapping the upgraded socket.  Only called when `autotls` is set and
   the server advertises STARTTLS.

4. **`login(dispatcher, config)`** — sends `LOGIN` with `authTimeout`.
   Rejects on timeout or tagged NO/BAD.

5. **`fetchCapabilities(dispatcher, capabilities)`** — sends `CAPABILITY`,
   parses the response, populates the `capabilities` set.  Best-effort:
   resolves even if CAPABILITY fails.

### How `Connection` uses it

```ts
async connect(): Promise<void> {
    const { transport, dispatcher, capabilities } = await connect(
      this.#config, this.#debugEnabled,
    );
    this.#transport = transport;
    this.#dispatcher = dispatcher;
    this.capabilities = capabilities;
    this.#wireCallbacks();
}
```

Nine lines.  `#wireCallbacks()` connects the transport and dispatcher to
the Session's event handlers (fetch parsing, idle hooks, dead-connection
cleanup).

---

## Layer 4 — Connection / Session (`connection.ts`, 628 lines)

**Responsibility:** IMAP protocol semantics.  This is the public
`Connection` class.  Uses `CommandDispatcher` to execute IMAP operations
and interprets the responses.  Does not touch the socket directly — all
I/O goes through the dispatcher and transport.

### Public API (unchanged)

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
  sendCommand(cmd): Promise<string[]>        // delegates to dispatcher
  sendCommandWithContinuation(cmd): Promise<string>  // sets #continuationResolve
}
```

### Internal structure (~628 lines)

| Section | Lines | Content |
|---|---|---|
| State | 38–68 | `#transport`, `#dispatcher`, `#mailboxInfo`, `capabilities`, fetch state, idle state (`#idleHook`, `#idleEventResolve`, `#idleDrainResolve`), `#continuationResolve` |
| Debug & lifecycle | 80–170 | `dead`, `setDebug`, `#wireCallbacks`, `serverSupports`, `sendCommand`, `sendCommandWithContinuation`, `#sessionUntagged` |
| Connection setup | 152–172 | `connect()` (9 lines), `close()` (11 lines) |
| Continuation dispatch | 180–186 | `#onContinue` — resolves `#continuationResolve` on `+` lines |
| Untagged handlers | 188–260 | `#handleUntagged` (EXISTS/RECENT/FLAGS → `#mailboxInfo`), `#handleFetchLine` + `#onLiteral` + `#maybeFinishFetch` (fetch state machine) |
| IMAP operations | 262–420 | `openBox`, `search`, `fetch`, `addFlags`, `fetchUnseen` |
| IDLE | 422–570 | `idle()` async generator, `#parseIdleEvent` |
| Search utilities | 575–628 | `escapeString`, `buildSearchQuery` |

### Dead-connection handling

`#wireCallbacks()` sets `dispatcher.onDead()` to clean up session-level
state when the transport dies:

- Resolves `#idleEventResolve(null)` — breaks the idle `while` loop.
- Resolves `#idleDrainResolve()` — unblocks the idle `finally` block if
  the socket dies during the DONE/drain phase.
- Nulls `#idleHook`.
- Resolves any in-flight `#fetchResolve` with partial results.

The `#idleDrainResolve` field is the last remaining cross-layer coupling:
it is set during the idle DONE/drain phase and resolved by the socket-close
path.  Removing it caused hangs when the server closed the socket during
the drain `await` (see `idle-races.md` race #7).

### IDLE flow

The `idle()` async generator is the most complex single method (~150 lines):

1. Generates a tag via `dispatcher.nextTag()`, sets an idle timeout timer.
2. Installs `#idleHook` — intercepts all untagged lines and unmatched
   tagged responses from the dispatcher's `onUntagged` callback.  Parses
   EXISTS, RECENT, EXPUNGE, FETCH, and FLAGS events.
3. Creates `firstEventPromise` BEFORE sending the IDLE command so that
   events arriving synchronously with the `+ idling` continuation are
   not dropped.
4. Sends `IDLE` via `sendCommandWithContinuation`, awaits `+ idling`.
5. Yields parsed events as they arrive.
6. On `break` / `return()`: sets `done = true`, sends `DONE`, awaits the
   tagged OK (or socket close via `#idleDrainResolve`), yields any
   remaining queued events, cleans up.

---

## File listing

```
vendored/imap-connector/
├── transport.ts           210 lines   Layer 1 — socket + line/literal framing
├── dispatch.ts            153 lines   Layer 2 — tagged command dispatch
├── connect.ts             190 lines   Layer 3 — connection setup
├── connection.ts          628 lines   Layer 4 — IMAP session (public API)
├── mock.ts                285 lines   Mock IMAP server for tests
├── index.ts                 9 lines   Barrel export
├── interface.ts            55 lines   Shared types (ImapConfig, MailboxInfo, etc.)
├── connection.test.ts     971 lines   47 tests + 2 todo
├── test-integration.ts    113 lines   Integration test against real server
└── docs/
    ├── architecture.md                 this file
    ├── design.md                      design decisions
    ├── roadmap.md                     phased feature plan
    ├── untested.md                    untested behaviours
    └── idle-races.md                  IDLE race condition analysis
```

## Cross-layer coupling

One coupling remains: `#idleDrainResolve`.  Set during the idle DONE/drain
phase, resolved by `#wireCallbacks`'s `onDead` handler when the socket
closes.  This is necessary because the idle `finally` block `await`s a
promise that waits for the tagged OK — if the socket dies during that
`await`, the promise never resolves and the generator hangs.  The
`#idleDrainResolve` provides an escape hatch.

All other coupling is through defined interfaces: Transport exposes
callbacks, CommandDispatcher exposes `sendCommand`/`onUntagged`/`onDead`,
the Session never touches the socket directly.