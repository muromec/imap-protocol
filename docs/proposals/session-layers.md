# Session layers — a proposal

> Status: **built**, 2026-10-14.  Slices 1–5 and 7 of "Order of work" are in the tree
> (commits `051e24e`, `2f3c1fd`, `45a62da`, `e9e388f`, `97d4307`, `68fb059`); slice 6,
> the watcher as a consumer, was not needed — see "What the build settled".
> `docs/architecture.md` is the description of what the code is now; this document stays
> as the design it was built from, and the differences are named below.
>
> The shape: a **session loop** over the connection, commands queued into it, IDLE one of
> its states.  It replaces the first draft of this section, which kept a dispatcher object
> with a pending table beside the session and gave each command an assembler.

## What the build settled

The five questions this proposal left open, answered by building it:

1. **One consumer per connection.**  Not a list: `Session.idle()` refuses a second
   request (`a session is already open on this connection`) rather than quietly
   replacing the first.  A second reader would have to be a second connection, which
   is what the loop exists to avoid needing.
2. **The watcher did not have to move.**  Its shape (`conn.idle()`, `iterator.next()`,
   `iterator.return()` on keepalive) fits the loop as it was written.  What changed is
   what it can now do: a command through `watcher.connection` while the session idles
   is queued and breaks the session, instead of being refused.  The harness's "flag a
   message read" path through that connection works because of this, which is why the
   two-connection workaround it was written with is not needed.
3. **`markSeen` stays** — a watcher-level policy switch is still the caller's, and the
   connection can now carry the command for it.  Nothing in this work removed it.
4. **In order, and one batch per interruption.**  The whole queue is written at once
   when the previous batch is answered; replies are matched by tag, so pipelining is a
   later policy of the drain rather than a change of shape.  A command that runs out of
   time still closes the connection — the reply may be coming and would be read as the
   next command's — and the commands that shared its batch are rejected naming the one
   that timed out, so a batch's failure reads as a failure and not as a socket that
   went away.
5. **The interruption cost is as stated**: `DONE` + its reply, the batch, then `IDLE` +
   its continuation.  A reader that holds a session and asks for nothing pays one
   round trip per interruption and nothing else.

Two differences from the shape as written:

- The files are `session.ts` (the loop, the queue, the standing request) and
  `collectors.ts` (lines and fetch).  Not a `session/` directory: two files with one
  job each did not earn a third level, and mailbox and search never became collectors
  — the connection parses their lines where it asks for them.
- The session's own timeout (slice 5) landed inside slice 4 rather than after it: the
  guard that ends a forgotten session was already moving, and leaving it on
  `commandTimeout` for a commit would have been a deliberate step backwards.

## What is there now

`docs/architecture.md` declares four layers, and three of them are what they say:
transport (socket, TLS, framing, death), dispatch (tags, one pending table, per-command
timeout, untagged forwarding), setup (greeting, STARTTLS, LOGIN, CAPABILITY).  The
fourth, `connection.ts`, is three concerns in one class.

`architecture.md` ends with "one coupling remains: `#idleDrainResolve`".  There are
five, and they are one problem — IDLE is a parallel command path:

1. `#idleTag` is taken outside the pending table (`connection.ts:426`) on purpose, and
   the reply is collected by a hook instead of by the mechanism that matches every
   other reply.
2. `#idleHook` (`connection.ts:498`) receives every untagged line **and every tagged
   line**, and returns early on all of them — so another command's reply is consumed
   while a session idles.
3. `#continuationResolve` (`:55`) is a second continuation channel beside the
   dispatcher's.
4. `#idleEventResolve` (`:62`) and `#idleDrainResolve` (`:66`) are promises the
   socket-close path resolves from outside the session.
5. `#fetchResolve` (`:50`) with `#handleFetchLine` (`:212`), `#onLiteral` (`:253`) and
   `#maybeFinishFetch` (`:267`) is a response collector living in the session.

Three consequences, each measured against a real provider:

- A command issued while a session idles never lands: the provider answers the IDLE tag
  with `BAD Expected DONE` and never answers the command.
- A consumer that decides a message's fate after a handover — the `\Seen` flag — has to
  ride a connection it does not own, and that connection is idling or dying nearly all
  the time.
- Three defects in one evening came out of this: the break in a session sent no DONE at
  all, a session the server ended left its reader waiting, and a command sent during a
  session was swallowed by the hook.

`docs/idle-races.md` §3 states the rule the code then broke: *"IDLE MUST reuse
`sendCommand` … if IDLE uses a custom promise mechanism, the tagged OK would be
unmatched and silently ignored, causing the iterator to hang."*  The loop below is that
rule made structural.

## The shape

### 1. One loop over the connection

A session is a generator that reads the wire and serves a queue:

```
for await (const item of transport.items()) {
  // item: a line, a literal chunk, or "the connection ended"
  // serve the current command's collector, or idle, or take the next queued command
}
```

- **Writes belong to the loop.**  Nobody else touches the transport, so nobody else can
  put a line on the wire while the loop is in the middle of something.
- **A batch, and a table of what is outstanding.**  A queue entry is
  `{ cmd, collector, deadline, resolve }`.  Draining takes the whole queue, so a batch
  costs one interruption of the session rather than one per command, and replies are
  matched by tag from a small table the loop owns — the table the single-thread shape
  had removed, safe again because there is one writer and one resolver.  Whether a
  batch's commands are issued in order or pipelined is a policy, not a property: the
  table serves one entry either way.
