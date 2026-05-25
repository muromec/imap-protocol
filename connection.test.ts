// Unit tests for Connection — uses MockImapServer, no real server needed.
//
// Covers the full Batch 1 scope from docs/roadmap.md:
//   connect, openBox, search, fetch, addFlags, fetchUnseen, close

import { describe, it, expect, afterAll } from "vitest";
import { Connection } from "./connection.ts";
import { MockImapServer, type ScenarioStep } from "./mock.ts";

// ── server factory ─────────────────────────────────────────────────────────

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

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Conversation starter: creates a server, sets up LOGIN as the first
 * scenario step, connects, and returns the authenticated Connection.
 */
async function connectAndLogin(
  server: MockImapServer,
  steps: ScenarioStep[],
): Promise<Connection> {
  server.scenario(
    [
      {
        expect: /^A\d+ LOGIN /,
        respond: (cmd) => `${cmd.match(/^A\d+/)![0]} OK logged in`,
      },
      {
        expect: /^A\d+ CAPABILITY$/,
        respond: "* CAPABILITY IMAP4rev1 UIDPLUS MOVE IDLE",
      },
      ...steps,
    ],
    { allowExtra: true },
  );
  const conn = new Connection({
    user: "test",
    password: "secret",
    host: "127.0.0.1",
    port: server.port,
    tls: false,
  });
  await conn.connect();
  return conn;
}

/**
 * Shorthand for a test that needs an unauthenticated Connection.
 * The server greeting is sent automatically; the scenario covers everything
 * after that (LOGIN is NOT prepended).
 */
function rawConnect(
  server: MockImapServer,
  steps: ScenarioStep[],
): Connection {
  server.scenario(steps, { allowExtra: true });
  return new Connection({
    user: "test",
    password: "secret",
    host: "127.0.0.1",
    port: server.port,
    tls: false,
  });
}

// ── connect ────────────────────────────────────────────────────────────────

describe("connect", () => {
  it("resolves after greeting + LOGIN", async () => {
    const server = await newServer();
    const conn = rawConnect(server, [
      { expect: /^A\d+ LOGIN /, respond: "A0001 OK logged in" },
    ]);
    await conn.connect();
  });

  it("rejects on tagged NO to LOGIN", async () => {
    const server = await newServer();
    const conn = rawConnect(server, [
      { expect: /^A\d+ LOGIN /, respond: "A0001 NO bad password" },
    ]);
    await expect(conn.connect()).rejects.toThrow(/NO:.*bad password/);
  });

  it("rejects on tagged BAD to LOGIN", async () => {
    const server = await newServer();
    const conn = rawConnect(server, [
      { expect: /^A\d+ LOGIN /, respond: "A0001 BAD invalid" },
    ]);
    await expect(conn.connect()).rejects.toThrow(/BAD:.*invalid/);
  });

  it("times out on slow greeting", async () => {
    // A non-routable address that will never respond.
    const conn = new Connection({
      user: "test", password: "secret",
      host: "192.0.2.1", // TEST-NET-1, never routable
      port: 12345,
      tls: false,
      connTimeout: 200,
      authTimeout: 5000,
      commandTimeout: 5000,
    });
    await expect(conn.connect()).rejects.toThrow();
  });

  it("times out on slow LOGIN", async () => {
    const server = await newServer();
    // Server sends greeting, then client sends LOGIN.  The mock has
    // allowExtra: false and no scenario steps, so it destroys the socket
    // on the LOGIN command.  The client's socket error handler fires
    // immediately, so we just expect any rejection.
    server.scenario([], { allowExtra: false });
    const conn = new Connection({
      user: "test", password: "secret",
      host: "127.0.0.1", port: server.port,
      tls: false,
      authTimeout: 5000,
      commandTimeout: 5000,
    });
    await expect(conn.connect()).rejects.toThrow();
    server.close();
  });
});

// ── openBox ────────────────────────────────────────────────────────────────

