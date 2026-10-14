// Mock IMAP server for testing imap-connector.
//
// Binds to a random local port (plain TCP, no TLS — the client connects
// with `tls: false`).  Accepts one connection, then replays a pre-configured
// scenario of expected commands and canned responses.
//
// Designed to catch regressions in the Connection class without touching
// a real mailbox.

import { createServer, type Server, type Socket } from 'node:net';

const CRLF = '\r\n';

// ── types ──────────────────────────────────────────────────────────────────

export interface ScenarioStep {
  /** Regex to match against the client's command (including the tag). */
  expect: RegExp;
  /**
   * Response to send back.
   * - string          → sent as a single line.
   * - string[]        → each element is one line (CRLF appended automatically).
   * - ((cmd: string) => string | string[]) → dynamic response.
   */
  respond: string | string[] | ((cmd: string) => string | string[]);
}

export interface ScenarioOptions {
  /** If true, unexpected commands are silently ignored instead of throwing. */
  allowExtra?: boolean;
  /** Greeting sent when a client connects. */
  greeting?: string;
  /**
   * Answer every IDLE with a continuation, and idle again after each DONE, forever.
   * `allowExtra` alone is not enough for a watcher: an IDLE has to be answered with
   * `+ idling`, never a tagged OK, or the client refuses the continuation.
   */
  idleLoop?: boolean;
  /**
   * Emulate a server's own IDLE limit: a session that has not sent DONE within this
   * many milliseconds of its continuation is answered `BAD Expected DONE` — what a
   * real server does when the client never finishes what it started.
   */
  idleLimitMs?: number;
}

// ── server ─────────────────────────────────────────────────────────────────

export class MockImapServer {
  #server: Server;
  #socket: Socket | null = null;
  #buf = '';
  #step = 0;
  #scenario: ScenarioStep[] = [];
  #options: ScenarioOptions = {};
  #resolveScenario: (() => void) | null = null;
  #rejectScenario: ((e: Error) => void) | null = null;
  #scenarioPromise: Promise<void> | null = null;
  #idleTag: string | null = null;

  /** The port the server is listening on. Set once listening resolves. */
  port!: number;

  /** Resolves when the server is listening. */
  readonly listening: Promise<number>;

  /** Every command line the client sent, in order (DONE included). */
  readonly received: string[] = [];
  /** How many connections were accepted. */
  connections = 0;
  /** How many IDLE sessions the client entered. */
  idles = 0;
  /** How many DONE lines arrived. */
  dones = 0;
  /** How many IDLE sessions the server gave up on. */
  badDones = 0;

  #idleWaiters: Array<{ n: number; resolve: () => void }> = [];
  #outcomeWaiters: Array<(outcome: 'done' | 'bad') => void> = [];

