import { Transport } from "./transport.ts";
import { CommandDispatcher } from "./dispatch.ts";
import { connect } from "./connect.ts";
import {
  type ImapConfig,
  type MailboxInfo,
  type FetchedMessage,
  type IdleEvent,
} from './interface.ts';


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
 // ── connection ──────────────────────────────────────────────────────────────

 export class Connection {
   #config: ImapConfig;
   #transport: Transport | null = null;
   #dispatcher: CommandDispatcher | null = null;
   #debugEnabled: boolean;

   constructor(config: ImapConfig) {
     this.#config = config;
     this.#debugEnabled = config.debug ?? false;
   }
   #mailboxInfo: MailboxInfo | null = null;

   /** Server capabilities discovered after LOGIN. */
   capabilities = new Set<string>();

  // fetch state
  #fetchResolve: ((msgs: FetchedMessage[]) => void) | null = null;
  #fetchResults: FetchedMessage[] = [];
  #fetchPending = 0;

  // continuation callback for IDLE/APPEND (+ lines)
  #continuationResolve: ((line: string) => void) | null = null;

  // idle event hook — called from dispatcher for every untagged line
  // during an active IDLE session.  Null when not idling.
  #idleHook: ((line: string) => void) | null = null;

  // idle event resolver — set during idle() to break the loop on socket close.
  #idleEventResolve: ((ev: IdleEvent | null) => void) | null = null;

  // drain resolver — set during idle() DONE phase; resolved on socket close
  // so the finally block doesn't hang if the socket dies mid-drain.
  #idleDrainResolve: (() => void) | null = null;

  /** Whether the connection has been closed or has errored out. */
  get dead(): boolean {
    return this.#dispatcher?.dead ?? true;
  }

  /**
   * Enable or disable protocol-level debug logging at runtime.
   * When enabled, raw socket reads/writes and line dispatch are
   * printed to stderr.
   */
  setDebug(enabled: boolean): void {
    this.#debugEnabled = enabled;
    this.#transport?.setDebug(enabled);
  }

  #debug(kind: string, ...args: unknown[]): void {
    if (this.#debugEnabled) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      console.error(`[${ts}] [imap] ${kind}`, ...args);
    }
  }

  #wireCallbacks(): void {
    this.#transport!.onLiteral((data) => this.#onLiteral(data));
    this.#transport!.onContinue((line) => this.#onContinue(line));
    this.#transport!.onRawRead((raw) => {
      if (this.#debugEnabled) this.#debug("←", JSON.stringify(raw));
    });
    this.#dispatcher!.onUntagged((line) => this.#sessionUntagged(line));
    this.#dispatcher!.onDead(() => {
      if (this.#idleEventResolve) {
        this.#idleEventResolve(null);
        this.#idleEventResolve = null;
      }
      if (this.#idleDrainResolve) {
        this.#idleDrainResolve();
        this.#idleDrainResolve = null;
      }
      this.#idleHook = null;
      if (this.#fetchResolve) {
        const r = this.#fetchResolve;
        this.#fetchResolve = null;
        this.#fetchQueue = null;
        r(this.#fetchResults);
      }
    });
  }

  /**
   * Check whether the server advertises a given capability.
   * Capability names are compared case-insensitively.
   */
  serverSupports(cap: string): boolean {
    return this.capabilities.has(cap.toUpperCase());
  }

  // ── protocol helpers (delegate to dispatcher) ─────────────────────────

  sendCommand(cmd: string): Promise<string[]> {
    return this.#dispatcher!.sendCommand(cmd);
  }

  sendCommandWithContinuation(cmd: string): Promise<string> {
    return new Promise((resolve) => {
      this.#continuationResolve = resolve;
      this.#transport!.send(cmd);
    });
  }

  // ── session-level untagged handler ────────────────────────────────────

  #sessionUntagged(line: string): void {
    this.#debug("line", line);

    // Idle hook consumes all lines (tagged and untagged) when active.
    if (this.#idleHook) this.#idleHook(line);

    this.#handleUntagged(line);
    this.#handleFetchLine(line);
  }



  // ── connect / close ────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const { transport, dispatcher, capabilities } = await connect(
      this.#config,
      this.#debugEnabled,
    );
    this.#transport = transport;
    this.#dispatcher = dispatcher;
    this.capabilities = capabilities;
    this.#wireCallbacks();
  }

  async close(): Promise<void> {
    if (this.dead) return;
    try {
      await this.sendCommand("LOGOUT");
    } catch {
      // LOGOUT may fail; close the socket regardless.
    } finally {
      this.#transport?.close();
      this.#transport = null;
      this.#dispatcher = null;
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

    // Tag for this IDLE session.  We do NOT register it in the
    // dispatcher's pending map — that would cause the dispatcher to
    // consume the tagged OK instead of forwarding it to the idle hook.
    this.#idleTag = this.#dispatcher!.nextTag();
    const idleTimer = setTimeout(() => {
      this.#transport?.close();
    }, this.#config.commandTimeout ?? 30_000);

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
          clearTimeout(idleTimer);
          this.#idleHook = null;
          if (drainResolve) drainResolve();
        }
        return;
      }
      const ev = this.#parseIdleEvent(line);
      if (ev) pushIdleEvent(ev);
    };

    // Set eventResolve BEFORE sending IDLE so we catch events that
    // arrive synchronously with the continuation response.
    let firstEventPromise = new Promise<IdleEvent | null>((resolve) => {
      eventResolve = resolve;
      this.#idleEventResolve = resolve;
    });

    // Send IDLE and wait for continuation.
    const continuationPromise: Promise<string> = new Promise((resolve) => {
      this.#continuationResolve = resolve;
    });
    this.#transport!.send(this.#idleTag + " IDLE");

    const contLine = await continuationPromise;
    if (!contLine.startsWith("+")) {
      this.#idleHook = null;
      this.#idleEventResolve = null;
      throw new Error(`Expected continuation, got: ${contLine}`);
    }

    // Yield events as they arrive.
    try {
      let first = true;
      while (!done) {
        const event = await (first ? firstEventPromise : new Promise<IdleEvent | null>((resolve) => {
          eventResolve = resolve;
          this.#idleEventResolve = resolve;
        }));
        first = false;
        if (event === null) break;
        yield event;
      }
    } finally {
      done = true;

      // If the socket is already closed, skip DONE/drain — there's
      // nothing to send to and the tagged OK will never arrive.
      if (this.#idleHook != null && this.#transport != null) {
        // Send DONE
        try {
          this.#transport.send("DONE");

          // Drain: wait for tagged OK for IDLE
          await new Promise<void>((resolve) => {
            drainResolve = resolve;
            this.#idleDrainResolve = resolve;
          });

          // Yield any events that arrived after DONE but before tagged OK.
          for (const ev of eventQueue) {
            yield ev;
          }
        } catch (err) {
          console.error(new Error("Unhandled error in idle finally", { cause: err }));
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