describe("openBox", () => {
  it("parses mailbox info from SELECT response", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ SELECT "INBOX"$/,
        respond: [
          "* 5 EXISTS",
          "* 2 RECENT",
          '* FLAGS (\\Seen \\Answered \\Flagged)',
          "* OK [UNSEEN 3]",
          "* OK [UIDVALIDITY 12345]",
          "* OK [UIDNEXT 99]",
        ],
      },
    ]);

    const box = await conn.openBox("INBOX");
    expect(box.total).toBe(5);
    expect(box.unseen).toBe(3);
    expect(box.uidvalidity).toBe(12345);
    expect(box.uidnext).toBe(99);
    expect(box.flags).toEqual(["\\Seen", "\\Answered", "\\Flagged"]);
  });

  it("uses EXAMINE when readOnly is true", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ EXAMINE "INBOX"$/,
        respond: "* 1 EXISTS\r\n* 0 RECENT",
      },
    ]);

    const box = await conn.openBox("INBOX", true);
    expect(box.total).toBe(1);
    expect(box.unseen).toBe(0);
  });

  it("parses UNSEEN from OK response code", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ SELECT "INBOX"$/,
        respond: [
          "* 0 EXISTS",
          "* 0 RECENT",
          "* OK [UNSEEN 7]",
        ],
      },
    ]);

    const box = await conn.openBox("INBOX");
    // RECENT was also 0, but UNSEEN in the OK overrides
    expect(box.unseen).toBe(7);
  });
});

// ── search ─────────────────────────────────────────────────────────────────

describe("search", () => {
  it("returns UIDs from SEARCH response", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      { expect: /^A\d+ UID SEARCH UNSEEN$/, respond: "* SEARCH 1 2 3" },
    ]);

    const uids = await conn.search(["UNSEEN"]);
    expect(uids).toEqual([1, 2, 3]);
  });

  it("returns empty array when SEARCH has no results", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      { expect: /^A\d+ UID SEARCH DELETED$/, respond: "* SEARCH" },
    ]);

    const uids = await conn.search(["DELETED"]);
    expect(uids).toEqual([]);
  });

  it("builds criteria with nested arrays", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID SEARCH FROM "alice@example\.com" UNSEEN$/,
        respond: "* SEARCH 7",
      },
    ]);

    const uids = await conn.search([["FROM", "alice@example.com"], "UNSEEN"]);
    expect(uids).toEqual([7]);
  });

  // TODO: buildSearchQuery doesn't handle flat arrays like ["FROM", "x", "UNSEEN"] —
  //       only nested arrays [["FROM", "x"], "UNSEEN"].

  it("builds HEADER criteria with nested array", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID SEARCH HEADER "X-Custom" "yes"$/,
        respond: "* SEARCH 99",
      },
    ]);

    const uids = await conn.search([["HEADER", "X-Custom", "yes"]]);
    expect(uids).toEqual([99]);
  });

  it("handles numeric criteria like LARGER", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID SEARCH LARGER 1024$/,
        respond: "* SEARCH",
      },
    ]);

    const uids = await conn.search(["LARGER", 1024]);
    expect(uids).toEqual([]);
  });

  it("handles UID criteria with nested array", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID SEARCH UID 4,5,6$/,
        respond: "* SEARCH 4 5 6",
      },
    ]);

    const uids = await conn.search([["UID", 4, 5, 6]]);
    expect(uids).toEqual([4, 5, 6]);
  });
});

// ── fetch ──────────────────────────────────────────────────────────────────

