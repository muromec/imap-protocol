# Session layers — a proposal

> Status: **proposal**, 2026-10-14.  Nothing here is built.
> Scope: the session half of `connection.ts`, the IDLE session, the fetch response
> assembler, the watcher's policy hook, and the tests' server double.  The four layers
> below them (`transport.ts`, `dispatch.ts`, `connect.ts`, `interface.ts`) are healthy
> and stay as they are.

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
   `#maybeFinishFetch` (`:267`) is a response assembler living in the session.

Three consequences, each measured against a real provider:

- A command issued while a session idles never lands: the provider answers the IDLE tag
  with `BAD Expected DONE` and never answers the command.
- A consumer that decides a message's fate after a handover — the `\Seen` flag — has to
  ride a connection it does not own, and that connection is idling or dying nearly all
  the time.
- Two defects in one evening came out of this: the break in a session sent no DONE at
  all (a generator parked on an event wait cannot be interrupted), and a session the
  server ended left its reader waiting for an event that never came.

`docs/idle-races.md` §3 states the rule the code then broke: *"IDLE MUST reuse
`sendCommand` … if IDLE uses a custom promise mechanism, the tagged OK would be
unmatched and silently ignored, causing the iterator to hang."*  Everything below is
that rule given a place to live.

## The shape

### 1. One pending table (dispatch.ts, unchanged in shape)

IDLE takes its tag from the same counter and registers it in the same table as every
other command.  A reply to the IDLE tag is matched by the mechanism that matches every
reply, so `#idleHook` has nothing to swallow.  `nextTag()` goes away with the last
caller that wanted a tag nobody held.

### 2. Assemblers, not callbacks (new)

Interpreting a response is a small object with one job, registered for the life of one
command and dropped with it:

- `FetchAssembler` — collects `FETCH` responses, literals included, into
  `FetchedMessage[]`.
- `IdleAssembler` — parses `EXISTS` / `RECENT` / `EXPUNGE` / `FETCH` / `FLAGS` into
  `IdleEvent`, and holds the events that arrive before a reader asks for them.

They see only their own command's lines.  This is today's `#handleFetchLine` /
`#parseIdleEvent` code, moved out and given a boundary.

### 3. `IdleSession` (new module)

An object with states — `entering` → `idling` → `ending` → `ended` — rather than flags
scattered across a class:

- `begin()` sends IDLE through the dispatcher and awaits the continuation.
- the iterator yields `IdleEvent`s; `return()` sends DONE once, awaits the tagged
  reply, and ends the session.
- the session ends on its own `return()`, on the tagged reply (an `OK` for a DONE, or a
  `NO`/`BAD` from a server that ended it first), or on the socket dying — and every one
  of those endings finishes the reader.
- the idle timeout is its own field.  Today it is `commandTimeout`, so a session is cut
  off after 30 s of quiet, which is the only reason the default keepalive is 25 s.

### 4. One rule about commands during a session (the session's job)

The session — not each caller — knows that `DONE` is the only line a client may send
while a session idles.  A command asked for in that window takes one of two shapes, and
this proposal leaves the choice open:

- **queued**: it waits, the session ends, the command runs, the session resumes;
- **refused**: it rejects with a sentence naming the session.

*Queued* is the shape that fits the layer: a caller cannot know when the window closes,
and the session can.  Its cost is that a command may wait up to the idle timeout; the
refusal makes that visible instead.  A refusal is what ships today (0.3.2), as the
stopgap that stops a caller feeding a session a line that kills it.

### 5. Policy above the session

The watcher is a caller of the session, not a second session manager.  Reconnect,
catch-up fetch and keepalive cycling stay.  The decision about what a delivered message
means — today the `markSeen` boolean, which makes a consumer reach into a connection —
becomes a callback the watcher's owner supplies, and the command it needs is one the
session serves like any other.

### 6. The mock as a server, not a script

Today the tests' double replays a scenario, and the rules of the wire are copied into
each test; when a defect turns up, the next option is bolted on (`idleLimitMs`,
`idleLoop` and counters were added for the two IDLE defects).  What ends that growth is
one small model that knows the words — greeting, `LOGIN`, `CAPABILITY`, `SELECT`,
`IDLE` (only `DONE` accepted, `BAD Expected DONE` otherwise), `BYE`, tagged replies —
with a scenario as an override on top rather than as the source of the rules.

## What it does not do

- No new IMAP operations.  `roadmap.md`'s batches 4–8 stay parked.
- No change to the public operation signatures (`connect`, `close`, `openBox`,
  `search`, `fetch`, `addFlags`, `fetchUnseen`, `idle`).
- No decision on queued-versus-refused; it is named and left open.
- No second connection anywhere: the point of (1)–(4) is that one is enough.

## Open

1. Queued or refused for a command during a session.
2. Where the watcher lives: its own module above the session, or a documented caller?
3. With a real policy hook, does `markSeen` still earn its place?

## Order of work

One slice per red test, smallest first:

1. **The wire rules in the double** — IDLE accepts only `DONE`; anything else is `BAD`
   on the IDLE tag and unanswered.  (Half of this ships in 0.3.2.)
2. **IDLE's tag in the pending table** — the hook stops swallowing tagged lines; the
   red test is a command during IDLE that must not eat another command's reply.
3. **The idle timeout as its own field** — a session may outlive the command timeout.
4. **`IdleSession`** — states, iterator, the three endings; `idle()` returns it.
5. **`FetchAssembler`** — the fetch state machine out of the session.
6. **Commands during a session** — whichever shape Open 1 settles on, in one place.
7. **The watcher's callback** — the decision at the caller, the connection no longer
   handed out for it.

## Files after

```
src/
├── transport.ts        unchanged
├── dispatch.ts         unchanged in shape, plus the assembler registry
├── connect.ts          unchanged
├── connection.ts       session: login, mailbox, typed operations
├── session/idle.ts     IdleSession: the state machine and its iterator
├── session/fetch.ts    FetchAssembler
├── watcher.ts          reconnect, catch-up, keepalive, the policy callback
└── interface.ts        types, one new field (idleTimeout)
```
