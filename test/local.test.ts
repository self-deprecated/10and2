import { test } from "node:test";
import assert from "node:assert/strict";
import { Local } from "../src/local.ts";
import { parsePolicy } from "../src/policy.ts";
import { FakeAdapter, item } from "./fakes.ts";
import type { Action, CodingModel, LaunchProfile } from "../src/contract.ts";

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

test("a first ask is routed by prefix; a work system that can't say has none", async () => {
  const t3 = Object.assign(new FakeAdapter([item("a")]), { firstAsk: undefined });
  const other = new FakeAdapter([item("a")]);
  other.asks.set("a", { text: "Fix the login.", at: "2026-11-16T15:00:00.000Z", complete: true });
  const local = new Local([{ prefix: "", adapter: t3 }, { prefix: "pi", adapter: other }], policy);
  assert.deepEqual(await local.firstAsk("pi:a"), { text: "Fix the login.", at: "2026-11-16T15:00:00.000Z", complete: true });
  assert.equal(await local.firstAsk("a"), null);
  await assert.rejects(local.firstAsk("pi:gone"), /isn't visible/);
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

test("a start on a model its place doesn't list now is refused before it reaches the work system, in that app's words", async () => {
  const models: CodingModel[] = [{ id: "opus", name: "Claude Opus 5.5" }];
  const app = (name: string, placeModels?: typeof models) => {
    const a = Object.assign(new FakeAdapter([item("a")]), { name });
    a.placeList = [{ id: "p-proj", name: "proj", activeAt: null, ...(placeModels ? { models: placeModels } : {}) }];
    return a;
  };
  const t3 = app("t3", [{ id: "claudeAgent:claude-opus-5-5", name: "Claude Opus 5.5" }]), claude = app("claude", models), codex = app("codex", []), pi = app("pi", []), other = app("fake");
  const local = new Local([{ prefix: "", adapter: t3 }, { prefix: "claude", adapter: claude }, { prefix: "codex", adapter: codex }, { prefix: "pi", adapter: pi }, { prefix: "other", adapter: other }], policy);
  assert.deepEqual(local.places().find((p) => p.id === "claude:p-proj")!.models, models, "places keep their models");
  const start = (placeId: string, model?: string): Action => ({ kind: "start_work", placeId, message: "Go", profile: { ...profile, runtimeMode: "approval-required" }, ...(model ? { model } : {}) });
  assert.equal(await local.check(start("claude:p-proj", "opus")), null);
  assert.equal(await local.check(start("p-proj", "claudeAgent:claude-opus-5-5")), null);
  assert.equal(await local.check(start("p-proj", "opus")), "T3 Code doesn't offer that model for this project now.");
  assert.equal(await local.check(start("claude:p-proj", "sonnet")), "Claude Code doesn't offer that model now.");
  assert.equal(await local.check(start("codex:p-proj", "opus")), "Codex doesn't offer that model now.");
  assert.equal(await local.check(start("pi:p-proj", "opus")), "Pi can't start on a chosen model through 10 & 2 yet.");
  assert.equal(await local.check(start("other:p-proj", "opus")), "That coding app doesn't offer that model now.", "a place with no models said");
  assert.equal(await local.check(start("other:p-proj")), null, "no model, as before");
  assert.deepEqual(await local.execute(start("claude:p-proj", "sonnet"), "k"), { ok: false, error: "Claude Code doesn't offer that model now." });
  assert.equal(claude.executed.length, 0);
  assert.deepEqual(await local.execute(start("claude:p-proj", "opus"), "k2"), { ok: true, itemId: "claude:new-1" });
  assert.equal((claude.executed[0]!.action as Extract<Action, { kind: "start_work" }>).model, "opus", "passed on as given");
  // One model on two of T3's providers is listed on each, and either is taken; what neither lists isn't.
  const both = app("t3", [{ id: "claudeAgent:claude-opus-5-5", name: "Claude Opus 5.5", provider: "Claude" }, { id: "claude-proxy:claude-opus-5-5", name: "Claude Opus 5.5", provider: "Claude Proxy" }]);
  const providers = new Local([{ prefix: "", adapter: both }], policy);
  assert.equal(await providers.check(start("p-proj", "claude-proxy:claude-opus-5-5")), null);
  assert.equal(await providers.check(start("p-proj", "claudeAgent:claude-opus-5-5")), null);
  assert.equal(await providers.check(start("p-proj", "claude-proxy:claude-sonnet-5-5")), "T3 Code doesn't offer that model for this project now.");
});