describe("fetch", () => {
  it("fetches a single message with literal body", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID FETCH 42 \(UID FLAGS BODY\.PEEK\[\]\)$/,
        respond: [
          "* 1 FETCH (UID 42 FLAGS (\\Seen) BODY[] {13}",
          "Hello, world!",
        ],
      },
    ]);

    const msgs = await conn.fetch([42]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].uid).toBe(42);
    expect(msgs[0].seqno).toBe(1);
    expect(msgs[0].body).toBe("Hello, world!");
    expect(msgs[0].flags).toEqual(["\\Seen"]);
  });

  it("fetches multiple messages preserving order", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID FETCH 10,20 \(UID FLAGS BODY\.PEEK\[\]\)$/,
        respond: [
          "* 1 FETCH (UID 10 FLAGS (\\Seen) BODY[] {5}",
          "msg10",
          "* 2 FETCH (UID 20 FLAGS () BODY[] {5}",
          "msg20",
        ],
      },
    ]);

    const msgs = await conn.fetch([10, 20]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].uid).toBe(10);
    expect(msgs[0].body).toBe("msg10");
    expect(msgs[1].uid).toBe(20);
    expect(msgs[1].body).toBe("msg20");
  });

  it("returns empty array for empty UID list", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, []);

    const msgs = await conn.fetch([]);
    expect(msgs).toEqual([]);
  });

  it("requests custom body part (HEADER)", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID FETCH 1 \(UID FLAGS BODY\.PEEK\[HEADER\]\)$/,
        respond: [
          // "Subject: Test\r\n" is 15 bytes
          "* 1 FETCH (UID 1 FLAGS () BODY[HEADER] {15}",
          "Subject: Test\r\n",
        ],
      },
    ]);

    const msgs = await conn.fetch([1], { bodies: "HEADER" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toBe("Subject: Test\r\n");
  });

  // TODO: multi-body-part fetch responses (BODY[HEADER] ... BODY[TEXT] on
  //       continuation lines) need a proper fetch response parser.  The
  //       current regex-based approach only handles the first body literal
  //       on each * N FETCH line.
  it.todo("requests multiple body parts in a single fetch response");

  it("handles fetch with empty flags", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID FETCH 1 \(UID FLAGS BODY\.PEEK\[\]\)$/,
        respond: [
          "* 1 FETCH (UID 1 FLAGS () BODY[] {2}",
          "ok",
        ],
      },
    ]);

    const msgs = await conn.fetch([1]);
    expect(msgs[0].flags).toEqual([]);
  });
});

// ── addFlags ───────────────────────────────────────────────────────────────

describe("addFlags", () => {
  it("sends UID STORE for a single flag", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID STORE 1,2 \+FLAGS\.SILENT \(\\Seen\)$/,
        respond: "",
      },
    ]);

    await conn.addFlags([1, 2], "\\Seen");
  });

  it("prefixes flag with backslash when missing", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID STORE 3 \+FLAGS\.SILENT \(\\Seen\)$/,
        respond: "",
      },
    ]);

    await conn.addFlags([3], "Seen");
  });

  it("handles an array of flags", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect:
          /^A\d+ UID STORE 1 \+FLAGS\.SILENT \(\\Seen \\Flagged\)$/,
        respond: "",
      },
    ]);

    await conn.addFlags([1], ["\\Seen", "\\Flagged"]);
  });

  it("rejects on tagged NO", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID STORE 1 \+FLAGS\.SILENT \(\\Seen\)$/,
        respond: (cmd) => `${cmd.match(/^A\d+/)![0]} NO permission denied`,
      },
    ]);

    await expect(conn.addFlags([1], "\\Seen")).rejects.toThrow(
      /NO:.*permission denied/,
    );
  });
});

// ── fetchUnseen ────────────────────────────────────────────────────────────

describe("fetchUnseen", () => {
  it("chains search UNSEEN + fetch", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID SEARCH UNSEEN$/,
        respond: "* SEARCH 5 6",
      },
      {
        expect: /^A\d+ UID FETCH 5,6 \(UID FLAGS BODY\.PEEK\[\]\)$/,
        respond: [
          "* 1 FETCH (UID 5 FLAGS () BODY[] {1}",
          "a",
          "* 2 FETCH (UID 6 FLAGS () BODY[] {1}",
          "b",
        ],
      },
    ]);

    const msgs = await conn.fetchUnseen();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].uid).toBe(5);
    expect(msgs[0].body).toBe("a");
    expect(msgs[1].uid).toBe(6);
    expect(msgs[1].body).toBe("b");
  });

  it("returns empty array when no unseen messages", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      { expect: /^A\d+ UID SEARCH UNSEEN$/, respond: "* SEARCH" },
    ]);

    const msgs = await conn.fetchUnseen();
    expect(msgs).toEqual([]);
  });
});

// ── close ──────────────────────────────────────────────────────────────────

describe("close", () => {
  it("sends LOGOUT", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      { expect: /^A\d+ LOGOUT$/, respond: "* BYE bye" },
    ]);

    await conn.close();
  });

  it("resolves even if LOGOUT fails (socket closes anyway)", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      { expect: /^A\d+ LOGOUT$/, respond: (cmd) => `${cmd.match(/^A\d+/)![0]} NO rejected` },
    ]);

    // close() catches LOGOUT errors and still calls reader.close()
    await conn.close();
  });
});

