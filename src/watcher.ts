import { Connection } from './connection.ts';
import { type FetchedMessage } from './interface.ts';

// ── types ──────────────────────────────────────────────────────────────────

export interface WatcherConfig {
  /** IMAP connection config (passed through to Connection). */
  user: string;
  password: string;
  host: string;
  port: number;
  tls?: boolean;

  /** Mailbox to watch. Default "INBOX". */
  mailbox?: string;

  /** Flag each message `\Seen` once it has been handed over.  Default true:
   *  set false to leave that decision to the caller, which flags through
   *  {@link MailboxWatcher.connection} instead. */
  markSeen?: boolean;

  /** Interval (ms) between keepalive IDLE re-entries.  Must be less than
   *  the server's IDLE timeout.  Default 25_000 (25 seconds). */
  keepaliveInterval?: number;

  /** Delay (ms) before reconnecting after a disconnect. Default 3_000. */
  reconnectDelay?: number;

  /** Enable protocol-level debug logging on underlying connections. */
  debug?: boolean;
}

export interface WatcherEvent {
  type: 'connected' | 'disconnected' | 'mail' | 'error';
  messages?: FetchedMessage[];
  error?: Error;
}

// ── watcher ────────────────────────────────────────────────────────────────

/**
 * High-level mailbox watcher built on top of Connection.
 *
 * Wraps the low-level IDLE loop with automatic reconnection on disconnect,
 * keepalive IDLE cycling to prevent server timeouts, and raw fetched
 * messages.  Parsing a message is the caller's business.  By default the
 * watcher also flags each message `\Seen`, after handing it over and never
 * before; `markSeen: false` leaves that decision to the caller, which flags
 * through {@link MailboxWatcher.connection}.
 *
 * Usage:
 * ```ts
 * const watcher = new MailboxWatcher(config);
 * watcher.on('mail', (event) => {
 *   for (const msg of event.messages ?? []) {
 *     console.log(msg.body);
 *   }
 * });
 * await watcher.start();
 * ```
 */
export class MailboxWatcher extends EventTarget {
  #config: WatcherConfig;
  #abortController: AbortController | null = null;
  #activeConn: Connection | null = null;

  constructor(config: WatcherConfig) {
    super();
    this.#config = config;
  }

  // ── public API ──────────────────────────────────────────────────────────

