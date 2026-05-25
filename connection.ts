import tls from "node:tls";
import { Socket } from "node:net";

// ── types ──────────────────────────────────────────────────────────────────

export interface ImapConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  tls: boolean;
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

// ── IMAP protocol constants ────────────────────────────────────────────────

const CRLF = "\r\n";
const RE_TAGGED = /^(A\d+) (OK|NO|BAD) /;
const RE_EXISTS = /^\* (\d+) EXISTS/;
const RE_RECENT = /^\* (\d+) RECENT/;
const RE_FLAGS = /^\* FLAGS \((.*)\)/;
const RE_SEARCH = /^\* SEARCH (.*)/;
const RE_FETCH_START = /^\* (\d+) FETCH \((.*)/;

// ── line-oriented buffered reader ──────────────────────────────────────────

/**
 * Wraps a TLS socket and yields complete IMAP lines / literals.
 *
 * Normal lines end with CRLF.  When a line contains a literal marker
 * `{<size>}` at the end, the reader switches to "literal mode" and
 * accumulates exactly `<size>` bytes before resuming line mode.
 */
class ImapReader {
  #socket: tls.TLSSocket;
  #buf = "";
  #literalRemaining = 0;
  #literalChunks: string[] = [];
  #lineCallback: ((line: string) => void) | null = null;
  #literalCallback: ((data: string) => void) | null = null;

  constructor(socket: tls.TLSSocket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk.toString("utf8")));
  }

  onLine(cb: (line: string) => void): void {
    this.#lineCallback = cb;
  }

  onLiteral(cb: (data: string) => void): void {
    this.#literalCallback = cb;
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
  #tag = 0;
  #pending = new Map<
    string,
    { resolve: (lines: string[]) => void; reject: (e: Error) => void }
  >();
  #untagged: string[] = [];
  #mailboxInfo: MailboxInfo | null = null;

  // fetch state
  #fetchResolve: ((msgs: FetchedMessage[]) => void) | null = null;
  #fetchResults: FetchedMessage[] = [];
  #fetchPending = 0;

  constructor(config: ImapConfig) {
    this.#config = config;
  }

  // ── protocol helpers ───────────────────────────────────────────────────

  #nextTag(): string {
    return "A" + String(++this.#tag).padStart(4, "0");
  }

  sendCommand(cmd: string): Promise<string[]> {
    const tag = this.#nextTag();
    return new Promise((resolve, reject) => {
      this.#pending.set(tag, { resolve, reject });
      this.#untagged = [];
      this.#reader!.send(tag + " " + cmd);
    });
  }

  // ── connect / close ────────────────────────────────────────────────────

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = (socket: Socket) => {
        this.#reader = new ImapReader(socket);

        this.#reader.onLine((line) => this.#dispatchLine(line));
        this.#reader.onLiteral((data) => this.#onLiteral(data));

        // Wait for greeting then LOGIN
        const onGreeting = (line: string) => {
          if (line.startsWith("* OK") || line.startsWith("* PREAUTH")) {
            // remove this ad-hoc listener — greeting handled
            this.#reader!.onLine((l) => this.#dispatchLine(l));
            this.sendCommand(
              `LOGIN "${this.#config.user}" "${this.#config.password}"`,
            )
              .then(() => resolve())
              .catch(reject);
          }
        };
        // override temporarily for greeting
        this.#reader.onLine(onGreeting);
      };

      let socket: Socket;
      if (this.#config.tls) {
        socket = tls.connect(
          { host: this.#config.host, port: this.#config.port },
        );
      } else {
        socket = new Socket();
        socket.connect(this.#config.port, this.#config.host);
      }

      socket.once("connect", () => onConnect(socket));
      socket.once("error", reject);
    });
  }

  async close(): Promise<void> {
    try {
      await this.sendCommand("LOGOUT");
    } catch {
      // LOGOUT may fail; close the socket regardless.
    } finally {
      this.#reader?.close();
    }
  }

  // ── line dispatch ──────────────────────────────────────────────────────

  #dispatchLine(line: string): void {
    const tagged = line.match(RE_TAGGED);
    if (tagged) {
      const [, tag, status] = tagged;
      const p = this.#pending.get(tag);
      if (!p) return;
      this.#pending.delete(tag);

      if (status === "OK") {
        p.resolve([...this.#untagged]);
      } else {
        p.reject(new Error(status + ": " + line));
      }
      return;
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
