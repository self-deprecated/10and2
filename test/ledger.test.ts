import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { Ledger, NOT_CLAIMED, actionHash, ledgerHeld } from "../src/ledger.ts";
import { databasePath } from "../src/paths.ts";
import { assertPrivate, NODE, removeDir } from "./fixtures/platform.ts";
import type { Action, Receipt } from "../src/contract.ts";

const action: Action = { kind: "settle", itemId: "a" };

test("the ledger dedupes concurrent and durable receipts, and refuses a changed action", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => removeDir(dir));
  let ledger = new Ledger(dir);
  let calls = 0;
  const opts = { retrySafe: false, execute: async (): Promise<Receipt> => { calls++; return { ok: true }; } };
  assert.deepEqual(await Promise.all([ledger.execute(action, "k", opts), ledger.execute(action, "k", opts)]), [{ ok: true }, { ok: true }]);
  const conflict = await ledger.execute({ kind: "archive", itemId: "a" }, "k", opts);
  assert.equal(conflict.ok, false);
  assert.match(!conflict.ok ? conflict.error : "", /different action/);
  await ledger.close();
  ledger = new Ledger(dir);
  assert.deepEqual(await ledger.execute(action, "k", opts), { ok: true });
  await ledger.close();
  assert.equal(calls, 1);
  assertPrivate(join(dir, "connector.db"));
  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
  assert.deepEqual(audit.map((a) => a.state), ["dispatching", "accepted"]);
  assert.deepEqual(audit[0].action, action);
});

for (const retrySafe of [true, false]) test(`crash recovery only resends a retry-safe adapter (${retrySafe})`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => removeDir(dir));
  const created = new Ledger(dir);
  await created.close();
  // This is exactly the durable boundary a process killed before its receipt leaves behind.
  const db = new DatabaseSync(join(dir, "connector.db"));
  db.prepare("INSERT INTO actions (key, action_hash, state, action) VALUES (?, ?, 'dispatching', ?)").run("crash", actionHash(action), JSON.stringify(action));
  db.close();
  const recovered = new Ledger(dir);
  let calls = 0;
  const opts = { retrySafe, execute: async (): Promise<Receipt> => { calls++; return { ok: true }; } };
  const receipt = await recovered.execute(action, "crash", opts);
  assert.equal(receipt.ok, retrySafe);
  if (!receipt.ok) assert.equal(receipt.unknown, true);
  assert.deepEqual(await recovered.execute(action, "crash", opts), receipt);
  assert.equal(calls, retrySafe ? 1 : 0);
  await recovered.close();
});

for (const retrySafe of [true, false]) test(`unknown receipts retry only with backend deduplication (${retrySafe})`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => removeDir(dir));
  const ledger = new Ledger(dir);
  let calls = 0;
  const opts = { retrySafe, execute: async (): Promise<Receipt> => ++calls === 1 ? { ok: false, unknown: true, error: "lost" } : { ok: true } };
  assert.equal((await ledger.execute(action, "unknown", opts)).ok, false);
  assert.equal((await ledger.execute(action, "unknown", opts)).ok, retrySafe);
  assert.equal(calls, retrySafe ? 2 : 1);
  await ledger.close();
});

test("action hashes ignore property order, including the launch profile", () => {
  assert.equal(actionHash(action), actionHash({ itemId: "a", kind: "settle" }));
  assert.notEqual(actionHash(action), actionHash({ kind: "archive", itemId: "a" }));
});

test("only one connector owns a ledger, and closing releases its crash-safe SQLite lock", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-owner-"));
  t.after(() => removeDir(dir));
  const first = new Ledger(dir);
  assert.throws(() => new Ledger(dir), /locked/);
  await first.close();
  const next = new Ledger(dir);
  await next.close();
});

test("a refusal before dispatch isn't kept, so the same key can still go ahead later", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => removeDir(dir));
  const ledger = new Ledger(dir);
  let calls = 0, refusing = true;
  const opts = {
    retrySafe: false,
    refuse: async (): Promise<Receipt | null> => refusing ? { ok: false, error: "That operation expired. Nothing was sent." } : null,
    execute: async (): Promise<Receipt> => { calls++; return { ok: true }; },
  };
  assert.deepEqual(await ledger.execute(action, "later", opts), { ok: false, error: "That operation expired. Nothing was sent." });
  assert.equal(calls, 0);
  refusing = false;
  assert.deepEqual(await ledger.execute(action, "later", opts), { ok: true });
  // Once it has happened, the stored receipt wins over any refusal now.
  refusing = true;
  assert.deepEqual(await ledger.execute(action, "later", opts), { ok: true });
  assert.equal(calls, 1);
  await ledger.close();
  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
  assert.deepEqual(audit.map((a) => a.state), ["refused", "dispatching", "accepted"]);
});

test("a refusal on a retry-safe key whose outcome was lost stays unknown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => removeDir(dir));
  const ledger = new Ledger(dir);
  let refusing = false;
  const opts = {
    retrySafe: true,
    refuse: async (): Promise<Receipt | null> => refusing ? { ok: false, error: "Not allowed now." } : null,
    execute: async (): Promise<Receipt> => ({ ok: false, unknown: true, error: "lost" }),
  };
  assert.equal((await ledger.execute(action, "lost", opts)).ok, false);
  refusing = true;
  assert.deepEqual(await ledger.execute(action, "lost", opts), { ok: false, error: "Not allowed now.", unknown: true });
  await ledger.close();
});

