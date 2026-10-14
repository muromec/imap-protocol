// Unit tests for Session — the loop that owns the socket.
//
// These speak raw lines rather than driving the mock IMAP server: what is
// under test is the loop's policy about who may write when and which reply
// settles which command, and a server double that answers only when it is told
// keeps that visible instead of hiding it behind a command-shaped machine.

import { afterAll, describe, expect, it } from 'vitest';
import { createServer, Socket, type Server } from 'node:net';

import { Session, type SessionOptions } from '../src/session.ts';
import { Transport } from '../src/transport.ts';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterAll(() => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close();
});

function connect(socket: Socket, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve();
    });
    socket.connect(port, '127.0.0.1');
  });
}

interface RawServer {
  session: Session;
  /** Every command line the client sent, in order. */
  received: string[];
  /** Answer with raw bytes, exactly as given. */
  answer(raw: string): void;
  /** Drop the connection. */
  hangUp(): void;
  /** Resolves when `n` command lines have arrived, or names what it waited. */
  lines(n: number, what: string, deadlineMs?: number): Promise<void>;
}

/** A server that accepts, records the lines it is sent, and says nothing until
 *  it is told to. */
async function startSession(options: SessionOptions = {}): Promise<RawServer> {
  const received: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let peer: Socket | null = null;

  const server = createServer((socket) => {
    peer = socket;
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let at: number;
      while ((at = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (!line) continue;
        received.push(line);
        for (const waiter of waiters.splice(0)) {
          if (received.length >= waiter.n) waiter.resolve();
          else waiters.push(waiter);
        }
      }
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const socket = new Socket();
  sockets.push(socket);
  const session = new Session(new Transport(socket), options);
  await connect(socket, port);

  return {
    session,
    received,
    answer: (raw) => peer?.write(raw, 'utf8'),
    hangUp: () => peer?.destroy(),
    lines: (n, what, deadlineMs = 2000) =>
      new Promise<void>((resolve, reject) => {
        if (received.length >= n) {
          resolve();
          return;
        }
        const timer = setTimeout(() => reject(new Error(`no ${what} within ${deadlineMs}ms`)), deadlineMs);
        waiters.push({
          n,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      }),
  };
}

/** Why each promise was rejected, or undefined where it resolved. */
function reasons(results: PromiseSettledResult<unknown>[]): (string | undefined)[] {
  return results.map((r) => (r.status === 'rejected' ? (r.reason as Error).message : undefined));
}

describe('Session', () => {
  it('writes commands asked for in one turn as one batch, before any reply is read', async () => {
    const server = await startSession();
    const first = server.session.sendCommand('NOOP "one"');
    const second = server.session.sendCommand('NOOP "two"');

    await server.lines(2, 'both commands on the wire');
    expect(server.received).toEqual(['A0001 NOOP "one"', 'A0002 NOOP "two"']);

    server.answer('A0001 OK one\r\nA0002 OK two\r\n');
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
  });

  it('shows an untagged line to the session and to the command that was outstanding', async () => {
    const server = await startSession();
    const seen: string[] = [];
    server.session.onUntagged((line) => seen.push(line));

    const sending = server.session.sendCommand('NOOP');
    await server.lines(1, 'the command');
    server.answer('* 3 EXISTS\r\nA0001 OK done\r\n');

    expect(await sending).toEqual(['* 3 EXISTS']);
    expect(seen).toEqual(['* 3 EXISTS']);
  });

  it('takes a NO as the server refusing the command, not as the connection going', async () => {
    const server = await startSession();
    const bad = server.session.sendCommand('NOOP "bad"');
    await server.lines(1, 'the first command');
    server.answer('A0001 NO no such command\r\n');

    await expect(bad).rejects.toThrow(/^NO: /);
    expect(server.session.dead).toBe(false);

    const good = server.session.sendCommand('NOOP "good"');
    await server.lines(2, 'the second command');
    server.answer('A0002 OK done\r\n');
    expect(await good).toEqual([]);
  });

  it('fails a command nobody answers, and says why to the commands it was batched with', async () => {
    const server = await startSession({ commandTimeout: 60 });

    const settled = await Promise.allSettled([
      server.session.sendCommand('NOOP "one"'),
      server.session.sendCommand('NOOP "two"'),
    ]);

    expect(reasons(settled)).toEqual([
      'Command timed out: NOOP "one"',
      'Connection closed: NOOP "one" timed out',
    ]);
    expect(server.session.dead).toBe(true);
  });

  it('fails what is outstanding when the connection goes, and ends once', async () => {
    const server = await startSession();
    const ends: string[] = [];
    server.session.onEnd((reason) => ends.push(reason.message));

    const sending = server.session.sendCommand('NOOP');
    await server.lines(1, 'the command');
    server.hangUp();

    await expect(sending).rejects.toThrow(/^Socket closed$/);
    expect(ends).toEqual(['Socket closed']);
    expect(server.session.dead).toBe(true);
  });

  it('opens a session on the first read, and hands its lines to the reader', async () => {
    const server = await startSession();
    const session = server.session.idle()[Symbol.asyncIterator]();

    const reading = session.next();
    await server.lines(1, 'the IDLE command');
    expect(server.received).toEqual(['A0001 IDLE']);

    server.answer('+ idling\r\n* 1 EXISTS\r\n');
    expect(await reading).toEqual({ done: false, value: '* 1 EXISTS' });
  });

  it('breaks the session for a command, then opens it again', async () => {
    const server = await startSession();
    const session = server.session.idle()[Symbol.asyncIterator]();
    const reading = session.next();
    await server.lines(1, 'the IDLE command');
    server.answer('+ idling\r\n');

    const command = server.session.sendCommand('NOOP');
    await server.lines(2, 'DONE');
    expect(server.received[1]).toBe('DONE');

    server.answer('A0001 OK IDLE completed\r\n');
    await server.lines(3, 'the command');
    expect(server.received[2]).toBe('A0002 NOOP');
    server.answer('A0002 OK done\r\n');
    expect(await command).toEqual([]);

    // the reader still wants lines, so the session stands again
    await server.lines(4, 'the session reopened');
    expect(server.received[3]).toBe('A0003 IDLE');
    server.answer('+ idling\r\n* 2 EXISTS\r\n');
    expect(await reading).toEqual({ done: false, value: '* 2 EXISTS' });

    const ending = session.return?.();
    await server.lines(5, 'DONE');
    server.answer('A0003 OK IDLE completed\r\n');
    await ending;
  });

  it('ends a session when its reader returns, and the connection carries on', async () => {
    const server = await startSession();
    const session = server.session.idle()[Symbol.asyncIterator]();
    const reading = session.next();
    await server.lines(1, 'the IDLE command');
    server.answer('+ idling\r\n');

    const ending = session.return?.();
    await server.lines(2, 'DONE');
    expect(server.received[1]).toBe('DONE');
    server.answer('A0001 OK IDLE completed\r\n');
    await ending;

    expect(await session.next()).toEqual({ done: true, value: undefined });

    const command = server.session.sendCommand('NOOP');
    await server.lines(3, 'the command');
    server.answer('A0002 OK done\r\n');
    expect(await command).toEqual([]);
  });

  it('stops the reader when the server ends the session', async () => {
    const server = await startSession();
    const session = server.session.idle()[Symbol.asyncIterator]();
    const reading = session.next();
    await server.lines(1, 'the IDLE command');
    server.answer('+ idling\r\n');

    server.answer('A0001 NO IDLE not here\r\n');
    expect(await reading).toEqual({ done: true, value: undefined });
  });

  it('ends a session its reader forgot about', async () => {
    const server = await startSession({ sessionTimeout: 60 });
    const session = server.session.idle()[Symbol.asyncIterator]();
    const reading = session.next();
    await server.lines(1, 'the IDLE command');

    // the guard closes the connection, and the reader hears the session end
    expect(await reading).toEqual({ done: true, value: undefined });
  });

  it('refuses a second session rather than replacing the first', async () => {
    const server = await startSession();
    server.session.idle();

    expect(() => server.session.idle()).toThrow(/already open/);
  });
});
