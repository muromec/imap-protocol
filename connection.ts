import tls from "node:tls";
import { Socket } from "node:net";

// ── types ──────────────────────────────────────────────────────────────────

export interface ImapConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  /** Use implicit TLS (port 993). Default true. Set false for plain TCP. */
  tls?: boolean;
  /** TLS options passed to tls.connect(). */
  tlsOptions?: tls.ConnectionOptions;
  /**
   * STARTTLS upgrade strategy.
   * - "always": attempt STARTTLS if server supports it
   * - "required": require STARTTLS, throw if unavailable
   * - undefined: never attempt STARTTLS (only use implicit TLS or plain)
   */
  autotls?: "always" | "required";
  /** Timeout for TLS handshake + server greeting (ms). Default 30_000. */
  connTimeout?: number;
  /** Timeout for LOGIN response (ms). Default 10_000. */
  authTimeout?: number;
  /** Per-command timeout (ms). Default 30_000. */
  commandTimeout?: number;
  /**
   * Enable protocol-level debug logging to stderr.
   * Logs every byte read/written and every line dispatched.
   * Can be toggled at runtime via conn.setDebug(bool).
   */
  debug?: boolean;
}

export interface MailboxInfo {
  name: string;
  total: number;
  unseen: number;
  uidvalidity: number;
  uidnext: number;
  flags: string[];
}

export interface FetchedMessage {
  uid: number;
  seqno: number;
  body: string;
  flags: string[];
}

export interface IdleEvent {
  type: "exists" | "recent" | "expunge" | "fetch" | "flags";
  seqno?: number;
  count?: number;
  uid?: number;
  flags?: string[];
}

// ── IMAP protocol constants ────────────────────────────────────────────────

const CRLF = "\r\n";
const RE_TAGGED = /^(A\d+) (OK|NO|BAD) /;
const RE_EXISTS = /^\* (\d+) EXISTS/;
const RE_RECENT = /^\* (\d+) RECENT/;
const RE_FLAGS = /^\* FLAGS \((.*)\)/;
const RE_SEARCH = /^\* SEARCH (.*)/;
const RE_FETCH_START = /^\* (\d+) FETCH \((.*)/;
const RE_CAPABILITY = /^\* CAPABILITY (.*)/i;

// ── line-oriented buffered reader ──────────────────────────────────────────

/**
 * Wraps a socket and yields complete IMAP lines / literals.
 *
 * Normal lines end with CRLF.  When a line contains a literal marker
 * `{<size>}` at the end, the reader switches to "literal mode" and
 * accumulates exactly `<size>` bytes before resuming line mode.
 *
 * Lines starting with `+` are IMAP continuations and are routed to
 * `onContinue` rather than `onLine`.
 */
function debugSocket(socket: Socket, prefix: string, onWrite: (raw: string) => void): Socket {
  const origWrite = socket.write.bind(socket);
  socket.write = function (data: string | Buffer, ...rest: any[]) {
    onWrite(typeof data === "string" ? data : data.toString("utf8"));
    return origWrite(data, ...rest);
  } as typeof socket.write;
  return socket;
}

class ImapReader {
  #socket: Socket;
  #buf = "";
  #literalRemaining = 0;
  #literalChunks: string[] = [];
  #lineCallback: ((line: string) => void) | null = null;
  #literalCallback: ((data: string) => void) | null = null;
  #continueCallback: ((line: string) => void) | null = null;
  #onRawRead: ((raw: string) => void) | null = null;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      const raw = chunk.toString("utf8");
      this.#onRawRead?.(raw);
      this.#onData(raw);
    });
  }

  /** Set a callback for raw socket reads (debug logging). */
  onRawRead(cb: ((raw: string) => void) | null): void {
    this.#onRawRead = cb;
  }

  onLine(cb: (line: string) => void): void {
    this.#lineCallback = cb;
  }

  onLiteral(cb: (data: string) => void): void {
    this.#literalCallback = cb;
  }

  /** Callback for IMAP continuation lines (starting with `+`). */
  onContinue(cb: (line: string) => void): void {
    this.#continueCallback = cb;
  }

  /**
   * Feed a literal that we already know the size of (from a fetch line).
   * The next `size` bytes from the socket will be delivered to the
   * literal callback instead of the line callback.
   */
  expectLiteral(size: number): void {
    this.#literalRemaining = size;
    this.#literalChunks = [];
  }

  // ── internals ──────────────────────────────────────────────────────────

  #onData(raw: string): void {
    this.#buf += raw;
    this.#drain();
  }

  #drain(): void {
    while (true) {
      if (this.#literalRemaining > 0) {
        // we are inside a literal — consume bytes
        if (this.#buf.length === 0) return;
        const take = Math.min(this.#literalRemaining, this.#buf.length);
        this.#literalChunks.push(this.#buf.slice(0, take));
        this.#literalRemaining -= take;
        this.#buf = this.#buf.slice(take);

        if (this.#literalRemaining === 0) {
          // literal complete — emit it then go back to line mode
          const data = this.#literalChunks.join("");
          this.#literalChunks = [];
          this.#literalCallback?.(data);
          // literal is followed by CRLF — consume it
          if (this.#buf.startsWith(CRLF)) {
            this.#buf = this.#buf.slice(2);
          }
          continue; // resume line processing
        }
        return;
      }

      // line mode — find next CRLF
      const idx = this.#buf.indexOf(CRLF);
      if (idx === -1) return; // incomplete line, wait for more data

      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 2);

      if (!line) continue; // skip empty lines

      // IMAP continuation lines: + optional-text
      if (line.startsWith("+")) {
        this.#continueCallback?.(line);
        continue;
      }

      // check for trailing literal marker on this line: ... {size}
      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        this.#lineCallback?.(line);
        this.expectLiteral(Number(litMatch[1]));
        continue;
      }

      this.#lineCallback?.(line);
    }
  }

  /** Send a command (no tag, just the raw command). */
  send(cmd: string): void {
    this.#socket.write(cmd + CRLF, "utf8");
  }

  close(): void {
    this.#socket.end();
  }
}

