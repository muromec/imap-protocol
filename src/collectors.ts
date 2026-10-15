import type { FetchedMessage } from './interface.ts';
import type { TransportItem } from './transport.ts';

// ── reply collection ───────────────────────────────────────────────────────

/**
 * How one command's reply is read.
 *
 * The loop hands a command's collector every item that arrives while that
 * command is the oldest one outstanding — the IMAP server answers in order,
 * so its untagged lines come before its tagged reply — and the collector
 * decides what belongs to it.  On the tagged OK the loop asks for the result;
 * a NO / BAD is the loop's to reject, not the collector's.
 */
export interface Collector<T> {
  /** One item that arrived while this command was outstanding. */
  accept(item: TransportItem): void;
  /** The command was answered: what came of it. */
  finish(): T;
}

/** The reply as the lines it was — what most commands are. */
export class LinesCollector implements Collector<string[]> {
  readonly lines: string[] = [];

  accept(item: TransportItem): void {
    if (item.kind === 'line') this.lines.push(item.line);
  }

  finish(): string[] {
    return this.lines;
  }
}

const RE_FETCH_START = /^\* (\d+) FETCH \((.*)/;

/**
 * A FETCH reply: one message per FETCH line, with its body as the literal that
 * follows the line — or inline, when the server sent it that way.  The literal
 * that follows belongs to the FETCH line before it, which is why the pending
 * bodies are kept in order.
 *
 * A body is the octets the server sent, undecoded: they are the message, and
 * only a parser that reads its headers knows what charset they are in.
 */
export class FetchCollector implements Collector<FetchedMessage[]> {
  readonly #results: FetchedMessage[] = [];
  /** Fetch responses whose body is still coming, oldest first. */
  #awaitingBody: Array<{ seqno: number; uid: number; flags: string[] }> = [];

  accept(item: TransportItem): void {
    if (item.kind === 'literal') {
      const ctx = this.#awaitingBody.shift();
      if (!ctx) return;
      this.#results.push({ uid: ctx.uid, seqno: ctx.seqno, body: item.data, flags: ctx.flags });
      return;
    }
    if (item.kind !== 'line') return;

    const start = item.line.match(RE_FETCH_START);
    if (!start) return;

    const seqno = Number(start[1]);
    const rest = start[2];
    const uid = Number(rest.match(/UID (\d+)/)?.[1] ?? 0);
    const flags = rest.match(/FLAGS \(([^)]*)\)/)?.[1].split(' ').filter(Boolean) ?? [];

    if (/BODY\[[^\]]*\] \{(\d+)\}/.test(rest)) {
      this.#awaitingBody.push({ seqno, uid, flags });
      return;
    }

    // An inline body arrives inside a line, which the transport decoded into
    // text; encoding it back is exact for the octets a line can carry.
    const inline = rest.match(/BODY\[[^\]]*\] (.+)/)?.[1] ?? '';
    this.#results.push({ uid, seqno, body: Buffer.from(inline, 'utf8'), flags });
  }

  finish(): FetchedMessage[] {
    return this.#results;
  }
}