  /** Resolves once the client has entered IDLE `n` times (once by default). */
  idled(n = 1): Promise<void> {
    if (this.idles >= n) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push({ n, resolve }));
  }

  /** Resolves with the next end of an IDLE session, and how it ended. */
  nextIdleOutcome(): Promise<'done' | 'bad'> {
    return new Promise((resolve) => this.#outcomeWaiters.push(resolve));
  }

  #noteIdle(): void {
    this.idles++;
    const waiting = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const waiter of waiting) {
      if (this.idles >= waiter.n) waiter.resolve();
      else this.#idleWaiters.push(waiter);
    }
  }

  #noteOutcome(outcome: 'done' | 'bad'): void {
    for (const resolve of this.#outcomeWaiters.splice(0)) resolve(outcome);
  }

  /** Give the client `idleLimitMs` to send DONE before the server gives up. */
  #armIdleLimit(tag: string): void {
    const limit = this.#options.idleLimitMs;
    if (!limit) return;
    setTimeout(() => {
      if (this.#idleTag !== tag) return;
      this.#idleTag = null;
      this.badDones++;
      this.#sendRaw(`${tag} BAD Expected DONE${CRLF}`);
      this.#noteOutcome('bad');
    }, limit);
  }

  /** The untagged lines a command needs before its tagged OK, standing in for a real server. */
  #untaggedFor(tag: string, line: string): string {
    if (line === `${tag} CAPABILITY`) return `* CAPABILITY IMAP4rev1 UIDPLUS MOVE IDLE${CRLF}`;
    if (line === `${tag} SELECT "INBOX"` || line === `${tag} SELECT INBOX`) {
      return `* 0 EXISTS${CRLF}* OK [UIDVALIDITY 1] done${CRLF}`;
    }
    if (line.startsWith(`${tag} UID SEARCH `)) return `* SEARCH${CRLF}`;
    return '';
  }

  constructor() {
    this.#server = createServer((socket) => this.#onConnection(socket));

    // don't crash the process on socket errors in tests
    this.#server.on('error', () => {});

    this.listening = new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        this.port = (this.#server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  // ── public API ─────────────────────────────────────────────────────────

  /**
   * Configure the scenario.  Must be called before connect().
   * Returns a promise that resolves when all steps have been matched
   * (or rejects on unexpected command / early disconnect).
   */
  scenario(steps: ScenarioStep[], options: ScenarioOptions = {}): void {
    this.#scenario = steps;
    this.#options = options;
    this.#step = 0;
    this.#buf = '';
    this.#socket = null;

    this.#scenarioPromise = new Promise((resolve, reject) => {
      this.#resolveScenario = resolve;
      this.#rejectScenario = reject;
    });
  }

  /** Wait for the scenario to complete (or fail). */
  async wait(): Promise<void> {
    return this.#scenarioPromise ?? Promise.resolve();
  }

  /** Shut down the server and close any open socket. */
  close(): void {
    this.#rejectScenario = null;
    this.#socket?.end();
    this.#server.close();
  }

  // ── connection handling ────────────────────────────────────────────────

  #onConnection(socket: Socket): void {
    this.#socket = socket;
    this.connections++;
    socket.on('data', (chunk: Buffer) => this.#onData(chunk.toString('utf8')));
    socket.on('error', () => {});
    socket.on('close', () => {
      // Only reject if the scenario hasn't already resolved,
      // and only if the server isn't in allowExtra mode (cleanup race).
      if (this.#step < this.#scenario.length && this.#rejectScenario && !this.#options.allowExtra) {
        // Delay: let the scenario promise settle naturally if commands are
        // still being processed before the socket fully closes.
        setImmediate(() => {
          if (
            this.#step < this.#scenario.length &&
            this.#rejectScenario &&
            !this.#options.allowExtra
          ) {
            this.#rejectScenario(
              new Error(
                `Socket closed before scenario finished (step ${this.#step}/${this.#scenario.length})`,
              ),
            );
          }
        });
      }
    });

    // Defer the greeting until scenario() has configured this connection.
    setImmediate(() => {
      this.#sendRaw((this.#options.greeting ?? '* OK mock IMAP server ready') + CRLF);
    });
  }

  // ── I/O ────────────────────────────────────────────────────────────────

  #sendRaw(data: string): void {
    this.#socket?.write(data, 'utf8');
  }

  /**
   * Send a response that may contain literal data.
   *
   * Each element is one "IMAP line" (ends with CRLF), EXCEPT when the
   * previous element contains a literal marker `{size}` — in that case
   * the next element is sent as raw literal data (no trailing CRLF added),
   * followed by a CRLF after it.
   */
  #sendMulti(response: string | string[]): void {
    const lines = Array.isArray(response) ? response : [response];
    for (let i = 0; i < lines.length; i++) {
      const prev = i > 0 ? lines[i - 1] : null;
      const isLiteral =
        prev !== null &&
        /\{\d+\}$/.test(prev) &&
        !prev.includes('OK') &&
        !prev.includes('NO') &&
        !prev.includes('BAD') &&
        !prev.includes('SEARCH');

      if (isLiteral) {
        // Raw literal data — the reader consumes exactly {size} bytes,
        // then expects a trailing CRLF.
        this.#sendRaw(lines[i] + CRLF);
      } else {
        this.#sendRaw(lines[i] + CRLF);
      }
    }
  }

  #onData(raw: string): void {
    this.#buf += raw;

    // process complete lines (commands end with CRLF)
    let idx: number;
    while ((idx = this.#buf.indexOf(CRLF)) !== -1) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 2);
      if (line.trim()) {
        this.#handleCommand(line);
      }
    }
  }

  // ── command dispatch ───────────────────────────────────────────────────

  #handleCommand(cmd: string): void {
    this.received.push(cmd.trim());

    // DONE is sent without a tag to exit IDLE.  Handle it here, before the
    // watcher-style branch and the scenario matching below: it has no tag and is not
    // part of the expected step list.
    if (cmd.trim() === 'DONE' && this.#idleTag !== null) {
      this.dones++;
      this.#noteOutcome('done');
      this.#sendRaw(`${this.#idleTag} OK IDLE completed` + CRLF);
      this.#idleTag = null;
      if (this.#step >= this.#scenario.length) {
        this.#resolveScenario?.();
      }
      return;
    }

    // A watcher-style run: every IDLE is accepted, every other command is answered,
    // and a session ends only when DONE arrives — or when the limit above gives up on
    // it.  CAPABILITY still carries the untagged line the client reads.
    if (this.#options.idleLoop) {
      const idleMatch = cmd.match(/^(A\d+) IDLE$/);
      if (idleMatch) {
        this.#idleTag = idleMatch[1];
        this.#sendRaw(`+ idling${CRLF}`);
        this.#noteIdle();
        this.#armIdleLimit(idleMatch[1]);
        return;
      }
      const tag = cmd.match(/^(A\d+) /)?.[1];
      if (tag) {
        const untagged = this.#untaggedFor(tag, cmd.trim());
        this.#sendRaw(`${untagged}${tag} OK done${CRLF}`);
      }
      return;
    }

    if (this.#step >= this.#scenario.length) {
      if (!this.#options.allowExtra) {
        this.#rejectScenario = null;
        this.#socket?.destroy(new Error(`Unexpected command after scenario finished: ${cmd}`));
        return;
      }
      // auto-respond with a tagged OK so the client's sendCommand resolves
      const tagMatch = cmd.match(/^(A\d+) /);
      if (tagMatch) {
        this.#sendRaw(`${tagMatch[1]} OK auto` + CRLF);
      }
      return;
    }

    const step = this.#scenario[this.#step];
    if (!step.expect.test(cmd.trim())) {
      if (!this.#options.allowExtra) {
        this.#rejectScenario = null;
        this.#socket?.destroy(
          new Error(
            `Command mismatch at step ${this.#step}:\n` +
              `  expected: ${step.expect}\n` +
              `  got:      ${cmd}`,
          ),
        );
        return;
      }
      // auto-respond with a tagged OK so the client's sendCommand resolves
      const tagMatch = cmd.match(/^(A\d+) /);
      if (tagMatch) {
        this.#sendRaw(`${tagMatch[1]} OK auto` + CRLF);
      }
      return;
    }

    this.#step++;

    const tagMatch = cmd.match(/^(A\d+) /);
    const tag = tagMatch ? tagMatch[1] : 'A0000';

    const response = typeof step.respond === 'function' ? step.respond(cmd) : step.respond;

    // Check if the response starts with a continuation marker (+).
    // If so, send it as a continuation (no auto-tagged OK) and enter
    // a special mode where subsequent untagged lines are served from
    // a queue until the client sends DONE.
    const lines = Array.isArray(response) ? response : [response];
    const firstLine = lines[0] ?? '';
    if (firstLine.startsWith('+')) {
      // Send the continuation line.
      this.#sendRaw(firstLine + CRLF);

      // Remaining lines are untagged events to send while idling.
      const events = lines.slice(1);
      for (const ev of events) {
        this.#sendRaw(ev + CRLF);
      }

      // Store tag for when DONE arrives.
      this.#idleTag = tag;
      this.#noteIdle();
      this.#armIdleLimit(tag);
      // Don't send tagged OK — the IDLE command stays open until DONE.
      // Don't call #resolveScenario yet — scenario completes on DONE.
      return;
    }

    this.#sendMulti(lines);

    // Append tagged OK completion if the response doesn't already include one.
    // Each command (except IDLE) must be terminated by a tagged OK/NO/BAD.
    const lastLine = lines[lines.length - 1] ?? '';
    if (!/^A\d+ (OK|NO|BAD) /.test(lastLine)) {
      this.#sendRaw(`${tag} OK done` + CRLF);
    }

    // all steps done?
    if (this.#step >= this.#scenario.length) {
      this.#resolveScenario?.();
    }
  }
}