// ── connection ──────────────────────────────────────────────────────────────

export class Connection {
  #config: ImapConfig;
  #reader: ImapReader | null = null;
  #debugEnabled: boolean;
  #dead = false;

  constructor(config: ImapConfig) {
    this.#config = config;
    this.#debugEnabled = config.debug ?? false;
  }
  #tag = 0;
  #pending = new Map<
    string,
    { resolve: (lines: string[]) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  #untagged: string[] = [];
  #mailboxInfo: MailboxInfo | null = null;

  /** Server capabilities discovered after LOGIN. */
  readonly capabilities = new Set<string>();

  // fetch state
  #fetchResolve: ((msgs: FetchedMessage[]) => void) | null = null;
  #fetchResults: FetchedMessage[] = [];
  #fetchPending = 0;

  // continuation callback for IDLE/APPEND (+ lines)
  #continuationResolve: ((line: string) => void) | null = null;

  // idle event hook — called from #dispatchLine for every untagged line
  // during an active IDLE session.  Null when not idling.
  #idleHook: ((line: string) => void) | null = null;

  // idle event resolver — set during idle() to break the loop on socket close.
  #idleEventResolve: ((ev: IdleEvent | null) => void) | null = null;

  // drain resolver — set during idle() DONE phase; resolved on socket close
  // so the finally block doesn't hang if the socket dies mid-drain.
  #idleDrainResolve: (() => void) | null = null;

  /** Whether the connection has been closed or has errored out. */
  get dead(): boolean {
    return this.#dead;
  }

  /**
   * Enable or disable protocol-level debug logging at runtime.
   * When enabled, raw socket reads/writes and line dispatch are
   * printed to stderr.
   */
  setDebug(enabled: boolean): void {
    this.#debugEnabled = enabled;
  }

  #debug(kind: string, ...args: unknown[]): void {
    if (this.#debugEnabled) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      console.error(`[${ts}] [imap] ${kind}`, ...args);
    }
  }

  /**
   * Check whether the server advertises a given capability.
   * Capability names are compared case-insensitively.
   */
  serverSupports(cap: string): boolean {
    return this.capabilities.has(cap.toUpperCase());
  }

  // ── protocol helpers ───────────────────────────────────────────────────

  #nextTag(): string {
    return "A" + String(++this.#tag).padStart(4, "0");
  }

