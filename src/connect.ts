import tls from 'node:tls';
import { Socket } from 'node:net';
import type { ImapConfig } from './interface.ts';
import { Transport } from './transport.ts';
import { Session } from './session.ts';

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Establish an IMAP connection: create socket, negotiate TLS/STARTTLS,
 * authenticate with LOGIN, and fetch CAPABILITY.  Returns a fully
 * authenticated Transport + Session pair ready for IMAP
 * operations.
 *
 * Timeouts are sourced from `config` (connTimeout, authTimeout,
 * commandTimeout) with sensible defaults.
 */
export async function connect(
  config: ImapConfig,
  debugEnabled: boolean,
): Promise<{ transport: Transport; session: Session; capabilities: Set<string> }> {
  const socket = await createSocket(config);
  let transport = new Transport(socket, debugEnabled);
  let session = new Session(transport, { commandTimeout: config.commandTimeout ?? 30_000 });

  const greeting = await waitForGreeting(session, config);

  if (greeting.starttls) {
    const result = await starttls(session, socket, transport, debugEnabled, config);
    transport = result.transport;
    session = result.session;
  }

  const capabilities = new Set<string>();
  if (!greeting.preauth) {
    await login(session, config);
  }
  await fetchCapabilities(session, capabilities);

  return { transport, session, capabilities };
}

// ── socket creation ────────────────────────────────────────────────────────

async function createSocket(config: ImapConfig): Promise<Socket> {
  const tlsEnabled = config.tls !== false;
  const timeout = config.connTimeout ?? 30_000;

  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Connection timed out'));
    }, timeout);

    const onConnect = (socket: Socket) => {
      clearTimeout(timer);
      resolve(socket);
    };

    if (tlsEnabled) {
      const socket = tls.connect({
        host: config.host,
        port: config.port,
        ...config.tlsOptions,
      });
      socket.once('connect', () => onConnect(socket));
      socket.once('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    } else {
      const socket = new Socket();
      socket.connect(config.port, config.host);
      socket.once('connect', () => onConnect(socket));
      socket.once('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    }
  });
}

// ── greeting detection ─────────────────────────────────────────────────────

async function waitForGreeting(
  session: Session,
  config: ImapConfig,
): Promise<{ starttls: boolean; preauth: boolean }> {
  const tlsEnabled = config.tls !== false;

  return new Promise((resolve, reject) => {
    session.onUntagged((line) => {
      if (!line.startsWith('* OK') && !line.startsWith('* PREAUTH')) return;

      // Check for STARTTLS in greeting capabilities.
      const greetCaps = line.match(/CAPABILITY (.*)/i);
      const hasStarttls = greetCaps
        ? greetCaps[1].split(/\s+/).some((c) => c.toUpperCase() === 'STARTTLS')
        : false;

      const wantStarttls = config.autotls === 'always' || config.autotls === 'required';
      const canStarttls = !tlsEnabled && hasStarttls;

      if (wantStarttls && !canStarttls && config.autotls === 'required') {
        reject(new Error('STARTTLS required but not available'));
        return;
      }

      if (canStarttls && wantStarttls) {
        // Signal that STARTTLS upgrade is needed.  The caller will
        // call starttls() with the raw socket and await its completion
        // before proceeding to login.
        resolve({ starttls: true, preauth: false });
        return;
      }

      // No STARTTLS — proceed directly to login.
      resolve({ starttls: false, preauth: line.startsWith('* PREAUTH') });
    });
  });
}

// ── STARTTLS upgrade ────────────────────────────────────────────────────────

async function starttls(
  session: Session,
  rawSocket: Socket,
  _oldTransport: Transport,
  debugEnabled: boolean,
  config: ImapConfig,
): Promise<{ transport: Transport; session: Session }> {
  await session.sendCommand('STARTTLS');

  const tlsSocket = tls.connect({
    socket: rawSocket,
    host: config.host,
    ...config.tlsOptions,
  });

  const newTransport = new Transport(tlsSocket, debugEnabled);
  const newSession = new Session(newTransport, { commandTimeout: config.commandTimeout ?? 30_000 });

  return { transport: newTransport, session: newSession };
}

// ── authentication ─────────────────────────────────────────────────────────

async function login(session: Session, config: ImapConfig): Promise<void> {
  const authTimeout = config.authTimeout ?? 10_000;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Authentication timed out'));
    }, authTimeout);

    session
      .sendCommand(`LOGIN "${config.user}" "${config.password}"`)
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

// ── capability detection ───────────────────────────────────────────────────

async function fetchCapabilities(
  session: Session,
  capabilities: Set<string>,
): Promise<void> {
  try {
    const lines = await session.sendCommand('CAPABILITY');
    for (const line of lines) {
      const m = line.match(/^\* CAPABILITY (.*)/i);
      if (m) {
        for (const cap of m[1].split(/\s+/)) {
          capabilities.add(cap.toUpperCase());
        }
      }
    }
  } catch {
    // Best-effort: resolve even if CAPABILITY fails.
  }
}