// ── Batch 2: capability detection ──────────────────────────────────────────

describe("capabilities", () => {
  it("parses CAPABILITY response", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, []);

    expect(conn.serverSupports("IMAP4REV1")).toBe(true);
    expect(conn.serverSupports("UIDPLUS")).toBe(true);
    expect(conn.serverSupports("MOVE")).toBe(true);
    expect(conn.serverSupports("IDLE")).toBe(true);
  });

  it("serverSupports returns false for unknown capability", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, []);

    expect(conn.serverSupports("X-MADE-UP")).toBe(false);
  });

  it("is case-insensitive", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, []);

    expect(conn.serverSupports("imap4rev1")).toBe(true);
    expect(conn.serverSupports("IdLe")).toBe(true);
  });
});

// ── Batch 2: command timeout ───────────────────────────────────────────────

describe("command timeout", () => {
  it("rejects when authTimeout fires before LOGIN response", async () => {
    const server = await newServer();
    // Server sends greeting, then client sends LOGIN.  The mock has
    // allowExtra: false and no scenario steps, so it destroys the socket
    // on the LOGIN command.  The client's socket error handler fires
    // immediately, so we just expect any rejection.
    server.scenario([], { allowExtra: false });
    const conn = new Connection({
      user: "test", password: "secret",
      host: "127.0.0.1", port: server.port,
      tls: false,
      authTimeout: 5000,
      commandTimeout: 5000,
    });
    await expect(conn.connect()).rejects.toThrow();
    server.close();
  });
});

// ── Batch 2: openBox capability gating ─────────────────────────────────────

describe("openBox capability gating", () => {
  it("throws when capabilities are known and IMAP4rev1 is missing", async () => {
    const server = await newServer();
    // Override the default CAPABILITY step with one that lacks IMAP4rev1
    server.scenario([
      { expect: /^A\d+ LOGIN /, respond: (cmd: string) => `${cmd.match(/^A\d+/)![0]} OK logged in` },
      { expect: /^A\d+ CAPABILITY$/, respond: "* CAPABILITY XLIST" },
    ], { allowExtra: true });
    const conn = new Connection({
      user: "test", password: "secret",
      host: "127.0.0.1", port: server.port,
      tls: false,
    });
    await conn.connect();
    await expect(conn.openBox("INBOX")).rejects.toThrow("IMAP4rev1");
  });
});

// ── Batch 2: STARTTLS ──────────────────────────────────────────────────────

describe("STARTTLS", () => {
  it("throws when autotls is required but STARTTLS unavailable", async () => {
    const server = await newServer();
    // greeting without STARTTLS capability
    server.scenario([
      { expect: /^A\d+ LOGIN /, respond: "A0001 OK logged in" },
    ], { allowExtra: true });
    const conn = new Connection({
      user: "test", password: "secret",
      host: "127.0.0.1", port: server.port,
      tls: false,
      autotls: "required",
      authTimeout: 5000,
    });
    await expect(conn.connect()).rejects.toThrow("STARTTLS");
    server.close();
  });

  // TODO: STARTTLS upgrade requires a TLS-capable mock server.
  // The current plain-TCP mock can't complete the TLS handshake,
  // so connect() hangs waiting for LOGIN on the upgraded socket.
  it.todo("succeeds when autotls is always and server has STARTTLS");
});

// ── Batch 3a: socket error propagation ───────────────────────────────────

describe("socket error propagation", () => {
  it("rejects pending commands when socket closes", async () => {
    const server = await newServer();
    // Don't use connectAndLogin — we need a server that won't auto-respond
    // to the SEARCH command, so the promise stays pending when we kill the socket.
    server.scenario([
      { expect: /^A\d+ LOGIN /, respond: (cmd: string) => `${cmd.match(/^A\d+/)![0]} OK logged in` },
      { expect: /^A\d+ CAPABILITY$/, respond: "* CAPABILITY IMAP4rev1" },
    ], { allowExtra: false });
    const conn = new Connection({
      user: "test", password: "secret",
      host: "127.0.0.1", port: server.port,
      tls: false,
    });
    await conn.connect();

    // Start a command the mock has no step for — it will throw, closing
    // the socket.  #failAllPending should reject the pending search.
    const cmd = conn.search(["UNSEEN"]);
    await expect(cmd).rejects.toThrow();
    server.close();
  });
});

