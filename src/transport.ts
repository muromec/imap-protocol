import { Socket } from 'node:net';

const CRLF = '\r\n';

/**
 * Thin wrapper that intercepts outgoing writes for debug logging.
 */
function debugSocket(socket: Socket, onWrite: (raw: string) => void): Socket {
  const origWrite = socket.write.bind(socket);
  socket.write = function (data: string | Buffer, ...rest: any[]) {
    onWrite(typeof data === 'string' ? data : data.toString('utf8'));
    return origWrite(data, ...rest);
  } as typeof socket.write;
  return socket;
}

// ── items ─────────────────────────────────────────────────────────────────

/**
 * One thing the transport took off the wire, or the connection ending.
 *
 * The callbacks below are the older view of the same framing; a session loop
 * reads this stream instead, because a command's reply and the connection
 * going are both steps a loop takes, not notifications it is handed.
 */
export type TransportItem =
  | { kind: 'line'; line: string }
  | { kind: 'continue'; line: string }
  | { kind: 'literal'; data: string }
  | { kind: 'ended'; error?: Error };

/**
 * The item stream: pushed by the framing code, pulled by one reader.
 *
 * `ended` is delivered as the last item, so a `for await` reader sees the
 * connection go rather than falling out of the loop without knowing why; the
 * call after it reports the iteration finished.  Items that arrive before a
 * reader starts are held in order — a stream nobody reads is a buffer, not a
 * loss, and there is one reader by construction.
 */
export class TransportItems implements AsyncIterable<TransportItem> {
  #queue: TransportItem[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  #finished = false;

  push(item: TransportItem): void {
    if (this.#ended) return;
    this.#queue.push(item);
    this.#wakeNow();
  }

  end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#queue.push({ kind: 'ended', error });
    this.#wakeNow();
  }