test("a held ledger says a connector is running, and a look at it (as status takes) never stops one starting", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-held-"));
  t.after(() => removeDir(dir));
  assert.equal(ledgerHeld(dir), undefined, "no ledger yet: can't be told");
  const ledger = new Ledger(dir);
  assert.equal(ledgerHeld(dir), true);
  await ledger.close();
  assert.equal(ledgerHeld(dir), false);
  // Another process reading the ledger while a connector opens it: the connector waits for it.
  const reader = spawn(NODE, ["--disable-warning=ExperimentalWarning", "-e", `
    const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(join(dir, "connector.db"))}, { readOnly: true });
    db.exec("BEGIN"); db.prepare("SELECT 1 FROM sqlite_master").get(); console.log("reading");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((r) => reader.once("exit", r));
  await new Promise((r) => reader.stdout.once("data", r));
  const next = new Ledger(dir);
  await next.close();
  await exited;
});

test("on Windows a database path too long for SQLite there is given as \\\\?\\, which has no such limit", () => {
  // A new database's journal (8 characters more) must stay under Windows' 260: connector.db opens at 251, not at 252.
  const at = (n: number) => `C:\\Users\\me\\${"x".repeat(n - 32)}\\10and2\\connector.db`;
  assert.equal(at(251).length, 251);
  assert.equal(databasePath(at(251), "win32"), at(251));
  assert.equal(databasePath(at(252), "win32"), `\\\\?\\${at(252)}`);
  assert.equal(databasePath(at(300), "win32"), `\\\\?\\${at(300)}`);
  assert.equal(databasePath(":memory:", "win32"), ":memory:");
  const posix = `/home/me/${"x".repeat(300)}/connector.db`;
  assert.equal(databasePath(posix, "linux"), posix);
});

// The skeptic on 7717d10f3219: the `sent` table's two new columns were added in one go, guarded by the second alone, so a
// crash between them left `found_item` there, and every later start failed ("duplicate column name: found_item").
test("a store from before a send kept its message gains each new column by itself, whichever a crash left", async (t) => {
  for (const had of [[], ["found_item"], ["found_item", "found_at"]]) {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    t.after(() => removeDir(dir));
    const db = new DatabaseSync(join(dir, "connector.db"));
    db.exec(`CREATE TABLE sent (key TEXT PRIMARY KEY, item TEXT, digest TEXT NOT NULL, at INTEGER NOT NULL${had.map((c) => `, ${c} TEXT`).join("")});
      INSERT INTO sent (key, item, digest, at) VALUES ('op-1', 'a', 'd', ${Date.now()});`);
    db.close();
    const ledger = new Ledger(dir);
    ledger.claim("op-1", { item: "a", at: "2026-11-20T09:00:00.000Z" });
    assert.deepEqual(ledger.sends(), [{ key: "op-1", item: "a", digest: "d", at: ledger.sends()[0]!.at, found: { item: "a", at: "2026-11-20T09:00:00.000Z" } }], had.join(", "));
    await ledger.close();
  }
});

test("the schedules table is on the ledger's own handle, under its exclusive lock: no second connection can read it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => removeDir(dir));
  const ledger = new Ledger(dir);
  ledger.handle.prepare("INSERT INTO schedules (id, v, device, hash, body, state, set_at) VALUES ('s', 1, 'd', 'h', '{}', 'waiting', 1)").run();
  const other = new DatabaseSync(join(dir, "connector.db"));
  assert.throws(() => other.prepare("SELECT * FROM schedules").all(), /locked/);
  other.close();
  await ledger.close();
  const after = new DatabaseSync(join(dir, "connector.db"));
  assert.equal((after.prepare("SELECT state FROM schedules WHERE id = 's'").get() as { state: string }).state, "waiting", "kept on disk for the next start");
  after.close();
});

test("a claim that says no, once the checks passed, sends nothing and records nothing against the key", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const ledger = new Ledger(dir);
  // Its store closed first: Windows won't remove a folder with a file open in it.
  t.after(async () => { await ledger.close(); removeDir(dir); });
  let calls = 0, claims = 0;
  const execute = async (): Promise<Receipt> => { calls++; return { ok: true }; };
  const no = await ledger.execute(action, "R-1:a", { retrySafe: false, refuse: async () => null, claim: () => { claims++; return false; }, execute });
  assert.deepEqual(no, NOT_CLAIMED);
  assert.equal(calls, 0);
  assert.equal(ledger.handle.prepare("SELECT COUNT(*) AS n FROM actions").get()!.n, 0);
  // Refused first: the claim isn't asked.
  await ledger.execute(action, "R-1:a", { retrySafe: false, refuse: async () => ({ ok: false, error: "busy" }), claim: () => { claims++; return true; }, execute });
  assert.equal(claims, 1);
  // Yes: claimed in the dispatch's own transaction, then sent once.
  let inTransaction = false;
  assert.deepEqual(await ledger.execute(action, "R-1:a", { retrySafe: false, claim: () => { inTransaction = ledger.handle.isTransaction; return true; }, execute }), { ok: true });
  assert.equal(inTransaction, true);
  assert.equal(calls, 1);
});
