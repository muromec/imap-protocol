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

  /** Interval (ms) between keepalive IDLE re-entries.  Must be less than
   *  the server's IDLE timeout.  Default 25_000 (25 seconds). */
  keepaliveInterval?: number;

  /** Delay (ms) before reconnecting after a disconnect. Default 3_000. */
  reconnectDelay?: number;

  /** Enable protocol-level debug logging on underlying connections. */
  debug?: boolean;
}

export interface WatcherEvent {
  type: 'connected' | 'disconnected' | 'mail' | 'expunge' | 'fetch' | 'error';
  messages?: FetchedMessage[];
  error?: Error;
}

// ── watcher ────────────────────────────────────────────────────────────────

/**
 * High-level mailbox watcher built on top of Connection.
 *
 * Wraps the low-level IDLE loop with automatic reconnection on disconnect,
 * keepalive IDLE cycling to prevent server timeouts, and a simple
 * event-based API.
 *
 * Usage:
 * ```ts
 * const watcher = new MailboxWatcher(config);
 * watcher.on("mail", (event) => {
 *   for (const msg of event.messages) {
 *     console.log(msg.body);
 *   }
 * });
 * await watcher.start();
 * ```
 */
export class MailboxWatcher extends EventTarget {
  #config: WatcherConfig;
  #abortController: AbortController | null = null;

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

        if (!conn.serverSupports('IDLE')) {
          this.#emit({ type: 'error', error: new Error('Server does not support IDLE') });
          await conn.close();
          return;
        }

        const box = await conn.openBox(mailbox);

        // Fetch whatever is already unseen on first connect.
        const existing = await conn.fetchUnseen();
        if (existing.length > 0) {
          await this.#markSeen(conn, existing);
          this.#emit({ type: 'mail', messages: existing });
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

  /** Stop watching.  The running IDLE session will exit cleanly. */
  stop(): void {
    this.#abortController?.abort();
    this.#abortController = null;
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
      let mailArrived = false;
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
                mailArrived = true;
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
      // If idleEnded is already true (socket closed or mail arrived),
      // the iterator is done and calling return() is unnecessary and
      // may trigger a write to a dead socket.
      if (!idleEnded) await iterator.return?.();

      if (signal.aborted) break;

      // Only fetch if IDLE ended due to a mail event (EXISTS/RECENT
      // with arrived > 0).  If the timer fired or the socket closed,
      // there's nothing new — just cycle back into IDLE.
      if (!mailArrived) continue;

      // Fetch the new messages.
      const unseen = await conn.fetchUnseen();
      if (unseen.length > 0) {
        await this.#markSeen(conn, unseen);
        existingTotal = existingTotal + unseen.length;
        this.#emit({ type: 'mail', messages: unseen });
      }
    }
  }

  async #markSeen(conn: Connection, msgs: FetchedMessage[]): Promise<void> {
    const uids = msgs.map((m) => m.uid);
    if (uids.length === 0) return;
    try {
      await conn.addFlags(uids, '\\Seen');
    } catch {
      // best-effort
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