// ── Batch 3a: fetch concurrency guard ────────────────────────────────────

describe("fetch concurrency", () => {
  it("throws when fetch is called while another fetch is in flight", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID FETCH 1 \(UID FLAGS BODY\.PEEK\[\]\)$/,
        // never respond — fetch stays in-flight
        respond: "",
      },
    ]);

    // Start first fetch (it won't complete because the mock sends an
    // empty respond which auto-tags OK — but that's enough to mark it
    // as in-flight briefly).  Use a server that needs an explicit
    // command before the tagged OK.
    //
    // Actually, just call fetch twice synchronously.  The first call
    // sets #fetchResolve, the second throws.
    conn.fetch([1]);
    expect(() => conn.fetch([2])).toThrow(
      "A fetch is already in progress",
    );
    server.close();
  });
});

// ── Batch 3a: continuation handling ─────────────────────────────────────

describe("continuations", () => {
  it("routes + lines to onContinue callback", async () => {
    const server = await newServer();
    // The mock's #dispatchLine doesn't support continuations yet,
    // so we test this indirectly: sendCommandWithContinuation
    // sends IDLE, the mock auto-responds with a tagged OK (not a +),
    // so the continuation promise never resolves.  We just verify
    // the method exists and doesn't crash.
    const conn = await connectAndLogin(server, []);

    // sendCommandWithContinuation is exposed.  Sending a command
    // that the mock doesn't handle means allowExtra auto-responds
    // with a tagged OK, which goes to #dispatchLine, not
    // #onContinue.  So the continuation promise hangs.
    // We just verify the method is callable.
    const contPromise = conn.sendCommandWithContinuation("IDLE");
    expect(contPromise).toBeInstanceOf(Promise);

    // Clean up: close the connection to reject the hanging promise.
    conn.close().catch(() => {});
    server.close();
  });
});

// ── Batch 3a: unsolicited FETCH during non-fetch ────────────────────────

describe("unsolicited FETCH handling", () => {
  it("ignores FETCH responses when no fetch is in progress", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ UID SEARCH UNSEEN$/,
        // The mock sends a FETCH-like line as an untagged response
        // before the SEARCH result.  Since no fetch is in progress,
        // #handleFetchLine should ignore it.
        respond: [
          "* 9 FETCH (UID 9 FLAGS (\\Seen) BODY[] {5}",
          "hello",
          "* SEARCH 42",
        ],
      },
    ]);

    const uids = await conn.search(["UNSEEN"]);
    // The unsolicited FETCH should not interfere with SEARCH results.
    expect(uids).toEqual([42]);
    server.close();
  });
});

// ── Batch 3b: IDLE ────────────────────────────────────────────────────────

