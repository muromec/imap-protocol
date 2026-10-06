// Unit tests for MailboxWatcher — the loop around Connection, and the half that
// decides whether mail reaches a caller at all.  docs/untested.md is scoped to
// connection.ts, so this loop had no tests on either side of the copy that lives
// in email-agent; these drive it against the same mock server.
//
// The scenario is strict (`allowExtra: false`): a command the watcher is not
// expected to send kills the socket, which is how an *absence* of a command —
// the `UID STORE … \Seen` this watcher used to send on every fetch — becomes
// observable at all.

import { afterAll, describe, expect, it } from 'vitest';

import { MailboxWatcher } from '../src/watcher.ts';
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

/** What the watcher does before it has mail to hand over, and what it does after:
 *  connect, look, fetch, hand over, and go idle.  Nothing else is expected, so a
 *  step that does not fit — a STORE, say — ends the conversation. */
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
  { expect: /^A\d+ IDLE$/, respond: '+ idling' },
];

function watch(server: MockImapServer, scenario: ScenarioStep[]) {
  server.scenario(scenario, { allowExtra: false });

  const watcher = new MailboxWatcher({
    user: 'test',
    password: 'secret',
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    reconnectDelay: 60_000,
  });

  const mail: FetchedMessage[][] = [];
  const errors: Error[] = [];
  let arrived: (() => void) | null = null;
  const first = new Promise<void>((resolve) => {
    arrived = resolve;
  });

  watcher.on('mail', (event) => {
    mail.push(event.messages ?? []);
    arrived?.();
  });
  watcher.on('error', (event) => {
    if (event.error) errors.push(event.error);
  });

  void watcher.start();

  return { watcher, mail, errors, first };
}

describe('MailboxWatcher', () => {
  it('hands mail over without flagging it read', async () => {
    const server = await newServer();
    const { watcher, mail, errors, first } = watch(server, handshake);

    // The wait is the mail event; the deadline is a failure guard, so a watcher
    // that hands nothing over fails here rather than at the runner's clock.
    await Promise.race([
      first,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('no mail was handed over')), 2000);
      }),
    ]);

    expect(mail).toHaveLength(1);
    expect(mail[0].map((m) => m.uid)).toEqual([5]);

    // The assertion is an absence, and it needs a settle point: the loop's next
    // move is IDLE, which the scenario allows.  A marking command sent before it
    // is an unexpected command, and the mock answers that by killing the socket —
    // which the watcher handles quietly (it reconnects after `reconnectDelay`),
    // so an error event is not the signal.  The instrument is the connection it
    // is holding: alive and idling after the settle, or dead because a STORE was
    // refused.  200 ms is a settled tick, not a wait for work.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(watcher.connection?.dead ?? true).toBe(false);

    watcher.stop();
  });
});
