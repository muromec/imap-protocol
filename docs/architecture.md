# Architecture — imap-protocol

One connection is one loop.  The transport frames bytes and hands them over as
items; the session owns every write and every tag, queues commands, and holds
IDLE as one of its states; the connection spells the IMAP operations in terms
of the session.

Tests: 75 passed, 2 todo (five files, ~4s).  `docs/untested.md` names what they
do not cover.

> As built 2026-10-14 from `docs/proposals/session-layers.md`.  The shape it
> replaced — a `CommandDispatcher` with a single untagged accumulator, IDLE as a
> parallel command path with its own tag and hooks, and a fetch assembler living
> in `connection.ts` — is described in that proposal's "What is there now" and
> in `idle-races.md`, which reasons about the races the old shape had.

---

## Layer 1 — Transport (`transport.ts`, 253 lines)

**Responsibility:** turn a TCP/TLS stream into framed IMAP items.  The only
layer that knows about `\r\n`, `{size}` literals, `+` continuations, and raw
socket reads and writes.  No IMAP semantics — no tags, no OK/NO/BAD, no
command meanings.

### State

- `#socket` — the connected socket (TCP or TLS), handed in by `connect.ts`.
- `#buf`, `#literalRemaining`, `#literalChunks` — the framing buffers.
- `#items: TransportItems | null` — the item stream, created on first read.
- `#dead` — set on close or error.
- `#onRawRead` — the debug seam: every raw read, when a caller wants it.

### Items

```ts
type TransportItem =
  | { kind: 'line'; line: string }
  | { kind: 'continue'; line: string }
  | { kind: 'literal'; data: string }
  | { kind: 'ended'; error?: Error };
```

`items()` returns an `AsyncIterable` the session loop reads.  `ended` is
delivered as the last item, so a `for await` reader learns why it stopped
instead of falling out of the loop; the call after it reports the iteration
finished.  One reader by construction.

| Method | Description |
|---|---|
| `constructor(socket, debug?)` | Registers `data`, `close`, `error`.  With debug on, wraps `socket.write` to log writes. |
| `send(raw)` | Write a line; CRLF is appended. |
| `items()` | The framing as a stream, for the loop. |
| `onRawRead(cb)` | Raw reads, for debug logging. |
| `close()` | Close the socket. |
| `setDebug(enabled)` | Toggle write logging at runtime. |
| `dead` | Whether the socket has closed or errored. |

Debug output goes to stderr with `[imap]` and a timestamp: writes as `→`,
reads as `←` (the read half is wired by `Connection`), both JSON-escaped.

---

## Layer 2 — Session (`session.ts`, 466 lines)

**Responsibility:** the wire, one command at a time.  The session is the only
reader of the transport's item stream and the only writer on the socket.

### What it owns

- The tag counter, and the two tables: `#queue` (asked for, not yet written)
  and `#outstanding` (written, waiting for their tagged reply).
- A batch: everything queued when the previous batch is done is written
  together, and each command is settled by its own tag.  The write is deferred
  to the end of the turn (`queueMicrotask`), which is what makes "asked for in
  one turn" mean one batch.
- Timeouts: `commandTimeout` for a written command, `sessionTimeout` for a
  session nobody does anything with.
- IDLE, as a state: `#pump` opens a session when the queue is empty and a
  reader is holding one, breaks it with DONE when a command asks for the wire,
  and opens it again once that batch is answered.

### The loop

```
for await (item of transport.items()) #onItem(item)
```

`#onItem` routes by kind and by tag: a literal or a continuation belongs to the
oldest outstanding command; `* BYE` and `ended` fail everything; a tagged line
settles the command that owns its tag, or the standing session, or — if nobody
owns it — `onStray`; an untagged line goes to the outstanding command's
collector and to `onUntagged`, or to the standing session's reader.

`#pump` is the only place anything is written, and it acts on the whole state:
a batch that is out must be answered first; a standing session may only be
interrupted with DONE, and only while it is open; a session being entered or
drained leaves DONE as the only legal line; with nothing queued the session
opens again, or is dropped when its reader has stopped wanting it.

### Failure

A command nobody answers closes the connection: a late reply would be read as
the next command's.  The commands that shared its batch are rejected naming the
one that timed out, rather than reading as a socket that went away on its own.
`onEnd` reports the reason once.

