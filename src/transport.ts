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

/**
 * Where a debug line goes when the caller named nowhere: the console, which is
 * what this library has always done and what a one-connection process wants.
 */
export function defaultDebugSink(line: string): void {
  console.error(line);
}

// ── items ─────────────────────────────────────────────────────────────────

/**
 * One thing the transport took off the wire, or the connection ending.
 *
 * The session loop reads it: a command's reply and the connection going
 * are steps a loop takes, not notifications it is handed.
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

  #onRawRead: ((raw: string) => void) | null = null;
  #items: TransportItems | null = null;

  #debugEnabled: boolean;
  #debugSink: (line: string) => void;
  #dead = false;
  #writeHooked = false;

  // ── construction ──────────────────────────────────────────────────────

  /**
   * Wrap an already-connected socket.  Called from Connection after
   * `tls.connect()` or `new Socket().connect()` succeeds.
   *
   * @param socket       The connected TCP/TLS socket.
   * @param debugEnabled Initial debug-logging state.
   * @param sink       Where debug lines go.  Default: the console.
   */
  constructor(socket: Socket, debugEnabled = false, sink: (line: string) => void = defaultDebugSink) {
    this.#debugEnabled = debugEnabled;
    this.#debugSink = sink;
    this.#socket = socket;
    if (debugEnabled) this.#hookWrites();

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

  /** Raw-read hook for debug logging — one callback, replaceable. */
  onRawRead(cb: ((raw: string) => void) | null): void {
    this.#onRawRead = cb;
  }

  /**
   * The framing the transport takes off the socket, as a stream.  Created
   * by the first call; the loop reads it, and it starts wherever it starts.
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

  /**
   * Turn protocol logging on or off.
   *
   * The outgoing side is a wrapper around `socket.write`, so switching it on after
   * the connection was made has to install it now: otherwise a caller who turns
   * logging on at runtime sees the server's answers and never the commands.
   */
  setDebug(enabled: boolean): void {
    this.#debugEnabled = enabled;
    if (enabled) this.#hookWrites();
  }

  /** Install the outgoing-side logging, once. */
  #hookWrites(): void {
    if (this.#writeHooked) return;
    this.#writeHooked = true;
    debugSocket(this.#socket, (raw) => this.#debugLog('→', raw));
  }

  #debugLog(kind: string, raw: string): void {
    if (this.#debugEnabled) {
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      this.#debugSink(`[${ts}] [imap] ${kind} ${JSON.stringify(raw)}`);
    }
  }

  // ── query ─────────────────────────────────────────────────────────────

  get dead(): boolean {
    return this.#dead;
  }

  // ── line / literal framing ───────────────────────────────────────────────
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
          this.#items?.push({ kind: 'literal', data });
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
        this.#items?.push({ kind: 'continue', line });
        continue;
      }

      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        this.#items?.push({ kind: 'line', line });
        this.#expectLiteral(Number(litMatch[1]));
        continue;
      }

      this.#items?.push({ kind: 'line', line });
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
    this.#items?.end();
  }

  #onSocketError(e: Error): void {
    if (this.#dead) return;
    this.#dead = true;
    this.#debugLog('socket', `error: ${e.message}`);
    this.#items?.end(e);
  }
}