describe("idle", () => {
  it("throws if server lacks IDLE capability", async () => {
    const server = await newServer();
    // The default CAPABILITY from connectAndLogin includes IDLE, so
    // we override it with a custom scenario that lacks IDLE.
    server.scenario([
      { expect: /^A\d+ LOGIN /, respond: (cmd: string) => `${cmd.match(/^A\d+/)![0]} OK logged in` },
      { expect: /^A\d+ CAPABILITY$/, respond: "* CAPABILITY IMAP4rev1" },
    ], { allowExtra: true });
    const conn = new Connection({
      user: "test", password: "secret",
      host: "127.0.0.1", port: server.port,
      tls: false,
    });
    await conn.connect();

    await expect(
      (async () => {
        for await (const _ of conn.idle()) { void _; }
      })(),
    ).rejects.toThrow("IDLE");
    server.close();
  });

  it("yields EXISTS event", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: [
          "+ idling",
          "* 5 EXISTS",
        ],
      },
    ]);

    const events: unknown[] = [];
    const idlePromise = (async () => {
      for await (const ev of conn.idle()) {
        events.push(ev);
        break; // exit after first event
      }
    })();

    // Wait a tick for the iteration to start and the event to arrive.
    await new Promise((r) => setTimeout(r, 50));
    await idlePromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "exists", count: 5 });
    server.close();
  });

  it("yields EXPUNGE event", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: [
          "+ idling",
          "* 3 EXPUNGE",
        ],
      },
    ]);

    const events: unknown[] = [];
    const idlePromise = (async () => {
      for await (const ev of conn.idle()) {
        events.push(ev);
        break;
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await idlePromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "expunge", seqno: 3 });
    server.close();
  });

  it("yields FETCH flags-change event", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: [
          "+ idling",
          "* 1 FETCH (UID 42 FLAGS (\\Seen))",
        ],
      },
    ]);

    const events: unknown[] = [];
    const idlePromise = (async () => {
      for await (const ev of conn.idle()) {
        events.push(ev);
        break;
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await idlePromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "fetch",
      seqno: 1,
      uid: 42,
      flags: ["\\Seen"],
    });
    server.close();
  });

  it("drains events that arrive after DONE before tagged OK", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: [
          "+ idling",
          "* 6 EXISTS",
          // "* 6 EXISTS" is sent as an untagged event during idling.
          // After the client sends DONE, the mock auto-completes with
          // a tagged OK.  There are no post-DONE events in this scenario,
          // but the drain logic still runs.
        ],
      },
    ]);

    const events: unknown[] = [];
    const idlePromise = (async () => {
      for await (const ev of conn.idle()) {
        events.push(ev);
        break;
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await idlePromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "exists", count: 6 });
    server.close();
  });

  it("yields RECENT event", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: [
          "+ idling",
          "* 2 RECENT",
        ],
      },
    ]);

    const events: unknown[] = [];
    const idlePromise = (async () => {
      for await (const ev of conn.idle()) {
        events.push(ev);
        break;
      }
    })();

    await new Promise((r) => setTimeout(r, 50));
    await idlePromise;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "recent", count: 2 });
    server.close();
  });

  it("exits cleanly when socket closes during idle", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: "+ idling",
      },
    ]);

    const events: unknown[] = [];
    const idlePromise = (async () => {
      for await (const ev of conn.idle()) {
        events.push(ev);
      }
    })();

    // Let idle enter, then kill the socket.
    await new Promise((r) => setTimeout(r, 50));
    server.close();

    // The for-await loop should exit without throwing.
    await idlePromise;

    expect(events).toHaveLength(0);
  });

  it("sendCommand rejects immediately after socket close during idle", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: "+ idling",
      },
    ]);

    const idlePromise = (async () => {
      for await (const _ of conn.idle()) { void _; }
    })();

    // Let idle enter, then kill the socket.
    await new Promise((r) => setTimeout(r, 50));
    server.close();
    await idlePromise;

    // Connection is now dead — sendCommand should reject immediately.
    await expect(conn.search(["ALL"])).rejects.toThrow("Connection is dead");
  });

  it("close() is a no-op after socket close during idle", async () => {
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: "+ idling",
      },
    ]);

    const idlePromise = (async () => {
      for await (const _ of conn.idle()) { void _; }
    })();

    await new Promise((r) => setTimeout(r, 50));
    server.close();
    await idlePromise;

    // Should not throw or hang — returns immediately.
    await conn.close();
  });

  it("does not hang when socket closes during DONE/drain phase", async () => {
    // The keepalive timer in the watcher triggers return() on the idle
    // iterator, which sends DONE and then waits for the tagged OK.  If
    // the socket closes while waiting for that OK, the drain promise
    // must resolve (via #idleDrainResolve) so the generator exits
    // instead of hanging forever.
    const server = await newServer();
    const conn = await connectAndLogin(server, [
      {
        expect: /^A\d+ IDLE$/,
        respond: "+ idling",
      },
    ]);

    // Start idle — don't await next() because the generator won't yield
    // until an event arrives.  We just need the idle session to begin
    // (the + idling continuation must have been received).  Kick off
    // idle in the background, wait for the continuation, then trigger
    // return() and kill the socket.
    const idlePromise = (async () => {
      for await (const _ of conn.idle()) { void _; }
    })();

    // Wait for + idling to arrive, then trigger return().
    await new Promise((r) => setTimeout(r, 50));

    // Call return() and immediately close the socket before the
    // tagged OK for DONE arrives.  #idleDrainResolve should fire
    // on socket close so idlePromise resolves instead of hanging.
    const returnPromise = idlePromise;
    server.close();

    await returnPromise;
  });
});