| Method | Description |
|---|---|
| `send(cmd, collector)` | Queue a command, collect its reply. |
| `sendCommand(cmd)` | The same, with the lines collector. |
| `idle()` | Hold the connection open, yielding the lines the server sends unprompted.  One session at a time. |
| `onUntagged(cb)` | Lines no command consumed — mailbox updates. |
| `onStray(cb)` | A tagged line whose command nobody owns. |
| `onEnd(cb)` | The session stopped, with the reason. |
| `close()` | Close the socket. |
| `dead` | Whether the session has stopped taking commands. |

---

## Layer 3 — Collectors (`collectors.ts`, 77 lines)

**Responsibility:** how one command's reply is read.  A collector is handed
every item that arrives while its command is the oldest one outstanding, and
the tagged OK asks it for the result.

- `LinesCollector` — the reply as the lines it was; what most commands are.
- `FetchCollector` — one message per FETCH line, its body from the literal that
  follows it (or inline).  The FETCH parse used to live in `connection.ts` with
  a `setImmediate` to guess that the tagged OK had been dispatched.

---

## Layer 4 — Connection setup (`connect.ts`, 187 lines)

**Responsibility:** establish an authenticated connection: socket, TLS or
STARTTLS, LOGIN, CAPABILITY.

```ts
async function connect(
  config: ImapConfig,
  debugEnabled: boolean,
): Promise<{ transport: Transport; session: Session; capabilities: Set<string> }>
```

1. `createSocket(config)` — `tls.connect()` or `new Socket().connect()`, under
   `connTimeout`.
2. `waitForGreeting(session, config)` — waits on the session's untagged lines
   for the first `* OK` / `* PREAUTH`, reads STARTTLS out of the greeting's
   capabilities, and answers `{ starttls, preauth }`.
3. `starttls(session, socket, transport, debugEnabled, config)` — sends
   STARTTLS, upgrades the socket with `tls.connect({ socket })`, and returns a
   new transport and session over the upgraded socket.
4. `login(session, config)` — `LOGIN`, under `authTimeout`.
5. `fetchCapabilities(session, capabilities)` — `CAPABILITY`, best effort.

---

## Layer 5 — Connection (`connection.ts`, 374 lines)

**Responsibility:** what the IMAP operations mean, on top of the session.  This
is the public API.

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
  sendCommand(cmd): Promise<string[]>
}
```

| Section | Content |
|---|---|
| State | `#transport`, `#session`, `#mailboxInfo`, `capabilities` |
| Debug & lifecycle | `dead`, `setDebug`, `connect`, `close`, `serverSupports`, `sendCommand`, `#live` |
| Untagged | `#handleUntagged` — EXISTS / RECENT / FLAGS into `#mailboxInfo` |
| Operations | `openBox` (SELECT/EXAMINE + its lines), `search`, `fetch` (a `FetchCollector`), `addFlags` (STORE), `fetchUnseen` |
| IDLE events | `idle()` wraps the session's lines as `IdleEvent`s, `#parseIdleEvent` |
| Search query | `escapeString`, `buildSearchQuery` |

`close()` sends LOGOUT and closes the socket in a `finally`, so a server that
refuses LOGOUT still gets a closed connection.

---

## File listing

```
src/
├── transport.ts     253  Layer 1 — socket, framing, the item stream
├── session.ts       466  Layer 2 — the loop: queue, batches, IDLE, timeouts
├── collectors.ts     77  Layer 3 — how a reply is read
├── connect.ts       187  Layer 4 — socket, TLS, LOGIN, CAPABILITY
├── connection.ts    374  Layer 5 — the public operations
├── watcher.ts       280  reconnect, catch-up, keepalive, the mail event
├── interface.ts      55  types
└── index.ts           8  exports
test/
├── transport.test.ts    4 cases
├── session.test.ts     11 cases
├── collectors.test.ts   4 cases
├── connection.test.ts  52 cases + 2 todo
└── watcher.test.ts     13 cases
scripts/
├── imap-server-mock.ts  391  the mock server the connection and watcher suites drive
└── test-integration.ts  116  against a real server, outside the gate
```

## Cross-layer coupling

What is left, named:

- `Connection` wires two session hooks (`onUntagged` for mailbox updates) and
  the transport's `onRawRead` for debug reads.  Both are single-slot.
- `idle()` in `connection.ts` reads the session's lines and parses them into
  `IdleEvent`s.  The session does not know what an event is; the connection
  does not know how a session is opened or broken.
- A session's guard (`sessionTimeout`) closes the socket, which fails the
  commands in flight, which is how a forgotten session becomes a dead
  connection rather than a hung reader.
