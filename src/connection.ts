import { Transport, defaultDebugSink } from './transport.ts';
import { Session } from './session.ts';
import { connect } from './connect.ts';
import { FetchCollector } from './collectors.ts';
import {
  type ImapConfig,
  type MailboxInfo,
  type FetchedMessage,
  type IdleEvent,
} from './interface.ts';

// ── IMAP protocol constants ────────────────────────────────────────────────

const RE_EXISTS = /^\* (\d+) EXISTS/;
const RE_RECENT = /^\* (\d+) RECENT/;
const RE_FLAGS = /^\* FLAGS \((.*)\)/;
const RE_SEARCH = /^\* SEARCH (.*)/;
const RE_FETCH_START = /^\* (\d+) FETCH \((.*)/;

// ── connection ──────────────────────────────────────────────────────────────

/**
 * One IMAP connection: the operations that are spelled in IMAP, on top of a
 * Session that owns the wire.
 *
 * Tags, batches, timeouts and the IDLE state belong to the session.  What is
 * here is what the words mean: a mailbox is SELECT plus the lines that come
 * with it, a fetch is `UID FETCH ... BODY.PEEK[...]` read by a collector, and
 * a flag change is a STORE.
 */
export class Connection {
  #config: ImapConfig;
  #transport: Transport | null = null;
  #session: Session | null = null;
  #debugEnabled: boolean;
  #debugSink: (line: string) => void;

  constructor(config: ImapConfig) {
    this.#config = config;
    this.#debugEnabled = config.debug ?? false;
    this.#debugSink = config.debugSink ?? defaultDebugSink;
  }

  #mailboxInfo: MailboxInfo | null = null;

  /** Server capabilities discovered after LOGIN. */
  capabilities = new Set<string>();

  /** Whether the connection has been closed or has errored out. */
  get dead(): boolean {
    return this.#session?.dead ?? true;
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
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const rest = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      this.#debugSink(rest.length > 0 ? `[${ts}] [imap] ${kind} ${rest}` : `[${ts}] [imap] ${kind}`);
    }
  }

  /**
   * Check whether the server advertises a given capability.
   * Capability names are compared case-insensitively.
   */
  serverSupports(cap: string): boolean {
    return this.capabilities.has(cap.toUpperCase());
  }

  // ── protocol helpers (delegate to the session) ─────────────────────────

  sendCommand(cmd: string): Promise<string[]> {
    return this.#live().sendCommand(cmd);
  }

  #live(): Session {
    if (!this.#session) throw new Error('Connection is dead');
    return this.#session;
  }

  // ── connect / close ────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const { transport, session, capabilities } = await connect(this.#config, this.#debugEnabled);
    this.#transport = transport;
    this.#session = session;
    this.capabilities = capabilities;
    session.onUntagged((line) => this.#sessionUntagged(line));
    transport.onRawRead((raw) => {
      if (this.#debugEnabled) this.#debug('←', JSON.stringify(raw));
    });
  }

  async close(): Promise<void> {
    if (this.dead) return;
    try {
      await this.sendCommand('LOGOUT');
    } catch {
      // LOGOUT may fail; close the socket regardless.
    } finally {
      this.#session?.close();
      this.#transport = null;
      this.#session = null;
    }
  }

  // ── session-level untagged handler ────────────────────────────────────

  #sessionUntagged(line: string): void {
    this.#debug('line', line);
    this.#handleUntagged(line);
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
    if (flags) info.flags = flags[1].split(' ').filter(Boolean);
  }

  // ── mailbox ─────────────────────────────────────────────────────────────

  async openBox(name: string, readOnly = false): Promise<MailboxInfo> {
    // Only gate if we actually fetched capabilities (non-empty set).
    // Servers that don't respond to CAPABILITY are assumed to be
    // IMAP4rev1-compliant.
    if (this.capabilities.size > 0 && !this.serverSupports('IMAP4REV1')) {
      throw new Error('Server does not support IMAP4rev1');
    }
    const cmd = readOnly ? 'EXAMINE' : 'SELECT';
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
      if (flags) info.flags = flags[1].split(' ').filter(Boolean);

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
          .replace(/\s*\(MODSEQ \d+\)\s*$/i, '')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number);
      }
    }
    return [];
  }

  // ── fetch ───────────────────────────────────────────────────────────────

  fetch(uids: number[], options?: { bodies?: string | string[] }): Promise<FetchedMessage[]> {
    if (uids.length === 0) return Promise.resolve([]);

    const bodies = options?.bodies ?? '';
    const bodyParts = Array.isArray(bodies) ? bodies : [bodies];
    const bodySpec = bodyParts.map((b) => `BODY.PEEK[${b}]`).join(' ');

    return this.#live().send(
      `UID FETCH ${uids.join(',')} (UID FLAGS ${bodySpec})`,
      new FetchCollector(),
    );
  }

  // ── flags ───────────────────────────────────────────────────────────────

  async addFlags(uids: number[], flags: string | string[]): Promise<void> {
    const flagList = Array.isArray(flags) ? flags : [flags];
    const formatted = flagList.map((f) => (f.startsWith('\\') ? f : '\\' + f)).join(' ');
    const uidStr = uids.join(',');
    await this.sendCommand(`UID STORE ${uidStr} +FLAGS.SILENT (${formatted})`);
  }

  // ── combined helpers ────────────────────────────────────────────────────

  async fetchUnseen(): Promise<FetchedMessage[]> {
    const uids = await this.search(['UNSEEN']);
    if (uids.length === 0) return [];
    return this.fetch(uids);
  }

  // ── idle ────────────────────────────────────────────────────────────────

  /**
   * Enter IDLE mode and yield real-time mailbox events.
   *
   * The caller iterates with `for await (const event of conn.idle())`.  Breaking
   * out of the loop — or calling `.return()` on the iterator — ends the session
   * (DONE, its tagged reply) and leaves the connection usable.
   *
   * The session belongs to the loop underneath, so a command asked for while
   * this iteration is open does not have to wait for it: the session is broken
   * for that batch and opened again afterwards.
   *
   * Throws if the server does not advertise the IDLE capability.
   */
  idle(): AsyncIterable<IdleEvent> {
    if (!this.serverSupports('IDLE')) {
      throw new Error('Server does not support IDLE');
    }

    const lines = this.#live().idle()[Symbol.asyncIterator]();

    const iterator: AsyncIterator<IdleEvent> = {
      next: async (): Promise<IteratorResult<IdleEvent>> => {
        for (;;) {
          const result = await lines.next();
          if (result.done) return { done: true, value: undefined };
          const event = this.#parseIdleEvent(result.value);
          if (event) return { done: false, value: event };
        }
      },

      return: async (): Promise<IteratorResult<IdleEvent>> => {
        await lines.return?.();
        return { done: true, value: undefined };
      },
    };

    return { [Symbol.asyncIterator]: () => iterator };
  }

  /**
   * Parse an untagged IMAP line into an IdleEvent, or null if the line
   * is not a recognised idle event type.
   */
  #parseIdleEvent(line: string): IdleEvent | null {
    const exists = line.match(RE_EXISTS);
    if (exists) {
      return { type: 'exists', count: Number(exists[1]) };
    }

    const recent = line.match(RE_RECENT);
    if (recent) {
      return { type: 'recent', count: Number(recent[1]) };
    }

    const expunge = line.match(/^\* (\d+) EXPUNGE/);
    if (expunge) {
      return { type: 'expunge', seqno: Number(expunge[1]) };
    }

    const fetchStart = line.match(RE_FETCH_START);
    if (fetchStart) {
      const rest = fetchStart[2];
      const uidMatch = rest.match(/UID (\d+)/);
      const flagsMatch = rest.match(/FLAGS \(([^)]*)\)/);
      return {
        type: 'fetch',
        seqno: Number(fetchStart[1]),
        uid: uidMatch ? Number(uidMatch[1]) : undefined,
        flags: flagsMatch ? flagsMatch[1].split(' ').filter(Boolean) : [],
      };
    }

    const flags = line.match(/^\* (\d+) FETCH \(FLAGS \(([^)]*)\)\)/);
    if (flags) {
      return {
        type: 'flags',
        seqno: Number(flags[1]),
        flags: flags[2].split(' ').filter(Boolean),
      };
    }

    return null;
  }
}

