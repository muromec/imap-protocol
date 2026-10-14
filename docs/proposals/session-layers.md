# Session layers — a proposal

> Status: **proposal**, 2026-10-14.  Nothing here is built.
> Scope: the session half of `connection.ts`, the IDLE session, response collection, the
> watcher's policy hook, and the tests' server double.  The layers below them
> (`transport.ts`, `dispatch.ts`, `connect.ts`, `interface.ts`) hold what is worth
> keeping: framing, tags, setup, types.
>
> The shape in this revision is a **session loop**: one generator over the connection,
> commands queued into it, IDLE one of its states.  It replaces the first draft of the
> shape section, which kept a dispatcher object with a pending table beside the session
> and gave each command an assembler.

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
- **One command is outstanding at a time.**  A queue entry is
  `{ cmd, collector, deadline, resolve }`.  One slot replaces the pending map: the
  single-threaded shape is what makes the map unnecessary, and the map was only safe
  for one command anyway (`#untagged` is a single array that each `sendCommand` resets).
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
- A queued command breaks the session: `DONE`, the tagged reply, the command, then back
  to IDLE if the request still stands.  This answers the queued-or-refused question by
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
- **No pipelining.**  Two commands in flight is legal IMAP; the loop gives that up,
  deliberately, because nothing here can use it safely today and the arbitration is
  what all of the above defects were about.
- No second connection anywhere: the point of the loop is that one is enough.

## Open

1. The standing request: one consumer per connection, or a list with one session?
2. Where the watcher lives once it is a consumer: its own module, or the caller the
   docs describe.
3. With a real policy hook, does `markSeen` still earn its place?
4. Interruption cost, stated honestly: each command that breaks a session pays `DONE` +
   reply and then `IDLE` + continuation.  The keepalive already does this every 25 s, so
   it is the loop's normal work — but a chatty consumer should know.

## Order of work

One slice per red test, smallest first:

1. **The wire rules in the double** — IDLE accepts only `DONE`; anything else is `BAD`
   on the IDLE tag and unanswered.  (Half of this ships in 0.3.2.)
2. **The loop skeleton** — one command slot, a queue, collectors, `close`/`error` as
   items; behaviour unchanged for every existing operation.  Red test: two commands
   asked for at once run one after the other, in order.
3. **Collectors** — fetch (with literals), mailbox, search move into their own objects.
4. **IDLE as a state** — the standing request, the events as a stream, the three
   endings, the tagged reply read by the loop.  Red tests: the two defects of 0.3.1 and
   0.3.2 become cases in the loop.
5. **The session's own timeout** — separate from the command deadline.
6. **The watcher as the consumer** — reconnect, catch-up, keepalive, the policy callback.
7. **Slim what is left** — `connection.ts` keeps the public operations and the setup,
   and the dispatcher object either disappears into the loop or stays as a pure
   line-matching helper with no state of its own.

## Files after

```
src/
├── transport.ts        unchanged: framing, TLS, literals, death — as items
├── session/loop.ts     the loop, the queue, the standing idle request
├── session/collect.ts  collectors: fetch, mailbox, search, idle events
├── connection.ts       the public operations on top of the loop
├── connect.ts          greeting, STARTTLS, LOGIN, CAPABILITY
├── watcher.ts          reconnect, catch-up, keepalive, the policy callback
└── interface.ts        types, one new field (session timeout)
```
