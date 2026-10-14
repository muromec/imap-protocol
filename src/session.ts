import { Transport, type TransportItem } from './transport.ts';

// ── reply collection ───────────────────────────────────────────────────────

/**
 * How one command's reply is read.
 *
 * The loop hands a command's collector every item that arrives while that
 * command is the oldest one outstanding — the IMAP server answers in order,
 * so its untagged lines come before its tagged reply — and the collector
 * decides what belongs to it.  On the tagged OK the loop asks for the result;
 * a NO / BAD is the loop's to reject, not the collector's.
 */
export interface Collector<T> {
  /** One item that arrived while this command was outstanding. */
  accept(item: TransportItem): void;
  /** The command was answered: what came of it. */
  finish(): T;
}

/** The reply as the lines it was — what most commands are. */
export class LinesCollector implements Collector<string[]> {
  readonly lines: string[] = [];

  accept(item: TransportItem): void {
    if (item.kind === 'line') this.lines.push(item.line);
  }

  finish(): string[] {
    return this.lines;
  }
}

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

export interface SessionOptions {
  /** How long a written command may wait for its reply.  Default 30_000. */
  commandTimeout?: number;
}

/**
 * One connection, one loop.
 *
 * The loop is the only reader of the transport's item stream and the only
 * writer on the socket, which is what makes the rest simple: a command that
 * cannot be answered has exactly one place to be failed, and IDLE (when it
 * arrives here) is a state of this machine rather than a parallel path that
 * has to dodge the command path.
 *
 * Commands queue and are written as one batch: everything queued when the
 * previous batch is done goes out together, and each is resolved by its own
 * tag.  Nothing is written while a batch is outstanding, so the reply stream
 * is never read by two commands at once.
 */
export class Session {
  readonly #transport: Transport;
  readonly #commandTimeout: number;

  /** Commands waiting to be written, in the order they were asked for. */
  #queue: Pending[] = [];
  /** Written commands awaiting their tagged reply, oldest first. */
  #outstanding: Pending[] = [];
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
    const tag = 'A' + String(++this.#tag).padStart(4, '0');
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
   * Every line that arrived without being consumed by the command that was
   * outstanding — mailbox updates, and whatever a caller tracks for itself.
   */
  onUntagged(cb: (line: string) => void): void {
    this.#untaggedCallback = cb;
  }

  /**
   * A tagged line whose command nobody owns: an IDLE session's OK, or a server
   * answering something this session never asked.
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

    if (item.kind !== 'line') {
      // A literal or a continuation belongs to the command that asked for it,
      // which is the oldest one outstanding.
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
      const pending = this.#outstanding.find((p) => p.tag === tag);
      if (pending) {
        this.#settle(pending, status as Status, item.line);
        return;
      }
      this.#strayCallback?.(item.line);
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
   * Writes happen in `#pump`, and a command's write is deferred to the end of
   * the turn: everything asked for in one turn goes out as one batch, which is
   * what makes a batch a unit of interruption once IDLE is a state here.
   */
  #schedule(): void {
    if (this.#pumpScheduled || this.#dead) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => {
      this.#pumpScheduled = false;
      this.#pump();
    });
  }

  /** Act on the current state: with nothing outstanding, write what is queued. */
  #pump(): void {
    if (this.#dead || this.#outstanding.length > 0) return;
    for (const pending of this.#queue.splice(0)) {
      pending.timer = setTimeout(() => this.#timedOut(pending), this.#commandTimeout);
      this.#outstanding.push(pending);
      this.#transport.send(`${pending.tag} ${pending.cmd}`);
    }
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