  sendCommand(cmd: string): Promise<string[]> {
    if (this.#dead) return Promise.reject(new Error("Connection is dead"));
    const tag = this.#nextTag();
    const timeout = this.#config.commandTimeout ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(tag);
        this.#reader?.close();
        reject(new Error(`Command timed out: ${cmd.slice(0, 50)}`));
      }, timeout);
      this.#pending.set(tag, { resolve, reject, timer });
      this.#untagged = [];
      this.#reader!.send(tag + " " + cmd);
    });
  }

  // ── socket error propagation ───────────────────────────────────────────

  #failAllPending(err: Error): void {
    this.#dead = true;
    this.#reader = null;
    this.#idleHook = null;
    for (const [tag, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    if (this.#fetchResolve) {
      const r = this.#fetchResolve;
      this.#fetchResolve = null;
      this.#fetchQueue = null;
      r(this.#fetchResults);
    }
  }

  // ── connect / close ────────────────────────────────────────────────────

  connect(): Promise<void> {
    const tlsEnabled = this.#config.tls !== false;
    const connTimeout = this.#config.connTimeout ?? 30_000;
    const authTimeout = this.#config.authTimeout ?? 10_000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      // connection timeout
      const connTimer = setTimeout(() => {
        settle(() => reject(new Error("Connection timed out")));
      }, connTimeout);

      const onReady = (socket: Socket) => {
        clearTimeout(connTimer);
        // Debug: wrap socket writes and raw reads.
        if (this.#debugEnabled) {
          debugSocket(socket, "", (raw) => this.#debug("→", raw));
        }
        this.#reader = new ImapReader(socket);
        this.#reader.onLine((line) => this.#dispatchLine(line));
        this.#reader.onLiteral((data) => this.#onLiteral(data));
        this.#reader.onContinue((line) => this.#onContinue(line));
        this.#reader.onRawRead((raw) => { if (this.#debugEnabled) this.#debug("←", JSON.stringify(raw)); });

        // Propagate socket-level failures to all pending commands.
        socket.on("close", () => {
            this.#debug("socket", "closed");
            if (this.#idleEventResolve) {
              this.#idleEventResolve(null);
              this.#idleEventResolve = null;
            }
            if (this.#idleDrainResolve) {
              this.#idleDrainResolve();
              this.#idleDrainResolve = null;
            }
            this.#failAllPending(new Error("Socket closed"));
        });
        socket.on("error", (e: Error) => {
          this.#failAllPending(e);
        });

        let starttlsDone = false;

        const doLogin = () => {
          // auth timeout
          const authTimer = setTimeout(() => {
            settle(() => reject(new Error("Authentication timed out")));
          }, authTimeout);

          this.sendCommand(
            `LOGIN "${this.#config.user}" "${this.#config.password}"`,
          )
            .then(() => {
              clearTimeout(authTimer);
              // CAPABILITY detection
              this.sendCommand("CAPABILITY").then((lines) => {
                for (const line of lines) {
                  const m = line.match(/^\* CAPABILITY (.*)/i);
                  if (m) {
                    for (const cap of m[1].split(/\s+/)) {
                      this.capabilities.add(cap.toUpperCase());
                    }
                  }
                }
                settle(() => resolve());
              }).catch(() => {
                // best-effort: resolve even if CAPABILITY fails
                settle(() => resolve());
              });
            })
            .catch((e) => settle(() => reject(e)));
        };

        const onGreeting = (line: string) => {
          if (!line.startsWith("* OK") && !line.startsWith("* PREAUTH")) return;

          // check for STARTTLS in greeting capabilities
          const greetCaps = line.match(/CAPABILITY (.*)/i);
          const hasStarttls = greetCaps
            ? greetCaps[1].split(/\s+/).some((c) => c.toUpperCase() === "STARTTLS")
            : false;

          const wantStarttls = this.#config.autotls === "always" || this.#config.autotls === "required";
          const canStarttls = !tlsEnabled && hasStarttls;

          if (wantStarttls && !canStarttls && this.#config.autotls === "required") {
            settle(() => reject(new Error("STARTTLS required but not available")));
            return;
          }

          if (canStarttls && wantStarttls && !starttlsDone) {
            starttlsDone = true;
            this.#reader!.onLine((l) => this.#dispatchLine(l));
            this.sendCommand("STARTTLS").then(() => {
              const rawSocket = socket;
              const tlsSocket = tls.connect({
                socket: rawSocket,
                host: this.#config.host,
                ...this.#config.tlsOptions,
              });
              this.#reader = new ImapReader(tlsSocket);
              this.#reader.onLine((line2) => this.#dispatchLine(line2));
              this.#reader.onLiteral((data) => this.#onLiteral(data));
              this.#reader.onContinue((line) => this.#onContinue(line));
              this.#reader.onRawRead((raw) => { if (this.#debugEnabled) this.#debug("←", JSON.stringify(raw)); });
              tlsSocket.on("close", () => {
                this.#debug("socket", "closed (TLS upgrade)");
                if (this.#idleEventResolve) {
                  this.#idleEventResolve(null);
                  this.#idleEventResolve = null;
                }
                if (this.#idleDrainResolve) {
                  this.#idleDrainResolve();
                  this.#idleDrainResolve = null;
                }
                this.#failAllPending(new Error("Socket closed"));
              });
              tlsSocket.on("error", (e: Error) => {
                if (this.#idleEventResolve) {
                  this.#idleEventResolve(null);
                  this.#idleEventResolve = null;
                }
                if (this.#idleDrainResolve) {
                  this.#idleDrainResolve();
                  this.#idleDrainResolve = null;
                }
                this.#failAllPending(e);
              });
              doLogin();
            }).catch((e) => settle(() => reject(e)));
            return;
          }

          // no STARTTLS — proceed to login
          this.#reader!.onLine((l) => this.#dispatchLine(l));
          doLogin();
        };

        this.#reader.onLine(onGreeting);
      };

      let socket: Socket;
      if (tlsEnabled) {
        socket = tls.connect({
          host: this.#config.host,
          port: this.#config.port,
          ...this.#config.tlsOptions,
        });
      } else {
        socket = new Socket();
        socket.connect(this.#config.port, this.#config.host);
      }

      socket.once("connect", () => onReady(socket));
      socket.once("error", (e: Error) => settle(() => reject(e)));
    });
  }

  async close(): Promise<void> {
    if (this.#dead) return;
    try {
      await this.sendCommand("LOGOUT");
    } catch {
      // LOGOUT may fail; close the socket regardless.
    } finally {
      this.#reader?.close();
      this.#reader = null;
      this.#dead = true;
    }
  }

  // ── continuation dispatch ──────────────────────────────────────────────

  #onContinue(line: string): void {
    this.#debug("cont", line);
    if (this.#continuationResolve) {
      const r = this.#continuationResolve;
      this.#continuationResolve = null;
      r(line);
    }
  }

  /**
   * Send a command that expects a `+` continuation before the tagged
   * response.  Returns a promise that resolves with the continuation
   * line.  The caller is responsible for sending the subsequent command
   * and waiting for the tagged response via sendCommand.
   */
  sendCommandWithContinuation(cmd: string): Promise<string> {
    return new Promise((resolve) => {
      this.#continuationResolve = resolve;
      this.#reader!.send(cmd);
    });
  }

  // ── line dispatch ──────────────────────────────────────────────────────

  #dispatchLine(line: string): void {
    this.#debug("line", line);
    const tagged = line.match(RE_TAGGED);
    if (tagged) {
      // Let the idle hook see the tagged response — it may be the OK for
      // the IDLE command, which signals the end of the drain phase.
      if (this.#idleHook) this.#idleHook(line);

      const [, tag, status] = tagged;
      const p = this.#pending.get(tag);
      if (!p) return;
      this.#pending.delete(tag);
      clearTimeout(p.timer);

      if (status === "OK") {
        p.resolve([...this.#untagged]);
      } else {
        p.reject(new Error(status + ": " + line));
      }
      return;
    }

    // Idle hook consumes untagged lines when active.
    if (this.#idleHook) {
      this.#idleHook(line);
    }

    // untagged
    this.#untagged.push(line);
    this.#handleUntagged(line);
    this.#handleFetchLine(line);
  }

  // ── untagged status updates ────────────────────────────────────────────

  #handleUntagged(line: string): void {
    const info = this.#mailboxInfo;
    if (!info) return;

    const exists = line.match(RE_EXISTS);
    if (exists) info.total = Number(exists[1]);

    const recent = line.match(RE_RECENT);
    if (recent) info.unseen = Number(recent[1]);

    const flags = line.match(RE_FLAGS);
    if (flags) info.flags = flags[1].split(" ").filter(Boolean);
  }

  // ── fetch response parsing ─────────────────────────────────────────────

  #handleFetchLine(line: string): void {
    // Ignore unsolicited FETCH responses (e.g. during IDLE) when no
    // explicit fetch is in progress.  Otherwise they leak into
    // #fetchQueue and #fetchResults.
    if (!this.#fetchResolve) return;

    const start = line.match(RE_FETCH_START);
    if (!start) return;

    const seqno = Number(start[1]);
    const rest = start[2];

    const uidMatch = rest.match(/UID (\d+)/);
    const flagsMatch = rest.match(/FLAGS \(([^)]*)\)/);
    const uid = uidMatch ? Number(uidMatch[1]) : 0;
    const flags = flagsMatch ? flagsMatch[1].split(" ").filter(Boolean) : [];

    // body literal: BODY[...] {size}
    const litMatch = rest.match(/BODY\[[^\]]*\] \{(\d+)\}/);
    if (litMatch) {
      this.#fetchPending++;
      // data will arrive via #onLiteral
      // stash seqno/uid/flags for when literal completes
      const ctx = { seqno, uid, flags };
      // We need to match the next literal to this fetch entry.
      // Since IMAP sends fetch responses sequentially, we push to a queue.
      if (!this.#fetchQueue) this.#fetchQueue = [];
      this.#fetchQueue.push(ctx);
    } else {
      // inline body
      const bodyMatch = rest.match(/BODY\[[^\]]*\] (.+)/);
      const body = bodyMatch ? bodyMatch[1] : "";
      this.#fetchResults.push({ uid, seqno, body, flags });
    }

    // check for end of fetch: all results in, no pending literals
    this.#maybeFinishFetch();
  }

  #fetchQueue: Array<{ seqno: number; uid: number; flags: string[] }> | null =
    null;

  #onLiteral(data: string): void {
    const ctx = this.#fetchQueue?.shift();
    if (ctx) {
      this.#fetchResults.push({
        uid: ctx.uid,
        seqno: ctx.seqno,
        body: data,
        flags: ctx.flags,
      });
      this.#fetchPending--;
      this.#maybeFinishFetch();
    }
  }

  #maybeFinishFetch(): void {
    if (
      this.#fetchResolve &&
      this.#fetchPending === 0 &&
      (!this.#fetchQueue || this.#fetchQueue.length === 0)
    ) {
      // All results collected. But we need to be careful: the tagged OK
      // may not have arrived yet. We rely on the fact that untagged fetch
      // responses always precede the tagged OK.  However, if we're in the
      // middle of processing an untagged line, the tagged OK hasn't been
      // dispatched yet. So we defer to the next tick to let the tagged
      // response flush through.
      setImmediate(() => {
        const r = this.#fetchResolve;
        if (r) {
          this.#fetchResolve = null;
          this.#fetchQueue = null;
          r(this.#fetchResults);
        }
      });
    }
  }

  // ── mailbox ─────────────────────────────────────────────────────────────

  async openBox(name: string, readOnly = false): Promise<MailboxInfo> {
    // Only gate if we actually fetched capabilities (non-empty set).
    // Servers that don't respond to CAPABILITY are assumed to be
    // IMAP4rev1-compliant.
    if (this.capabilities.size > 0 && !this.serverSupports("IMAP4REV1")) {
      throw new Error("Server does not support IMAP4rev1");
    }
    const cmd = readOnly ? "EXAMINE" : "SELECT";
    const lines = await this.sendCommand(`${cmd} "${name}"`);

    const info: MailboxInfo = {
      name,
      total: 0,
      unseen: 0,
      uidvalidity: 0,
      uidnext: 0,
      flags: [],
    };

    for (const line of lines) {
      const exists = line.match(RE_EXISTS);
      if (exists) info.total = Number(exists[1]);

      const recent = line.match(RE_RECENT);
      if (recent) info.unseen = Number(recent[1]);

      const flags = line.match(RE_FLAGS);
      if (flags) info.flags = flags[1].split(" ").filter(Boolean);

      const uv = line.match(/UIDVALIDITY (\d+)/);
      if (uv) info.uidvalidity = Number(uv[1]);

      const un = line.match(/UIDNEXT (\d+)/);
      if (un) info.uidnext = Number(un[1]);

      const us = line.match(/UNSEEN (\d+)/i);
      if (us) info.unseen = Number(us[1]);
    }

    this.#mailboxInfo = info;
    return info;
  }

  // ── search ──────────────────────────────────────────────────────────────

  async search(criteria: any[]): Promise<number[]> {
    const query = buildSearchQuery(criteria);
    const lines = await this.sendCommand(`UID SEARCH ${query}`);

    for (const line of lines) {
      const m = line.match(RE_SEARCH);
      if (m) {
        return m[1]
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
      }
    }
    return [];
  }

  // ── fetch ───────────────────────────────────────────────────────────────

  fetch(
    uids: number[],
    options?: { bodies?: string | string[] },
  ): Promise<FetchedMessage[]> {
    if (uids.length === 0) return Promise.resolve([]);
    if (this.#fetchResolve) {
      throw new Error("A fetch is already in progress; await it before starting another.");
    }

    const bodies = options?.bodies ?? "";
    const bodyParts = Array.isArray(bodies) ? bodies : [bodies];
    const bodySpec = bodyParts.map((b) => `BODY.PEEK[${b}]`).join(" ");

    this.#fetchResults = [];
    this.#fetchPending = 0;
    this.#fetchQueue = [];

    return new Promise((resolve) => {
      this.#fetchResolve = resolve;
      const uidStr = uids.join(",");
      this.sendCommand(`UID FETCH ${uidStr} (UID FLAGS ${bodySpec})`);
      // the tagged OK ends up resolving the pending promise too,
      // but we get our results via untagged fetch lines + literals.
      // Make sure the tagged response doesn't interfere:
      // #dispatchLine will call pending.resolve for the tag, which is
      // a no-op for our caller (nobody awaits sendCommand here).
      // We resolve via #maybeFinishFetch.
    });
  }

  // ── flags ───────────────────────────────────────────────────────────────

  async addFlags(uids: number[], flags: string | string[]): Promise<void> {
    const flagList = Array.isArray(flags) ? flags : [flags];
    const formatted = flagList
      .map((f) => (f.startsWith("\\") ? f : "\\" + f))
      .join(" ");
    const uidStr = uids.join(",");
    await this.sendCommand(`UID STORE ${uidStr} +FLAGS.SILENT (${formatted})`);
  }

  // ── combined helpers ────────────────────────────────────────────────────

  async fetchUnseen(): Promise<FetchedMessage[]> {
    const uids = await this.search(["UNSEEN"]);
    if (uids.length === 0) return [];
    return this.fetch(uids);
  }

  // ── idle ────────────────────────────────────────────────────────────────

  /**
   * Enter IDLE mode and yield real-time mailbox events.
   *
   * The caller must iterate with `for await (const event of conn.idle())`.
   * Breaking out of the loop (or calling `.return()` on the iterator) sends
   * DONE and drains remaining untagged events before resolving.
   *
   * Throws if the server does not advertise the IDLE capability.
   */
  async *idle(): AsyncIterable<IdleEvent> {
    if (!this.serverSupports("IDLE")) {
      throw new Error("Server does not support IDLE");
    }

    // Tag for this IDLE session.
    this.#idleTag = this.#nextTag();
    const timer = setTimeout(() => {
      this.#pending.delete(this.#idleTag);
      this.#reader?.close();
    }, this.#config.commandTimeout ?? 30_000);
    this.#pending.set(this.#idleTag, {
      resolve: () => {}, reject: () => {}, timer,
    });
    this.#untagged = [];

    // Install the idle hook BEFORE sending the command so we catch
    // events that arrive synchronously with the server response.
    let eventResolve: ((ev: IdleEvent | null) => void) | null = null;
    const eventQueue: IdleEvent[] = [];
    let done = false;

    const pushIdleEvent = (ev: IdleEvent) => {
      if (done) {
        eventQueue.push(ev);
      } else if (eventResolve) {
        eventResolve(ev);
        eventResolve = null;
      }
    };

    let drainResolve: (() => void) | null = null;
    const idleTag = this.#idleTag;

    this.#idleHook = (line: string) => {
      this.#debug("idle", line);
      const tagged = line.match(RE_TAGGED);
      if (tagged) {
        if (tagged[1] === idleTag) {
          // Tagged OK for our IDLE command — end of drain.
          this.#idleHook = null;
          if (drainResolve) drainResolve();
        }
        return;
      }
      const ev = this.#parseIdleEvent(line);
      if (ev) pushIdleEvent(ev);
    };

    // Send IDLE and wait for continuation.
    const continuationPromise: Promise<string> = new Promise((resolve) => {
      this.#continuationResolve = resolve;
    });
    this.#reader!.send(this.#idleTag + " IDLE");

    const contLine = await continuationPromise;
    if (!contLine.startsWith("+")) {
      this.#idleHook = null;
      throw new Error(`Expected continuation, got: ${contLine}`);
    }

    // Yield events as they arrive.
    try {
      while (!done) {
        const event = await new Promise<IdleEvent | null>((resolve) => {
          eventResolve = resolve;
          this.#idleEventResolve = resolve;
        });
        if (event === null) break;
        yield event;
      }
    } finally {
      done = true;

      // If the socket is already closed, skip DONE/drain — there's
      // nothing to send to and the tagged OK will never arrive.
      if (this.#idleHook != null) {
        // Send DONE
        this.#reader!.send("DONE");

        // Drain: wait for tagged OK for IDLE
        await new Promise<void>((resolve) => {
          drainResolve = resolve;
          this.#idleDrainResolve = resolve;
        });

        // Yield any events that arrived after DONE but before tagged OK.
        for (const ev of eventQueue) {
          yield ev;
        }
      }

      // Clean up idle state.
      this.#idleHook = null;
      this.#idleEventResolve = null;
      this.#idleDrainResolve = null;
    }
  }

  // Tag of the current IDLE command, set when idle() is called.
  #idleTag: string = "";

  /**
   * Parse an untagged IMAP line into an IdleEvent, or null if the line
   * is not a recognised idle event type.
   */
  #parseIdleEvent(line: string): IdleEvent | null {
    const exists = line.match(RE_EXISTS);
    if (exists) {
      return { type: "exists", count: Number(exists[1]) };
    }

    const recent = line.match(RE_RECENT);
    if (recent) {
      return { type: "recent", count: Number(recent[1]) };
    }

    const expunge = line.match(/^\* (\d+) EXPUNGE/);
    if (expunge) {
      return { type: "expunge", seqno: Number(expunge[1]) };
    }

    const fetchStart = line.match(RE_FETCH_START);
    if (fetchStart) {
      const rest = fetchStart[2];
      const uidMatch = rest.match(/UID (\d+)/);
      const flagsMatch = rest.match(/FLAGS \(([^)]*)\)/);
      return {
        type: "fetch",
        seqno: Number(fetchStart[1]),
        uid: uidMatch ? Number(uidMatch[1]) : undefined,
        flags: flagsMatch ? flagsMatch[1].split(" ").filter(Boolean) : [],
      };
    }

    const flags = line.match(/^\* (\d+) FETCH \(FLAGS \(([^)]*)\)\)/);
    if (flags) {
      return {
        type: "flags",
        seqno: Number(flags[1]),
        flags: flags[2].split(" ").filter(Boolean),
      };
    }

    return null;
  }
}