// ── search query builder ────────────────────────────────────────────────────

function escapeString(str: string): string {
  return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildSearchQuery(criteria: any[]): string {
  const parts: string[] = [];
  for (const item of criteria) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (Array.isArray(item)) {
      const [key, ...args] = item;
      switch (key.toUpperCase()) {
        case 'BCC':
        case 'BODY':
        case 'CC':
        case 'FROM':
        case 'SUBJECT':
        case 'TEXT':
        case 'TO':
        case 'KEYWORD':
          parts.push(`${key} ${escapeString(String(args[0]))}`);
          break;
        case 'HEADER':
          parts.push(
            `${key} ${escapeString(String(args[0]))} ${escapeString(String(args[1] ?? ''))}`,
          );
          break;
        case 'BEFORE':
        case 'ON':
        case 'SINCE':
        case 'SENTBEFORE':
        case 'SENTON':
        case 'SENTSINCE':
          parts.push(`${key} ${escapeString(String(args[0]))}`);
          break;
        case 'LARGER':
        case 'SMALLER':
          parts.push(`${key} ${args[0]}`);
          break;
        case 'UID':
          parts.push(`${key} ${args.join(',')}`);
          break;
        case 'OR':
          parts.push(`OR (${buildSearchQuery(args[0])}) (${buildSearchQuery(args[1])})`);
          break;
        default:
          parts.push(key);
      }
    }
  }
  return parts.join(' ');
}