  async next(): Promise<IteratorResult<TransportItem>> {
    while (this.#queue.length === 0) {
      if (this.#finished) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
    const item = this.#queue.shift()!;
    if (item.kind === 'ended') this.#finished = true;
    return { done: false, value: item };
  }

  [Symbol.asyncIterator](): AsyncIterator<TransportItem> {
    return { next: () => this.next() };
  }

  #wakeNow(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

// ── Transport ─────────────────────────────────────────────────────────────

/**
 * Low-level IMAP transport — owns the socket and turns the TCP byte
 * stream into framed lines / literals / continuations.
 *
 * The Transport has no knowledge of IMAP semantics (tags, OK / NO / BAD,
 * mailbox state, etc.).  It only knows about CRLF-delimited lines,
 * `{size}` literal synchronisation, and `+` continuation lines.
 */
export class Transport {
  readonly #socket: Socket;
  #buf = '';
  #literalRemaining = 0;
  #literalChunks: string[] = [];

  #lineCallback: ((line: string) => void) | null = null;
  #literalCallback: ((data: string) => void) | null = null;
  #continueCallback: ((line: string) => void) | null = null;
  #closeCallback: (() => void) | null = null;
  #errorCallback: ((err: Error) => void) | null = null;
  #onRawRead: ((raw: string) => void) | null = null;
  #items: TransportItems | null = null;

  #debugEnabled: boolean;
  #dead = false;

  // ── construction ──────────────────────────────────────────────────────

  /**
   * Wrap an already-connected socket.  Called from Connection after
   * `tls.connect()` or `new Socket().connect()` succeeds.
   *
   * @param socket       The connected TCP/TLS socket.
   * @param debugEnabled Initial debug-logging state.
   */
  constructor(socket: Socket, debugEnabled = false) {
    this.#debugEnabled = debugEnabled;
    if (debugEnabled) {
      debugSocket(socket, (raw) => this.#debugLog('→', raw));
    }
    this.#socket = socket;

    socket.on('data', (chunk: Buffer) => {
      const raw = chunk.toString('utf8');
      this.#onRawRead?.(raw);
      this.#onData(raw);
    });

    socket.on('close', () => this.#onSocketClose());
    socket.on('error', (e: Error) => {
      // ECONNRESET is a normal TCP teardown artifact — ignore it.
      if ((e as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      this.#onSocketError(e);
    });
  }

  // ── public callbacks (single-slot each) ───────────────────────────────

  onLine(cb: (line: string) => void): void {
    this.#lineCallback = cb;
  }

  onLiteral(cb: (data: string) => void): void {
    this.#literalCallback = cb;
  }

  /** IMAP continuation lines (starting with `+`). */
  onContinue(cb: (line: string) => void): void {
    this.#continueCallback = cb;
  }

  onClose(cb: () => void): void {
    this.#closeCallback = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.#errorCallback = cb;
  }

  /** Raw-read hook for debug logging — one callback, replaceable. */
  onRawRead(cb: ((raw: string) => void) | null): void {
    this.#onRawRead = cb;
  }

  /**
   * The same framing the callbacks receive, as a stream.  Created by the
   * first call; one reader, and it starts wherever it starts.
   */
  items(): AsyncIterable<TransportItem> {
    this.#items ??= new TransportItems();
    return this.#items;
  }

  // ── outbound ──────────────────────────────────────────────────────────

  /**
   * Send raw bytes.  CRLF is appended automatically — callers should
   * NOT include it.
   */
  send(raw: string): void {
    this.#socket.write(raw + CRLF, 'utf8');
  }

  /** Gracefully close the underlying socket. */
  close(): void {
    this.#dead = true;
    this.#socket.end();
  }

  // ── debug ─────────────────────────────────────────────────────────────

  setDebug(enabled: boolean): void {
    this.#debugEnabled = enabled;
  }

  #debugLog(kind: string, raw: string): void {
    if (this.#debugEnabled) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.error(`[${ts}] [imap] ${kind} ${JSON.stringify(raw)}`);
    }
  }

  // ── query ─────────────────────────────────────────────────────────────

  get dead(): boolean {
    return this.#dead;
  }

  // ── line / literal framing (moved from old ImapReader) ────────────────
  // The framing pushes each item beside the callbacks, so both views see the
  // same lines while the loop is built next to them.
  #emitLine(line: string): void {
    this.#lineCallback?.(line);
    this.#items?.push({ kind: 'line', line });
  }

  #emitContinue(line: string): void {
    this.#continueCallback?.(line);
    this.#items?.push({ kind: 'continue', line });
  }

  #emitLiteral(data: string): void {
    this.#literalCallback?.(data);
    this.#items?.push({ kind: 'literal', data });
  }

  #onData(raw: string): void {
    this.#buf += raw;
    this.#drain();
  }

  #drain(): void {
    while (true) {
      if (this.#literalRemaining > 0) {
        if (this.#buf.length === 0) return;
        const take = Math.min(this.#literalRemaining, this.#buf.length);
        this.#literalChunks.push(this.#buf.slice(0, take));
        this.#literalRemaining -= take;
        this.#buf = this.#buf.slice(take);

        if (this.#literalRemaining === 0) {
          const data = this.#literalChunks.join('');
          this.#literalChunks = [];
          this.#emitLiteral(data);
          if (this.#buf.startsWith(CRLF)) {
            this.#buf = this.#buf.slice(2);
          }
          continue;
        }
        return;
      }

      const idx = this.#buf.indexOf(CRLF);
      if (idx === -1) return;

      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 2);

      if (!line) continue;

      if (line.startsWith('+')) {
        this.#emitContinue(line);
        continue;
      }

      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        this.#emitLine(line);
        this.#expectLiteral(Number(litMatch[1]));
        continue;
      }

      this.#emitLine(line);
    }
  }

  #expectLiteral(size: number): void {
    this.#literalRemaining = size;
    this.#literalChunks = [];
  }

  // ── socket event handlers ─────────────────────────────────────────────

  #onSocketClose(): void {
    this.#dead = true;
    this.#debugLog('socket', 'closed');
    this.#closeCallback?.();
    this.#items?.end();
  }

  #onSocketError(e: Error): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#debugLog('socket', `error: ${e.message}`);
    this.#errorCallback?.(e);
    this.#items?.end(e);
  }
}