// ── search query builder ────────────────────────────────────────────────────

function escapeString(str: string): string {
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(criteria: any[]): string {
  const parts: string[] = [];
  for (const item of criteria) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (Array.isArray(item)) {
      const [key, ...args] = item;
      switch (key.toUpperCase()) {
        case "BCC":
        case "BODY":
        case "CC":
        case "FROM":
        case "SUBJECT":
        case "TEXT":
        case "TO":
        case "KEYWORD":
          parts.push(`${key} ${escapeString(String(args[0]))}`);
          break;
        case "HEADER":
          parts.push(
            `${key} ${escapeString(String(args[0]))} ${escapeString(String(args[1] ?? ""))}`,
          );
          break;
        case "BEFORE":
        case "ON":
        case "SINCE":
        case "SENTBEFORE":
        case "SENTON":
        case "SENTSINCE":
          parts.push(`${key} ${escapeString(String(args[0]))}`);
          break;
        case "LARGER":
        case "SMALLER":
          parts.push(`${key} ${args[0]}`);
          break;
        case "UID":
          parts.push(`${key} ${args.join(",")}`);
          break;
        case "OR":
          parts.push(
            `OR (${buildSearchQuery(args[0])}) (${buildSearchQuery(args[1])})`,
          );
          break;
        default:
          parts.push(key);
      }
    }
  }
  return parts.join(" ");
}
