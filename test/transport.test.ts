// Unit tests for Transport's item stream — the input a session loop reads.
//
// The transport is a socket wrapper, so its double is a real socket: a
// MockImapServer on loopback with the transport over the client end.  What is
// under test is the framing (a line, a literal, a continuation, and the
// connection going), so each case states its own wire bytes rather than
// leaning on the mock's command machine for them.

import { afterAll, describe, expect, it, vi } from 'vitest';
import { Socket } from 'node:net';

import { Transport, TransportItems, type TransportItem } from '../src/transport.ts';
import { MockImapServer, type ScenarioStep } from '../scripts/imap-server-mock.ts';

const servers: MockImapServer[] = [];
const sockets: Socket[] = [];

afterAll(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
});

/** A fresh mock server, and a transport over a socket connected to it.  The
 *  scenario is configured before the connect, so the greeting is framed by it. */
async function connectTransport(
  steps: ScenarioStep[] = [],
  greeting = '* OK mock IMAP server ready',
  sink?: (line: string) => void,
): Promise<{ server: MockImapServer; socket: Socket; transport: Transport }> {
  const server = new MockImapServer();
  servers.push(server);
  await server.listening;
  server.scenario(steps, { allowExtra: true, greeting });

  const socket = new Socket();
  sockets.push(socket);
  const transport = new Transport(socket, false, sink);
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve();
    });
    socket.connect(server.port, '127.0.0.1');
  });
  return { server, socket, transport };
}

/** Await `work` under a deadline that names what it was waiting for, so a
 *  missing item fails where it happened rather than at the runner's clock. */
