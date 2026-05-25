import tls from "node:tls";
import { Socket } from "node:net";
import type { ImapConfig } from "./connection.ts";
import { Transport } from "./transport.ts";
import { CommandDispatcher } from "./dispatch.ts";

const CRLF = "\r\n";

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Establish an IMAP connection: create socket, negotiate TLS/STARTTLS,
 * authenticate with LOGIN, and fetch CAPABILITY.  Returns a fully
 * authenticated Transport + CommandDispatcher pair ready for IMAP
 * operations.
 *
 * Timeouts are sourced from `config` (connTimeout, authTimeout,
 * commandTimeout) with sensible defaults.
 */
export async function connect(
  config: ImapConfig,
  debugEnabled: boolean,
): Promise<{ transport: Transport; dispatcher: CommandDispatcher; capabilities: Set<string> }> {
  const socket = await createSocket(config);
  let transport = new Transport(socket, debugEnabled);
  let dispatcher = new CommandDispatcher(transport, config.commandTimeout ?? 30_000);

  const greeting = await waitForGreeting(dispatcher, config);

  if (greeting.starttls) {
    const result = await starttls(dispatcher, socket, transport, debugEnabled, config);
    transport = result.transport;
    dispatcher = result.dispatcher;
  }

  const capabilities = new Set<string>();
  await login(dispatcher, config);
  await fetchCapabilities(dispatcher, capabilities);

  return { transport, dispatcher, capabilities };
}

// ── socket creation ────────────────────────────────────────────────────────

async function createSocket(config: ImapConfig): Promise<Socket> {
  const tlsEnabled = config.tls !== false;
  const timeout = config.connTimeout ?? 30_000;

  return new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Connection timed out"));
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
      socket.once("connect", () => onConnect(socket));
      socket.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    } else {
      const socket = new Socket();
      socket.connect(config.port, config.host);
      socket.once("connect", () => onConnect(socket));
      socket.once("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    }
  });
}

// ── greeting detection ─────────────────────────────────────────────────────

async function waitForGreeting(
  dispatcher: CommandDispatcher,
  config: ImapConfig,
): Promise<{ starttls: boolean }> {
  const tlsEnabled = config.tls !== false;

  return new Promise((resolve, reject) => {
    dispatcher.onUntagged((line) => {
      if (!line.startsWith("* OK") && !line.startsWith("* PREAUTH")) return;

      // Check for STARTTLS in greeting capabilities.
      const greetCaps = line.match(/CAPABILITY (.*)/i);
      const hasStarttls = greetCaps
        ? greetCaps[1].split(/\s+/).some((c) => c.toUpperCase() === "STARTTLS")
        : false;

      const wantStarttls = config.autotls === "always" || config.autotls === "required";
      const canStarttls = !tlsEnabled && hasStarttls;

      if (wantStarttls && !canStarttls && config.autotls === "required") {
        reject(new Error("STARTTLS required but not available"));
        return;
      }

      if (canStarttls && wantStarttls) {
        // Signal that STARTTLS upgrade is needed.  The caller will
        // call starttls() with the raw socket and await its completion
        // before proceeding to login.
        resolve({ starttls: true });
        return;
      }

      // No STARTTLS — proceed directly to login.
      resolve({ starttls: false });
    });
  });
}

// ── STARTTLS upgrade ────────────────────────────────────────────────────────

async function starttls(
  dispatcher: CommandDispatcher,
  rawSocket: Socket,
  _oldTransport: Transport,
  debugEnabled: boolean,
  config: ImapConfig,
): Promise<{ transport: Transport; dispatcher: CommandDispatcher }> {
  await dispatcher.sendCommand("STARTTLS");

  const tlsSocket = tls.connect({
    socket: rawSocket,
    host: config.host,
    ...config.tlsOptions,
  });

  const newTransport = new Transport(tlsSocket, debugEnabled);
  const newDispatcher = new CommandDispatcher(newTransport, config.commandTimeout ?? 30_000);

  return { transport: newTransport, dispatcher: newDispatcher };
}

// ── authentication ─────────────────────────────────────────────────────────

async function login(
  dispatcher: CommandDispatcher,
  config: ImapConfig,
): Promise<void> {
  const authTimeout = config.authTimeout ?? 10_000;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Authentication timed out"));
    }, authTimeout);

    dispatcher
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
  dispatcher: CommandDispatcher,
  capabilities: Set<string>,
): Promise<void> {
  try {
    const lines = await dispatcher.sendCommand("CAPABILITY");
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
