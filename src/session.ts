import { Transport, type TransportItem } from './transport.ts';
import { LinesCollector, type Collector } from './collectors.ts';

// ── session ────────────────────────────────────────────────────────────────

const RE_TAGGED = /^(A\d+) (OK|NO|BAD)(?:\s|$)/;
const RE_BYE = /^\* BYE\b/i;

type Status = 'OK' | 'NO' | 'BAD';

/** A command in the loop's hands, in the shape the loop needs it. */
interface Pending {
  tag: string;
  cmd: string;
  accept(item: TransportItem): void;
  /** Its tagged reply arrived. */
  answered(status: Status, line: string): void;
  /** It will never be answered. */
  fail(reason: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Where the loop is with a session a consumer is holding open. */
type IdlePhase = 'ready' | 'entering' | 'holding' | 'draining';

/**
 * A consumer's standing request to keep the connection idling, and the lines
 * the server sends while it does.
 *
 * The request belongs to its reader, the state on the wire belongs to the
 * loop, and the two only meet through `wanted` and `close`: the reader says
 * whether it still wants lines, the loop says when the session is over.
 */
class IdleSession {
  /** The tag of the IDLE command in flight, while one is. */
  tag: string | null = null;
  phase: IdlePhase = 'ready';
  /** Whether the reader still wants lines. */
  wanted = true;
  /** Whether the reader has read anything yet: the session opens on the first
   *  read, not when the iterable is made. */
  started = false;
  /** Ends a session its reader forgot about. */
  timer: ReturnType<typeof setTimeout> | null = null;

  #lines: string[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  #endWaiters: Array<() => void> = [];

  /** A line the server sent unprompted. */
  sink(line: string): void {
    this.#lines.push(line);
    this.#wakeNow();
  }

  /** The session is over, whatever ended it. */
  close(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.wanted = false;
    this.#wakeNow();
    for (const waiter of this.#endWaiters.splice(0)) waiter();
  }

  /** Resolves when the session is over for good. */
  ended(): Promise<void> {
    if (this.#ended) return Promise.resolve();
    return new Promise((resolve) => this.#endWaiters.push(resolve));
  }

  async next(): Promise<IteratorResult<string>> {
    while (this.#lines.length === 0) {
      if (this.#ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    return { done: false, value: this.#lines.shift()! };
  }

  #wakeNow(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

export interface SessionOptions {
  /** How long a written command may wait for its reply.  Default 30_000. */
  commandTimeout?: number;
  /**
   * How long a session may stand with nothing happening in it.  This is the
   * only thing that ends a session its reader forgot about, so it has to be
   * longer than the keepalive a consumer uses to break its sessions on
   * purpose.  Default 30_000.
   */
  sessionTimeout?: number;
}

/**
 * One connection, one loop.
 *
 * The loop is the only reader of the transport's item stream and the only
 * writer on the socket, which is what makes the rest simple: a command that
 * cannot be answered has exactly one place to be failed, and IDLE is a state
 * of this machine rather than a parallel command path that has to dodge the
 * command table.
 *
 * Commands queue and are written as one batch: everything queued when the
 * previous batch is done goes out together, and each is resolved by its own
 * tag.  A session a consumer is holding stands in the queue's way — a command
 * asked for while one stands breaks it (DONE, the tagged reply, the batch),
 * and the session is opened again afterwards if the reader still wants it.
 */
export class Session {
  readonly #transport: Transport;
  readonly #commandTimeout: number;
  readonly #sessionTimeout: number;

  /** Commands waiting to be written, in the order they were asked for. */
  #queue: Pending[] = [];
  /** Written commands awaiting their tagged reply, oldest first. */
  #outstanding: Pending[] = [];
  /** The session a consumer is holding open, if one is. */
  #idle: IdleSession | null = null;

  #tag = 0;
  #dead = false;
  #failed = false;

  /** Whether the write for this turn has already been scheduled. */
  #pumpScheduled = false;

  #untaggedCallback: ((line: string) => void) | null = null;
  #strayCallback: ((line: string) => void) | null = null;
  #endCallback: ((reason: Error) => void) | null = null;

  constructor(transport: Transport, options: SessionOptions = {}) {
    this.#transport = transport;
    this.#commandTimeout = options.commandTimeout ?? 30_000;
    this.#sessionTimeout = options.sessionTimeout ?? 30_000;
    void this.#run();
  }

  /** Whether the session has stopped taking commands. */
  get dead(): boolean {
    return this.#dead;
  }

  /**
   * Send a command and collect its reply with `collector`.
   *
   * Rejects if the connection is dead, if the server answers NO / BAD, if the
   * reply takes longer than the command timeout, or if the connection goes
   * before it is answered.
   */
  send<T>(cmd: string, collector: Collector<T>): Promise<T> {
    if (this.#dead || this.#transport.dead) {
      return Promise.reject(new Error('Connection is dead'));
    }
    const tag = this.#nextTag();
    const promise = new Promise<T>((resolve, reject) => {
      this.#queue.push({
        tag,
        cmd,
        accept: (item) => collector.accept(item),
        answered: (status, line) => {
          if (status === 'OK') resolve(collector.finish());
          else reject(new Error(`${status}: ${line}`));
        },
        fail: (reason) => reject(reason),
      });
    });
    this.#schedule();
    return promise;
  }

  /** Send a plain command: the reply is the untagged lines it produced. */
  sendCommand(cmd: string): Promise<string[]> {
    return this.send(cmd, new LinesCollector());
  }

  /**
   * Hold the connection open and yield the lines the server sends unprompted.
   *
   * A command asked for while the session stands interrupts it: DONE goes out,
   * the batch runs, and the session is opened again if this reader still wants
   * it.  Breaking out of the iteration — or calling `return()` — ends the
   * session with DONE, its tagged reply, and a connection that is still usable.
   *
   * One session at a time: a second request is refused rather than quietly
   * replacing the first.
   */
  idle(): AsyncIterable<string> {
    if (this.#idle) throw new Error('a session is already open on this connection');

    const session = new IdleSession();
    if (this.#dead || this.#transport.dead) session.close();
    else this.#idle = session;

    const iterator: AsyncIterator<string> = {
      next: () => {
        // The session opens on the first read: making the iterable and never
        // reading it must not put IDLE on the wire.
        if (!session.started) {
          session.started = true;
          this.#schedule();
        }
        return session.next();
      },
      return: async () => {
        await this.#endIdle(session);
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  /**
   * Every line that arrived without being consumed by the command that was
   * outstanding — mailbox updates, and whatever a caller tracks for itself.
   */
  onUntagged(cb: (line: string) => void): void {
    this.#untaggedCallback = cb;
  }

  /**
   * A tagged line whose command nobody owns: a server answering something this
   * session never asked.
   */
  onStray(cb: (line: string) => void): void {
    this.#strayCallback = cb;
  }

  /** The session stopped: the socket closed, errored, or a command ran out of
   *  time.  Called once, with the reason every unsettled command was given. */
  onEnd(cb: (reason: Error) => void): void {
    this.#endCallback = cb;
  }

  close(): void {
    this.#transport.close();
  }

  // ── the loop ───────────────────────────────────────────────────────────

  async #run(): Promise<void> {
    for await (const item of this.#transport.items()) {
      this.#onItem(item);
    }
    this.#fail(new Error('Socket closed'));
  }

  #onItem(item: TransportItem): void {
    if (item.kind === 'ended') {
      this.#fail(item.error ?? new Error('Socket closed'));
      return;
    }

    if (item.kind === 'continue') {
      const idle = this.#idle;
      if (idle && idle.phase === 'entering') {
        idle.phase = 'holding';
        this.#pump();
        return;
      }
      this.#outstanding[0]?.accept(item);
      return;
    }

    if (item.kind === 'literal') {
      // A literal belongs to the command that asked for it, which is the
      // oldest one outstanding.
      this.#outstanding[0]?.accept(item);
      return;
    }

    if (RE_BYE.test(item.line)) {
      this.#fail(new Error(item.line));
      return;
    }

    const tagged = item.line.match(RE_TAGGED);
    if (tagged) {
      const [, tag, status] = tagged;
      const idle = this.#idle;
      if (idle && idle.tag === tag) {
        if (idle.phase === 'draining' && idle.wanted) {
          // The session was broken on purpose so a command could run: it is
          // over on the wire, and opens again once that batch is done.
          idle.phase = 'ready';
          idle.tag = null;
          this.#clearGuard(idle);
          this.#pump();
          return;
        }
        // The reader asked for the end and got it, or the server ended a
        // session nothing asked it to end.  Either way the reader hears it now
        // rather than at the guard.
        this.#dropIdle(idle);
        this.#pump();
        return;
      }
      const pending = this.#outstanding.find((p) => p.tag === tag);
      if (pending) {
        this.#settle(pending, status as Status, item.line);
        return;
      }
      this.#strayCallback?.(item.line);
      return;
    }

    // Untagged: it belongs to the command that was outstanding, or to the
    // session while one stands.
    const idle = this.#idle;
    if (idle && idle.phase !== 'ready') {
      idle.sink(item.line);
      return;
    }
    this.#outstanding[0]?.accept(item);
    this.#untaggedCallback?.(item.line);
  }

  #settle(pending: Pending, status: Status, line: string): void {
    const at = this.#outstanding.indexOf(pending);
    if (at !== -1) this.#outstanding.splice(at, 1);
    if (pending.timer) clearTimeout(pending.timer);
    pending.answered(status, line);
    this.#schedule();
  }

  /**
   * Act on the current state, and the only place anything is written.
   *
   * The order is the protocol's: a batch that is out has to be answered first;
   * a standing session may only ever be interrupted with DONE, and only when
   * it is open; a session still being entered stands in the batch's way; and
   * with nothing queued, the session opens again — or is dropped once its
   * reader has stopped wanting it.
   */
  #pump(): void {
    if (this.#dead) return;
    const idle = this.#idle;
    if (this.#outstanding.length > 0) return;

    const breaking = idle !== null && (!idle.wanted || this.#queue.length > 0);
    if (idle && idle.phase === 'holding' && breaking) {
      idle.phase = 'draining';
      this.#transport.send('DONE');
      return;
    }

    if (this.#queue.length > 0) {
      // A session being entered, or drained, leaves DONE as the only legal
      // line: the batch waits for its tagged reply.
      if (idle && (idle.phase === 'entering' || idle.phase === 'draining')) return;
      this.#writeBatch();
      return;
    }

    if (!idle) return;
    if (idle.wanted) {
      if (idle.started && idle.phase === 'ready') this.#enterIdle(idle);
      return;
    }
    // Nothing queued, nothing on the wire for it, and the reader is gone.
    // A session still being entered waits for its continuation; the item
    // handler pumps again when it arrives.
    if (idle.phase === 'ready') this.#dropIdle(idle);
  }

  #writeBatch(): void {
    for (const pending of this.#queue.splice(0)) {
      pending.timer = setTimeout(() => this.#timedOut(pending), this.#commandTimeout);
      this.#outstanding.push(pending);
      this.#transport.send(`${pending.tag} ${pending.cmd}`);
    }
  }

  #enterIdle(idle: IdleSession): void {
    idle.tag = this.#nextTag();
    idle.phase = 'entering';
    idle.timer = setTimeout(() => this.#transport.close(), this.#sessionTimeout);
    this.#transport.send(`${idle.tag} IDLE`);
  }

  /** The only thing that ends a session nobody is breaking on purpose. */
  #clearGuard(idle: IdleSession): void {
    if (!idle.timer) return;
    clearTimeout(idle.timer);
    idle.timer = null;
  }

  /** The session is over: its reader is told, and the loop stops counting it. */
  #dropIdle(idle: IdleSession): void {
    if (this.#idle === idle) this.#idle = null;
    this.#clearGuard(idle);
    idle.close();
  }

  /** End a session at its reader's asking: DONE, the tagged reply, and done. */
  async #endIdle(session: IdleSession): Promise<void> {
    if (this.#idle !== session) return; // already over
    session.wanted = false;
    if (session.phase === 'ready') {
      this.#dropIdle(session);
      return;
    }
    const over = session.ended();
    this.#pump();
    await over;
  }

  #nextTag(): string {
    return 'A' + String(++this.#tag).padStart(4, '0');
  }

  /**
   * Writes happen in `#pump`, and a command's write is deferred to the end of
   * the turn: everything asked for in one turn goes out as one batch, which is
   * what makes a batch the unit a session is interrupted for.
   */
  #schedule(): void {
    if (this.#pumpScheduled || this.#dead) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.#pump();
    });
  }

  /**
   * A command ran out of time.  The wire is not trustworthy after that — the
   * reply may still be coming and would be read as the next command's — so the
   * connection is closed, and the commands that shared the batch are told why
   * rather than left to read as a socket that went away on its own.
   */
  #timedOut(pending: Pending): void {
    const what = pending.cmd.slice(0, 50);
    this.#fail(new Error(`Connection closed: ${what} timed out`), {
      pending,
      reason: new Error(`Command timed out: ${what}`),
    });
    this.#transport.close();
  }

  #fail(reason: Error, except?: { pending: Pending; reason: Error }): void {
    const first = !this.#failed;
    this.#failed = true;
    this.#dead = true;

    const idle = this.#idle;
    if (idle) this.#dropIdle(idle);

    for (const pending of this.#outstanding.splice(0)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.fail(except?.pending === pending ? except.reason : reason);
    }
    for (const pending of this.#queue.splice(0)) {
      pending.fail(reason);
    }

    if (first) this.#endCallback?.(reason);
  }
}
