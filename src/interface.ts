import { type ConnectionOptions as TlsConnectionOptions } from 'tls';

export interface ImapConfig {
  user: string;
  password: string;
  host: string;
  port: number;
  /** Use implicit TLS (port 993). Default true. Set false for plain TCP. */
  tls?: boolean;
  /** TLS options passed to tls.connect(). */
  tlsOptions?: TlsConnectionOptions;
  /**
   * STARTTLS upgrade strategy.
   * - "always": attempt STARTTLS if server supports it
   * - "required": require STARTTLS, throw if unavailable
   * - undefined: never attempt STARTTLS (only use implicit TLS or plain)
   */
  autotls?: 'always' | 'required';
  /** Timeout for TLS handshake + server greeting (ms). Default 30_000. */
  connTimeout?: number;
  /** Timeout for LOGIN response (ms). Default 10_000. */
  authTimeout?: number;
  /** Per-command timeout (ms). Default 30_000. */
  commandTimeout?: number;
  /**
   * Enable protocol-level debug logging to stderr.
   * Logs every byte read/written and every line dispatched.
   * Can be toggled at runtime via conn.setDebug(bool).
   */
  debug?: boolean;
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

export interface IdleEvent {
  type: 'exists' | 'recent' | 'expunge' | 'fetch' | 'flags';
  seqno?: number;
  count?: number;
  uid?: number;
  flags?: string[];
}
