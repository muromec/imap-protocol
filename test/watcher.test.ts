// Unit tests for MailboxWatcher — the loop around Connection, and the half that
// decides whether mail reaches a caller at all.  docs/untested.md is scoped to
// connection.ts, so this loop had no tests on either side of the copy that lives
// in email-agent; these drive it against the same mock server.
//
// The scenario is strict (`allowExtra: false`): a command the watcher is not
// expected to send kills the socket.  That is what makes both halves of the flag
// observable — its presence under the default, and its absence under
// `markSeen: false`.

import { afterAll, describe, expect, it } from 'vitest';

import { MailboxWatcher, type WatcherConfig } from '../src/watcher.ts';
import type { FetchedMessage } from '../src/interface.ts';
import { MockImapServer, type ScenarioStep } from '../scripts/imap-server-mock.ts';

const cleanup: MockImapServer[] = [];

afterAll(() => {
  for (const srv of cleanup) srv.close();
});

async function newServer(): Promise<MockImapServer> {
  const srv = new MockImapServer();
  await srv.listening;
  cleanup.push(srv);
  return srv;
}

/**
 * What happened, in order, on both sides of the wire: the watcher writes `mail`
 * when it hands a message over, the server writes `flag` when the `\Seen` arrives
 * and `idle` when the loop asks for IDLE.  "Delivered before flagged" is a claim
 * about who went first, and these are the only witnesses to it.
 */
type Trace = string[];

/** Wait for a witness, with a deadline so a missing one fails where it happened
 *  rather than at the runner's clock. */
function until(trace: Trace, what: string, deadlineMs = 2000): Promise<void> {
  const started = Date.now();
  const tick = (): void | Promise<void> => {
    if (trace.includes(what)) return;
    if (Date.now() - started > deadlineMs) {
      return Promise.reject(
        new Error(`the ${what} never arrived (trace: ${trace.join(', ') || 'empty'})`),
      );
    }
    return new Promise((r) => setTimeout(r, 5)).then(tick);
  };
  return Promise.resolve(tick());
}

/** Up to the point where the watcher has mail to hand over. */
const handshake: ScenarioStep[] = [
  { expect: /^A\d+ LOGIN /, respond: (cmd) => `${cmd.match(/^A\d+/)![0]} OK logged in` },
  { expect: /^A\d+ CAPABILITY$/, respond: '* CAPABILITY IMAP4rev1 UIDPLUS MOVE IDLE' },
  {
    expect: /^A\d+ SELECT "INBOX"$/,
    respond: ['* 2 EXISTS', '* 0 RECENT', '* OK [UIDVALIDITY 1] done'],
  },
  { expect: /^A\d+ UID SEARCH UNSEEN$/, respond: '* SEARCH 5' },
  {
    expect: /^A\d+ UID FETCH 5 \(UID FLAGS BODY\.PEEK\[\]\)$/,
    respond: ['* 1 FETCH (UID 5 FLAGS () BODY[] {1}', 'a'],
  },
];

/** Where the loop settles once it has done everything it was asked to do. */
const idling = (trace: Trace): ScenarioStep => ({
  expect: /^A\d+ IDLE$/,
  respond: () => {
    trace.push('idle');
    return '+ idling';
  },
});

const flagStep = (trace: Trace, status = 'OK stored'): ScenarioStep => ({
  expect: /^A\d+ UID STORE 5 \+FLAGS\.SILENT \(\\Seen\)$/,
  respond: (cmd) => {
    trace.push('flag');
    return `${cmd.match(/^A\d+/)![0]} ${status}`;
  },
});

function watch(
  server: MockImapServer,
  scenario: ScenarioStep[],
  trace: Trace,
  config: Partial<WatcherConfig> = {},
) {
  server.scenario(scenario, { allowExtra: false });

  const watcher = new MailboxWatcher({
    user: 'test',
    password: 'secret',
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    reconnectDelay: 60_000,
    ...config,
  });

  const mail: FetchedMessage[][] = [];
  const errors: Error[] = [];

  watcher.on('mail', (event) => {
    trace.push('mail');
    mail.push(event.messages ?? []);
  });
  watcher.on('error', (event) => {
    if (event.error) errors.push(event.error);
  });

  void watcher.start();

  return { watcher, mail, errors };
}