async function withDeadline<T>(what: string, work: Promise<T>, deadlineMs = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no ${what} within ${deadlineMs}ms`)), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Read exactly `n` items. */
async function take(
  items: AsyncIterator<TransportItem>,
  n: number,
  what: string,
): Promise<TransportItem[]> {
  const taken: TransportItem[] = [];
  for (let i = 0; i < n; i++) {
    const result = await withDeadline(what, items.next());
    if (result.done) {
      throw new Error(`the stream ended after ${taken.length} items, still waiting for ${what}`);
    }
    taken.push(result.value);
  }
  return taken;
}

/** A literal from text, so an expectation can state one. */
const literalOf = (text: string): TransportItem => ({ kind: 'literal', data: Buffer.from(text, 'utf8') });

/** A literal's octets as text — the test's convenience, not the library's. */
const bytes = (data: Uint8Array): string => Buffer.from(data).toString('utf8');

/** The same octets as hex, for the cases that are about the bytes themselves. */
const hex = (data: Uint8Array): string => Buffer.from(data).toString('hex');

describe('Transport items', () => {
  it('hands over a line, a literal and a continuation in wire order', async () => {
    const { transport } = await connectTransport([
      { expect: /^A1 FETCH /, respond: ['* 1 FETCH (BODY[] {5}', 'hello'] },
      { expect: /^A2 NOOP$/, respond: '+ nothing to say' },
    ]);
    const items = transport.items()[Symbol.asyncIterator]();

    expect(await take(items, 1, 'the greeting')).toEqual([
      { kind: 'line', line: '* OK mock IMAP server ready' },
    ]);

    transport.send('A1 FETCH 1 BODY[]');
    transport.send('A2 NOOP');
    expect(await take(items, 4, 'the fetch response and the continuation')).toEqual([
      { kind: 'line', line: '* 1 FETCH (BODY[] {5}' },
      literalOf('hello'),
      { kind: 'line', line: 'A1 OK done' },
      { kind: 'continue', line: '+ nothing to say' },
    ]);
  });

  it('reports the connection going as an item, and then finishes', async () => {
    const { server, transport } = await connectTransport();
    const items = transport.items()[Symbol.asyncIterator]();
    await take(items, 1, 'the greeting');

    server.close();

    const [item] = await take(items, 1, 'the connection ending');
    expect(item).toEqual({ kind: 'ended' });
    expect(transport.dead).toBe(true);
    expect((await withDeadline('the iteration to finish', items.next())).done).toBe(true);
  });

  it('names a socket error on the last item', async () => {
    const { socket, transport } = await connectTransport();
    const items = transport.items()[Symbol.asyncIterator]();
    await take(items, 1, 'the greeting');

    socket.emit('error', new Error('boom'));

    const [item] = await take(items, 1, 'the connection ending');
    expect(item.kind).toBe('ended');
    expect(item.kind === 'ended' && item.error?.message).toBe('boom');
    expect(transport.dead).toBe(true);
  });

  it('holds what arrives before a reader starts, and ends once', async () => {
    const stream = new TransportItems();
    stream.push({ kind: 'line', line: 'one' });
    stream.push(literalOf('two'));
    stream.end(new Error('gone'));
    stream.push({ kind: 'line', line: 'after the end' }); // must be ignored

    const taken: TransportItem[] = [];
    for await (const item of stream) taken.push(item);
    expect(taken.length).toBe(3);
    expect(taken.slice(0, 2)).toEqual([
      { kind: 'line', line: 'one' },
      literalOf('two'),
    ]);
    expect(taken[2]?.kind).toBe('ended');
    expect(taken[2]?.kind === 'ended' && taken[2].error?.message).toBe('gone');

    // the ended item was the last one: a second pass finds nothing left
    const rest: TransportItem[] = [];
    for await (const item of stream) rest.push(item);
    expect(rest).toEqual([]);
  });
});

// ── framing counts octets ───────────────────────────────────────────────────
//
// IMAP declares a literal's size in octets, and a message body is bytes: a
// client that counts characters reads past the body and frames what follows it
// wrongly.  A character split between two TCP chunks is the same mistake at a
// smaller scale.

/** A transport over a socket nobody connects: the test writes the chunks, which
 *  is the only way to break one exactly where it hurts — inside a character. */
function chunkedTransport(): {
  transport: Transport;
  feed: (...chunks: Array<string | Uint8Array>) => void;
} {
  const socket = new Socket();
  sockets.push(socket);
  const transport = new Transport(socket, false);
  const feed = (...chunks: Array<string | Uint8Array>): void => {
    for (const chunk of chunks) {
      socket.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
    }
  };
  return { transport, feed };
}

describe('framing counts octets', () => {
  it("takes a literal's declared size as octets, so the line after it frames", async () => {
    // 'héllo' is five characters and six octets: the server says {6}.
    const { transport } = await connectTransport([
      { expect: /^A1 FETCH /, respond: ['* 1 FETCH (BODY[] {6}', 'héllo'] },
    ]);
    const items = transport.items()[Symbol.asyncIterator]();
    await take(items, 1, 'the greeting');

    transport.send('A1 FETCH 1 BODY[]');

    const [fetch, literal, reply] = await take(items, 3, 'the fetched line, its literal and the reply');
    expect(fetch).toEqual({ kind: 'line', line: '* 1 FETCH (BODY[] {6}' });
    if (literal?.kind !== 'literal') throw new Error(`expected a literal, got ${String(literal?.kind)}`);
    expect(literal.data).toBeInstanceOf(Uint8Array);
    expect(literal.data.length).toBe(6);
    expect(bytes(literal.data)).toBe('héllo');
    // the CRLF ends the fetched line: it is not part of the body
    expect(reply).toEqual({ kind: 'line', line: 'A1 OK done' });
  });

  it('keeps a character whole when the socket breaks it across chunks', async () => {
    const { transport, feed } = chunkedTransport();
    const items = transport.items()[Symbol.asyncIterator]();

    feed('* 1 FETCH (BODY[] {2}\r\n');
    feed(Uint8Array.from([0xc3])); // the first half of 'é'
    feed(Uint8Array.from([0xa9]), '\r\nA1 OK done\r\n');

    const [fetch, literal, reply] = await take(items, 3, 'the fetched line, its literal and the reply');
    expect(fetch).toEqual({ kind: 'line', line: '* 1 FETCH (BODY[] {2}' });
    if (literal?.kind !== 'literal') throw new Error(`expected a literal, got ${String(literal?.kind)}`);
    expect(hex(literal.data)).toBe('c3a9');
    expect(reply).toEqual({ kind: 'line', line: 'A1 OK done' });
  });

  it('keeps a character whole when a line is broken across chunks', async () => {
    const { transport, feed } = chunkedTransport();
    const items = transport.items()[Symbol.asyncIterator]();

    feed('* OK caf');
    feed(Uint8Array.from([0xc3]));
    feed(Uint8Array.from([0xa9]), ' ready\r\n');

    expect(await take(items, 1, 'the untagged line')).toEqual([
      { kind: 'line', line: '* OK café ready' },
    ]);
  });
});

// ── debug logging, switched at runtime ──────────────────────────────────────
//
// The outgoing side is a wrapper around `socket.write`, so a caller who turns
// logging on after the connection is up would see the server's answers and never
// what was sent — the half that usually matters.

describe('debug logging switched at runtime', () => {
  /** Every console.error call the transport made, as one line each. */
  async function logged(act: (transport: Transport) => void): Promise<string[]> {
    const { transport } = await connectTransport();
    const written: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      written.push(args);
    });
    try {
      act(transport);
    } finally {
      spy.mockRestore();
    }
    return written.map((args) => args.map((a) => String(a)).join(' '));
  }

  it('logs what it sends once it is switched on', async () => {
    const lines = await logged((transport) => {
      transport.setDebug(true);
      transport.send('A001 NOOP');
    });
    expect(lines.some((line) => line.includes('→') && line.includes('A001 NOOP'))).toBe(true);
  });

  it('says nothing while it is off, and stops when it is switched back off', async () => {
    const off = await logged((transport) => {
      transport.send('A001 NOOP');
    });
    expect(off).toEqual([]);

    const afterOff = await logged((transport) => {
      transport.setDebug(true);
      transport.send('A002 NOOP');
      transport.setDebug(false);
      transport.send('A003 NOOP');
    });
    expect(afterOff.some((line) => line.includes('A002'))).toBe(true);
    expect(afterOff.some((line) => line.includes('A003'))).toBe(false);
  });
});

// ── where debug lines go ────────────────────────────────────────────────────
//
// One process can hold several connections, and the console cannot say whose line
// is whose: a caller that wants them apart passes `debugSink`.

describe('debug lines and the sink', () => {
  it('hands a line to the sink and leaves the console alone', async () => {
    const lines: string[] = [];
    const { transport } = await connectTransport([], '* OK mock IMAP server ready', (line) =>
      lines.push(line),
    );
    const consoleLines: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleLines.push(args);
    });

    try {
      transport.setDebug(true);
      transport.send('A001 NOOP');
    } finally {
      spy.mockRestore();
    }

    expect(lines.some((line) => line.includes('→') && line.includes('A001 NOOP'))).toBe(true);
    expect(consoleLines).toEqual([]);
  });

  it('falls back to the console when no sink was named', async () => {
    const { transport } = await connectTransport();
    const consoleLines: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleLines.push(args);
    });

    try {
      transport.setDebug(true);
      transport.send('A002 NOOP');
    } finally {
      spy.mockRestore();
    }

    expect(consoleLines.some((call) => String(call[0]).includes('A002 NOOP'))).toBe(true);
  });
});
