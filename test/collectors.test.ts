// Unit tests for the collectors — how one command's reply is read.
//
// A collector is handed the items that arrive while its command is the oldest
// one outstanding, so these drive `accept` with the items in the order the
// transport would produce them.

import { describe, expect, it } from 'vitest';

import { FetchCollector } from '../src/collectors.ts';
import type { TransportItem } from '../src/transport.ts';

const line = (l: string): TransportItem => ({ kind: 'line', line: l });
const literal = (data: string): TransportItem => ({ kind: 'literal', data });
const cont = (l: string): TransportItem => ({ kind: 'continue', line: l });

describe('FetchCollector', () => {
  it('takes the body from the literal that follows its FETCH line', () => {
    const collector = new FetchCollector();
    for (const item of [line('* 1 FETCH (UID 42 FLAGS (\\Seen) BODY[] {5}'), literal('hello')]) {
      collector.accept(item);
    }

    expect(collector.finish()).toEqual([{ uid: 42, seqno: 1, body: 'hello', flags: ['\\Seen'] }]);
  });

  it('takes the rest of the line after the part marker as an inline body', () => {
    const collector = new FetchCollector();
    // The quoted form is not unquoted — this branch is carried over as it was,
    // and what servers actually send a body in is the literal above.
    collector.accept(line('* 7 FETCH (UID 9 FLAGS () BODY[] "short text")'));

    expect(collector.finish()).toEqual([
      { uid: 9, seqno: 7, body: '"short text")', flags: [] },
    ]);
  });

  it('pairs each body with the FETCH line before it, in order', () => {
    const collector = new FetchCollector();
    for (const item of [
      line('* 1 FETCH (UID 42 FLAGS () BODY[] {3}'),
      line('* 2 FETCH (UID 43 FLAGS () BODY[] {3}'),
      literal('one'),
      literal('two'),
    ]) {
      collector.accept(item);
    }

    expect(collector.finish().map((m) => [m.uid, m.body])).toEqual([
      [42, 'one'],
      [43, 'two'],
    ]);
  });

  it('ignores what is not part of a fetch reply', () => {
    const collector = new FetchCollector();
    for (const item of [
      line('* 3 EXISTS'),
      line('* OK [UIDVALIDITY 1] done'),
      cont('+ go ahead'),
      literal('a body nobody asked for'),
    ]) {
      collector.accept(item);
    }

    expect(collector.finish()).toEqual([]);
  });
});