describe('MailboxWatcher', () => {
  it('flags what it delivered, and only after delivering it', async () => {
    const server = await newServer();
    const trace: Trace = [];
    const { watcher, mail } = watch(server, [...handshake, flagStep(trace), idling(trace)], trace);

    await until(trace, 'flag');
    await until(trace, 'idle');

    expect(mail).toHaveLength(1);
    expect(mail[0].map((m) => m.uid)).toEqual([5]);

    // The order is the point: the caller was given the message before the flag
    // went out, so a caller that fails mid-delivery has not lost it.
    expect(trace.slice(0, 2)).toEqual(['mail', 'flag']);
    expect(watcher.connection?.dead ?? true).toBe(false);

    watcher.stop();
  });

  it('leaves the flag to the caller when told to', async () => {
    const server = await newServer();
    const trace: Trace = [];
    const { watcher, mail } = watch(server, [...handshake, idling(trace)], trace, {
      markSeen: false,
    });

    // The barrier for an absence is the next thing the loop does: reaching IDLE
    // says it went past the fetch without sending anything.  A flag here would be
    // an unexpected command, the mock kills the socket for that, and IDLE would
    // never be sent — so this wait is what the absence rests on.
    await until(trace, 'idle');

    expect(mail).toHaveLength(1);
    expect(trace).toEqual(['mail', 'idle']);
    expect(watcher.connection?.dead ?? true).toBe(false);

    watcher.stop();
  });

  it('reports a refused flag instead of swallowing it', async () => {
    const server = await newServer();
    const trace: Trace = [];
    const { watcher, errors } = watch(
      server,
      [...handshake, flagStep(trace, 'NO mailbox is read-only'), idling(trace)],
      trace,
    );

    // IDLE comes after the failed flag, so reaching it means the error has been
    // emitted and the loop carried on.
    await until(trace, 'idle');

    expect(errors.map(String).join(' | ')).toMatch(/read-only/);
    expect(watcher.connection?.dead ?? true).toBe(false);

    watcher.stop();
  });

  it('ends every keepalive cycle with DONE, so the server never gives up on it', async () => {
    // A server with its own IDLE limit, as a real one has: a session that sends no
    // DONE within it is answered `BAD Expected DONE` and the connection has to be
    // rebuilt — which is what the loop did once per cycle before this was fixed.
    const server = await newServer();
    server.scenario([], { idleLoop: true, idleLimitMs: 1_500 });

    const watcher = new MailboxWatcher({
      user: 'test',
      password: 'secret',
      host: '127.0.0.1',
      port: server.port,
      tls: false,
      keepaliveInterval: 150,
      reconnectDelay: 60_000,
      markSeen: false,
    });

    // Armed before the loop runs: the first end of an IDLE session decides this case.
    // The deadline is only a guard — it fails here, naming what it waited for, rather
    // than at the runner's clock.
    const verdict = Promise.race([
      server.nextIdleOutcome(),
      new Promise<'none'>((r) => setTimeout(() => r('none'), 3_000)),
    ]);
    void watcher.start().catch(() => {});

    const outcome = await verdict;
    expect(`saw ${outcome}; commands: ${server.received.join(' | ')}`).toMatch(/^saw done;/);
    expect(server.badDones).toBe(0);
    expect(server.connections).toBe(1);

    watcher.stop();
  });

  it('ends the session it was in before fetching mail that arrived during it', async () => {
    // A session left without DONE keeps standing on the wire, and the connection
    // refuses the next one — so the loop dies the next time round.  Both halves are
    // asserted: the session is ended, and the loop goes on.
    const server = await newServer();
    server.scenario([], { idleLoop: true });

    const watcher = new MailboxWatcher({
      user: 'test',
      password: 'secret',
      host: '127.0.0.1',
      port: server.port,
      tls: false,
      keepaliveInterval: 60_000,
      reconnectDelay: 60_000,
      markSeen: false,
    });

    const errors: string[] = [];
    watcher.on('error', (event) => {
      if (event.error) errors.push(event.error.message);
    });

    void watcher.start().catch(() => {});
    await server.idled(1);

    // Mail arrives while the session stands, the way a real server says so.
    server.deliver('* 3 EXISTS');

    // The loop ends that session through DONE, fetches, and opens another.  The
    // deadline is a guard: it fails here, naming what was waited for, rather than at
    // the runner's clock.
    const round = await Promise.race([
      server.idled(2).then(() => 'second session'),
      new Promise<'none'>((r) => setTimeout(() => r('none'), 2_000)),
    ]);
    expect(
      `round: ${round}; errors: [${errors.join(', ')}]; commands: ${server.received.join(' | ')}`,
    ).toMatch(/^round: second session; errors: \[\]; .*DONE \| A\d+ UID SEARCH UNSEEN \| A\d+ IDLE$/);
    expect(server.connections).toBe(1);

    watcher.stop();
  });
});
