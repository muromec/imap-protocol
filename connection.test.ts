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
        respond: "A0002 NO permission denied",
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
      { expect: /^A\d+ LOGOUT$/, respond: "A0002 NO rejected" },
    ]);

    // close() catches LOGOUT errors and still calls reader.close()
    await conn.close();
  });
});
