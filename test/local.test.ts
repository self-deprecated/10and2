import { test } from "node:test";
import assert from "node:assert/strict";
import { Local } from "../src/local.ts";
import { parsePolicy } from "../src/policy.ts";
import { FakeAdapter, item } from "./fakes.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";

const policy = parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:8790/connector", projects: "*", actions: ["settle", "start_work", "follow_up"] }));
const profile: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "worktree", interactionMode: "default" };

test("local adapters route every operation by prefix, preserving T3 ids and receipts", async () => {
  const t3 = new FakeAdapter([item("a")]);
  const other = new FakeAdapter([item("a"), item("kid", { parentId: "a" })]);
  const adapter = new Local([{ prefix: "", adapter: t3, retrySafe: true }, { prefix: "claude", adapter: other }], policy);
  assert.deepEqual((await adapter.list()).map((i) => [i.id, i.parentId]), [["a", null], ["claude:a", null], ["claude:kid", "claude:a"]]);
  assert.deepEqual(adapter.places().map((p) => p.id), ["p-proj", "claude:p-proj"]);
  assert.equal((await adapter.report("claude:a")).text, "Report for a.");
  assert.deepEqual(await adapter.replies("claude:a"), []);
  assert.equal(t3.reportCalls, 0);
  await adapter.execute({ kind: "settle", itemId: "claude:a" }, "k");
  await adapter.markRead("claude:a", "now", "v");
  assert.equal(other.executed[0].action.kind, "settle");
  assert.equal(other.visits[0].itemId, "a");
  assert.equal(adapter.retrySafe({ kind: "settle", itemId: "a" }), true);
  assert.equal(adapter.retrySafe({ kind: "settle", itemId: "claude:a" }), false);
  const changes: string[][] = [];
  const stop = adapter.watch((ids) => changes.push(ids));
  other.emit(["kid"]);
  assert.deepEqual(changes, [["claude:kid"]]);
  stop();
  const r = await adapter.execute({ kind: "start_work", placeId: "claude:p-proj", title: "New", message: "Go", profile: { ...profile, runtimeMode: "approval-required" } }, "start");
  assert.deepEqual(r, { ok: true, itemId: "claude:new-1" });
});

test("policy intersects capabilities and refuses disallowed verbs and profiles through check and execute", async () => {
  const fake = new FakeAdapter([item("a")]);
  const local = new Local([{ prefix: "", adapter: fake }], policy);
  assert.deepEqual(local.actions, ["follow_up", "settle", "start_work"]);
  const actions: Action[] = [{ kind: "archive", itemId: "a" }, { kind: "start_work", placeId: "p-proj", title: "New", message: "Go", profile }];
  for (const a of actions) {
    assert.match((await local.check(a))!, /isn't allowed|more access/);
    const r = await local.execute(a, "blocked");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /isn't allowed|more access/);
  }
  assert.equal(fake.executed.length, 0);
});

test("an execute that expires while checking never reaches the adapter", async () => {
  const fake = new FakeAdapter([item("a")]);
  let release!: () => void;
  Object.assign(fake, { check: () => new Promise<null>((r) => { release = () => r(null); }) });
  const local = new Local([{ prefix: "", adapter: fake }], policy);
  const pending = local.refusal({ kind: "settle", itemId: "a" }, Date.now() + 10);
  await new Promise((r) => setTimeout(r, 20));
  release();
  assert.match((await pending) ?? "", /expired/);
  assert.equal(fake.executed.length, 0);
});

test("an unloaded backend cannot block a snapshot; loading it emits all its ids", async () => {
  const late = Object.assign(new FakeAdapter([item("late")]), { isLoaded: false });
  const originalList = late.list.bind(late);
  late.list = async () => { throw new Error("must not list an unloaded backend"); };
  const ready = new FakeAdapter([item("ready")]);
  const local = new Local([{ prefix: "", adapter: late }, { prefix: "claude", adapter: ready }], policy);
  const changes: string[][] = [];
  local.watch((ids) => changes.push(ids));
  assert.deepEqual((await local.list()).map((i) => i.id), ["claude:ready"]);
  assert.deepEqual(local.places().map((p) => p.id), ["claude:p-proj"]);
  late.list = originalList; late.isLoaded = true;
  assert.deepEqual((await local.list()).map((i) => i.id), ["late", "claude:ready"]);
  assert.deepEqual(changes, [["late"]]);
  await local.list(); assert.equal(changes.length, 1);
});