  /** Start watching.  Resolves when the first connection succeeds.
   *  Runs until `stop()` is called. */
  async start(): Promise<void> {
    if (this.#abortController) return; // already running
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    const mailbox = this.#config.mailbox ?? 'INBOX';
    const keepalive = this.#config.keepaliveInterval ?? 25_000;
    const reconnectDelay = this.#config.reconnectDelay ?? 3_000;

    while (!signal.aborted) {
      let conn: Connection | null = null;
      this.#activeConn = null;
      try {
        conn = new Connection({
          user: this.#config.user,
          password: this.#config.password,
          host: this.#config.host,
          port: this.#config.port,
          tls: this.#config.tls ?? true,
          debug: this.#config.debug,
        });

        await conn.connect();
        this.#activeConn = conn;

        if (!conn.serverSupports('IDLE')) {
          this.#emit({
            type: 'error',
            error: new Error('Server does not support IDLE'),
          });
          await conn.close();
          return;
        }

        const box = await conn.openBox(mailbox);

        // Fetch whatever is already unseen on first connect.
        const existing = await conn.fetchUnseen();
        if (existing.length > 0) {
          this.#emit({ type: 'mail', messages: existing });
          await this.#markSeen(conn, existing);
        }

        this.#emit({ type: 'connected' });

        // Enter the IDLE loop for this connection.
        await this.#idleLoop(conn, box.total, keepalive, signal);

        await conn.close();
      } catch (err) {
        if (signal.aborted) break;
        this.#emit({ type: 'error', error: err as Error });
        try {
          await conn?.close();
        } catch {}
      }

      if (signal.aborted) break;
      await this.#sleep(reconnectDelay, signal);
    }
  }

  /** Stop watching.  Closes the active connection and aborts the loop. */
  stop(): void {
    this.#activeConn?.close().catch(() => {});
    this.#activeConn = null;
    this.#abortController?.abort();
    this.#abortController = null;
  }
  /**
   * The connection in use, or null between attempts.
   *
   * Exposed so a caller can decide a message's fate — flag it read when it
   * chooses to, which is the one thing this loop no longer decides for it.
   */
  get connection(): Connection | null {
    return this.#activeConn;
  }


  // ── events ──────────────────────────────────────────────────────────────

  on(
    type: 'mail' | 'connected' | 'disconnected' | 'error',
    listener: (event: WatcherEvent) => void,
  ): void {
    this.addEventListener(type, (e) => listener((e as CustomEvent<WatcherEvent>).detail));
  }

  #emit(event: WatcherEvent): void {
    this.dispatchEvent(new CustomEvent(event.type, { detail: event }));
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Run the IDLE loop on a connected, mailbox-selected Connection.
   * Re-enters IDLE every `keepalive` ms to prevent server timeouts.
   * Returns when `signal` is aborted or the socket closes.
   */
  async #idleLoop(
    conn: Connection,
    initialTotal: number,
    keepalive: number,
    signal: AbortSignal,
  ): Promise<void> {
    let existingTotal = initialTotal;

    while (!signal.aborted) {
      // Race: IDLE events vs keepalive timer.
      let idleEnded = false;
      const iterator = conn.idle()[Symbol.asyncIterator]();

      const idlePromise = (async () => {
        for (;;) {
          const { value: event, done } = await iterator.next();
          if (done) break;
          if (signal.aborted) break;

          switch (event.type) {
            case 'exists':
            case 'recent': {
              const count = event.count ?? 0;
              const arrived = count - existingTotal;
              existingTotal = count;
              if (arrived > 0) {
                idleEnded = true;
                return; // exit to fetch below
              }
              break;
            }
            case 'expunge':
              existingTotal = Math.max(0, existingTotal - 1);
              break;
            case 'fetch':
            case 'flags':
              break;
          }
        }
        idleEnded = true;
      })();

      const keepalivePromise = this.#sleep(keepalive, signal).then(() => {
        // Timer fired — break out of IDLE to cycle it.
        if (!idleEnded) iterator.return?.();
      });

      await Promise.race([idlePromise, keepalivePromise]);

      // Exit IDLE cleanly if it hasn't already ended (timed out).
      if (!idleEnded) await iterator.return?.();

      if (signal.aborted) break;

      // If the connection died during the DONE/drain phase (server
      // closed the socket), return so the outer loop reconnects.
      if (conn.dead) return;

      // Always fetch unseen after idle ends.  Mail may have arrived
      // during a keepalive cycle or while we were reconnecting.
      const unseen = await conn.fetchUnseen();
      if (unseen.length > 0) {
        existingTotal = existingTotal + unseen.length;
        this.#emit({ type: 'mail', messages: unseen });
        await this.#markSeen(conn, unseen);
      }
    }
  }

  /**
   * Flag a delivered batch `\Seen`, after the caller has been given it, and only
   * when `markSeen` allows.  A refused flag is reported: the message is already
   * in the caller's hands, so a swallow here is invisible on both sides.
   */
  async #markSeen(conn: Connection, msgs: FetchedMessage[]): Promise<void> {
    if (this.#config.markSeen === false) return;
    const uids = msgs.map((m) => m.uid);
    if (uids.length === 0) return;
    try {
      await conn.addFlags(uids, '\\Seen');
    } catch (err) {
      this.#emit({
        type: 'error',
        error: new Error(
          `could not flag ${uids.length} delivered message(s) as seen: ${(err as Error).message}`,
        ),
      });
    }
  }

  #sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
