import { Connection } from "./index.ts";
import { EMAIL_CONFIG } from "../../config.ts";

const conn = new Connection({
  user: EMAIL_CONFIG.user,
  password: EMAIL_CONFIG.password,
  host: EMAIL_CONFIG.imapHost,
  port: EMAIL_CONFIG.imapPort,
  tls: EMAIL_CONFIG.tls,
});

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function test_connect() {
  console.log("connect() ...");
  await conn.connect();
  assert(true, "connects and authenticates");
}

async function test_openBox() {
  console.log("openBox('INBOX') ...");
  const box = await conn.openBox("INBOX");
  assert(typeof box.name === "string", "returns name");
  assert(typeof box.total === "number", "returns total count");
  assert(typeof box.uidvalidity === "number", "returns uidvalidity");
  assert(typeof box.uidnext === "number", "returns uidnext");
  assert(Array.isArray(box.flags), "returns flags array");
  console.log(`    box: name="${box.name}" total=${box.total} uidnext=${box.uidnext}`);
}

async function test_search() {
  console.log("search(['ALL']) ...");
  const uids = await conn.search(["ALL"]);
  assert(Array.isArray(uids), "returns an array");
  assert(uids.length > 0, "finds at least one message");
  console.log(`    found ${uids.length} messages, UIDs: [${uids.join(", ")}]`);
}

async function test_fetch() {
  console.log("fetch(first 2 UIDs) ...");
  const allUids = await conn.search(["ALL"]);
  const toFetch = allUids.slice(0, 2);
  console.log(`    fetching UIDs: [${toFetch.join(", ")}]`);
  const messages = await conn.fetch(toFetch);
  console.log(`    got ${messages.length} messages back`);
  assert(messages.length === toFetch.length, `returns correct number of messages (expected ${toFetch.length}, got ${messages.length})`);
  for (const msg of messages) {
    assert(typeof msg.seqno === "number", "message has seqno");
    assert(typeof msg.body === "string", "message has body");
    assert(msg.body.length > 0, "body is non-empty");
    assert(Array.isArray(msg.flags), "message has flags array");
    console.log(`    seqno=${msg.seqno} flags=[${msg.flags.join(",")}] body_len=${msg.body.length}`);
  }
}

async function test_fetchUnseen() {
  console.log("fetchUnseen() ...");
  const messages = await conn.fetchUnseen();
  assert(Array.isArray(messages), "returns an array");
  // unseen may be 0 or more, either is fine
  console.log(`    found ${messages.length} unseen messages`);
}

async function test_addFlags() {
  console.log("addFlags() ...");
  const allUids = await conn.search(["ALL"]);
  if (allUids.length > 0) {
    const [uid] = allUids;
    await conn.addFlags([uid], "\\Seen");
    assert(true, "addFlags completes without error");
  } else {
    assert(true, "skipped — no messages");
  }
}

async function test_close() {
  console.log("close() ...");
  await conn.close();
  assert(true, "closes cleanly");
}

async function main() {
  console.log("imap-connector validation\n");

  try {
    await test_connect();
    await test_openBox();
    await test_search();
    await test_fetch();
    await test_fetchUnseen();
    await test_addFlags();
    await test_close();
  } catch (err) {
    console.error("\n  UNCAUGHT ERROR:", err);
    failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