- **A collector is how a command's lines are read**: `FETCH` responses with literals,
  a mailbox's lines, search uids, `IDLE` events.  Collectors are objects with one
  method (`line(item)`, and `done`), so the idle event parser stops being special.
- **Ending the connection is an item**, not a callback.  `close` and `error` are pushed
  into the same stream, or the loop is back to promises resolved from outside it.

### 2. IDLE is a state of the loop, not a command with a hook

The loop is either running a command or idling.  Idling means: a session is open, the
queue is empty, and the consumer still wants the session.

- Re-entering IDLE is a **standing request** held by the consumer — the watcher asks for
  a session and gives it a sink for events; while that request stands and nothing is
  queued, the loop idles.
- The queue breaks the session: `DONE`, the tagged reply, the batch, then back to IDLE
  once if the request still stands.  This answers the queued-or-refused question by
  construction: **queued**, in the one place that knows when the window closes.
- When the consumer drops the request, the loop stops idling and the connection is just
  a connection again.
- Only the loop knows the session is open, so "only `DONE` may be sent while idling" is
  its state rather than a rule each caller has to remember.

### 3. Two clocks

A queued command has a deadline.  A session has its own timeout.  Today both are
`commandTimeout`, which is why a quiet session looks like a failed command and why the
default keepalive is 25 s.  They are different things: quiet is what a session *is*.

### 4. The consumer above

The watcher is a consumer of the session, not a second session manager: reconnect,
catch-up fetch and keepalive cycling stay; the decision about what a delivered message
means becomes a callback its owner supplies, instead of a `markSeen` boolean that makes
a consumer reach into a connection it does not own.

### 5. The tests' double as a server, not a script

Today the double replays a scenario, and the rules of the wire are copied into each
test; when a defect turns up, the next option is bolted on (`idleLimitMs`, `idleLoop`
and counters were added for the two IDLE defects).  What ends that growth is one small
model that knows the words — greeting, `LOGIN`, `CAPABILITY`, `SELECT`, `IDLE` (only
`DONE` accepted, `BAD Expected DONE` otherwise), `BYE`, tagged replies — with a
scenario as an override on top rather than as the source of the rules.

## What it does not do

- No new IMAP operations.  `roadmap.md`'s batches 4–8 stay parked.
- No change to the public operation signatures (`connect`, `close`, `openBox`,
  `search`, `fetch`, `addFlags`, `fetchUnseen`, `idle`).
- No decision about how a batch is issued: in order and pipelined both fit the same
  table, in-order being the simpler default.  Open 4 carries it.
- No second connection anywhere: the point of the loop is that one is enough.

## Open

Still open, now that the shape is built:

1. **Pipelining.**  The batch is written together and matched by tag, which is most of
   what pipelining needs, but the drain runs one batch to completion before writing the
   next.  Flipping that is a policy of `#pump`, not a change of shape.
2. **A command's timeout closes the connection** — the reply may be coming and would be
   read as the next command's.  A caller that would rather keep the connection could ask
   the loop to judge the wire instead; nothing in the shape prevents it.
3. **`connection.ts` parses mailbox and search lines where it asks for them** rather than
   through collectors.  Two collectors, each reading one command's lines, is honest; a
   third would be a pattern worth naming.
4. **`WatcherConfig.markSeen`** still decides what a delivered message means (see "What
   the build settled" 3).  Nothing in this work moved that decision.

## Order of work

As built, one slice per commit:

1. **The wire rules in the double** — shipped in 0.3.2: the mock enforces the wire, so
   anything but DONE during an IDLE session is answered `BAD` on the IDLE tag and the
   offending command is never answered.
2. **The loop skeleton** — `051e24e` (the transport's item stream) and `2f3c1fd` (the
   loop: queue, batch, table of outstanding commands, per-command and session timeouts).
   The red test it asked for is the session suite's first case: two commands asked for in
   one turn are both written before any reply is read.
3. **Collectors** — `45a62da`: `LinesCollector` and `FetchCollector`; the fetch parse
   leaves `connection.ts` with the `setImmediate` guess that the tagged OK had been
   dispatched.
4. **IDLE as a state** — `e9e388f`, with slice 5 inside it.
5. **The session's own timeout** — `e9e388f`: `sessionTimeout` (default 30 s), separate
   from `commandTimeout`.
6. **The watcher as the consumer** — not built, because it did not have to be: its shape
   already fit, and the loop made the command-through-an-idling-connection case work.
7. **Slim what is left** — `97d4307` (the connection on the loop; `dispatch.ts` deleted;
   `Connection.sendCommandWithContinuation` removed) and `68fb059` (the transport's
   single-slot callbacks deleted — the item stream is its only output).

## Files after

```
src/
├── transport.ts     253  framing, TLS, literals, death — as items
├── session.ts       466  the loop: queue, batches, IDLE as a state, two clocks
├── collectors.ts     77  how one command's reply is read
├── connection.ts    374  the public operations on top of the loop
├── connect.ts       187  greeting, STARTTLS, LOGIN, CAPABILITY
├── watcher.ts       280  reconnect, catch-up, keepalive, the mail event
├── interface.ts      55  types
└── index.ts           8  exports
```
