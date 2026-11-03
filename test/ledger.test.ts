import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger, actionHash } from "../src/ledger.ts";
import type { Action, Receipt } from "../src/contract.ts";

const action: Action = { kind: "settle", itemId: "a" };

test("the ledger dedupes concurrent and durable receipts, and refuses a changed action", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  assert.equal(statSync(join(dir, "connector.db")).mode & 0o777, 0o600);
  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
  assert.deepEqual(audit.map((a) => a.state), ["dispatching", "accepted"]);
  assert.deepEqual(audit[0].action, action);
});

for (const retrySafe of [true, false]) test(`crash recovery only resends a retry-safe adapter (${retrySafe})`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Ledger(dir);
  assert.throws(() => new Ledger(dir), /locked/);
  await first.close();
  const next = new Ledger(dir);
  await next.close();
});

test("a refusal before dispatch isn't kept, so the same key can still go ahead later", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
