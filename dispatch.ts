import { Transport } from "./transport.ts";

// ── types ──────────────────────────────────────────────────────────────────

interface PendingEntry {
  resolve: (lines: string[]) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// ── constants ──────────────────────────────────────────────────────────────

const RE_TAGGED = /^(A\d+) (OK|NO|BAD) /;

// ── CommandDispatcher ──────────────────────────────────────────────────────

/**
 * Pairs tagged IMAP commands with their responses.
 *
 * Sends a command with a unique tag on the underlying Transport, collects
 * untagged lines that arrive before the matching tagged OK / NO / BAD,
 * and resolves (or rejects) the per-command promise.
 *
 * The dispatcher has no knowledge of IMAP semantics — it does not know
 * what LOGIN, SELECT, FETCH, or IDLE mean.  Untagged lines that are NOT
 * consumed by a pending tagged response are forwarded to the `onUntagged`
 * callback, which the Session layer uses to implement IMAP-specific
 * state machines (mailbox updates, fetch parsing, idle events).
 */
export class CommandDispatcher {
  readonly #transport: Transport;
  readonly #defaultTimeout: number;

  #tag = 0;
  #pending = new Map<string, PendingEntry>();
  #untagged: string[] = [];

  #untaggedCallback: ((line: string) => void) | null = null;
  #deadCallback: (() => void) | null = null;
  #dead = false;

  // ── construction ──────────────────────────────────────────────────────

  /**
   * @param transport       The connected Transport to send on and receive from.
   * @param defaultTimeout  Per-command timeout in ms.
   */
  constructor(transport: Transport, defaultTimeout: number) {
    this.#transport = transport;
    this.#defaultTimeout = defaultTimeout;

    transport.onLine((line) => this.#onLine(line));
    transport.onClose(() => { this.#onTransportDead(new Error("Socket closed")) });
    transport.onError((e) => this.#onTransportDead(e));
  }

  // ── public API ────────────────────────────────────────────────────────

  /** Generate a fresh tag without sending anything.  Used by IDLE. */
  nextTag(): string {
    return this.#nextTag();
  }

  /**
   * Register a pending entry for a command whose tagged response will
   * arrive later (used by IDLE).  The caller is responsible for sending
   * the command and clearing the pending entry when done.
   */
  registerPending(tag: string, onTimeout: () => void): void {
    const timer = setTimeout(() => {
      this.#pending.delete(tag);
      onTimeout();
    }, this.#defaultTimeout);
    this.#pending.set(tag, { resolve: () => {}, reject: () => {}, timer });
  }

  /** Send a raw tagged command without registering a pending entry. */
  sendRaw(tag: string, cmd: string): void {
    this.#transport.send(tag + " " + cmd);
  }

  /**
   * Send a tagged command.  Returns the untagged lines that arrived
   * before the matching tagged OK.  Rejects on tagged NO / BAD or
   * timeout.
   */
  sendCommand(cmd: string): Promise<string[]> {
    if (this.#dead) return Promise.reject(new Error("Connection is dead"));
    const tag = this.#nextTag();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(tag);
        this.#transport.close();
        reject(new Error(`Command timed out: ${cmd.slice(0, 50)}`));
      }, this.#defaultTimeout);
      this.#pending.set(tag, { resolve, reject, timer });
      this.#untagged = [];
      this.#transport.send(tag + " " + cmd);
    });
  }

  /**
   * Callback for untagged lines that are not consumed by a pending
   * tagged command.  The Session layer uses this for mailbox updates,
   * fetch response parsing, and idle events.
   */
  onUntagged(cb: (line: string) => void): void {
    this.#untaggedCallback = cb;
  }

  /**
   * Called when the transport dies.  The Session layer can hook this
   * to clean up its own state (idle resolvers, fetch state, etc.).
   */
  onDead(cb: () => void): void {
    this.#deadCallback = cb;
  }

  /** Whether the transport has been closed or errored out. */
  get dead(): boolean {
    return this.#dead;
  }

  // ── internals ─────────────────────────────────────────────────────────

  #nextTag(): string {
    return "A" + String(++this.#tag).padStart(4, "0");
  }

  #onLine(line: string): void {
    const tagged = line.match(RE_TAGGED);
    if (tagged) {
      const [, tag, status] = tagged;
      const p = this.#pending.get(tag);
      if (!p) {
        // Stray tagged response — forward to the Session layer so idle
        // hooks can detect the tagged OK for DONE and other unmatched
        // tagged responses.
        this.#untaggedCallback?.(line);
        return;
      }
      this.#pending.delete(tag);
      clearTimeout(p.timer);

      if (status === "OK") {
        p.resolve([...this.#untagged]);
      } else {
        p.reject(new Error(status + ": " + line));
      }
      return;
    }

    // Untagged line — collect it for the current command AND forward
    // to the Session layer for IMAP-specific processing.
    this.#untagged.push(line);
    this.#untaggedCallback?.(line);
  }

  #onTransportDead(err: Error): void {
    if (this.#dead) return;
    this.#dead = true;

    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();

    this.#deadCallback?.();
  }
}
