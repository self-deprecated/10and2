import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { ClaudeAdapter, permissionMode, resumeMode, sessionForKey } from "../src/claude/adapter.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { harness, until } from "./fixtures/claude/helpers.ts";

const profile: LaunchProfile = { name: "Normal", runtimeMode: "approval-required", workspace: "root", interactionMode: "default" };
function env(t: Parameters<typeof harness>[0], key: string, value: string) {
  const old = process.env[key]; process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
function calls(config: string): any[] {
  return readFileSync(join(config, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("follow-up preflight and execution both refuse a live idle holder", async (t) => {
  const h = harness(t), f = h.completed(); h.registry(f.id, "idle"); await h.adapter.start();
  const action: Action = { kind: "follow_up", itemId: f.id, message: "Exact words" };
  assert.match((await h.adapter.check(action))!, /open in a terminal/);
  const receipt = await h.adapter.execute(action, "held"); assert.equal(receipt.ok, false); assert.equal(existsSync(join(h.config, "calls.jsonl")), false);
});

test("a holder appearing between preflight and dispatch is refused", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  const original = h.adapter.check.bind(h.adapter);
  h.adapter.check = async (action) => { const why = await original(action); h.registry(f.id, "idle"); return why; };
  const receipt = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Race" }, "race");
  assert.equal(receipt.ok, false); assert.equal(existsSync(join(h.config, "calls.jsonl")), false);
});

test("a partially written registry belonging to a live pid refuses follow-up conservatively", async (t) => {
  const h = harness(t), f = h.completed(); writeFileSync(join(h.config, "sessions", `${process.pid}.json`), '{"sessionId":'); await h.adapter.start();
  assert.match((await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "x" }))!, /can't verify/);
  assert.equal((await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "x" }, "partial")).ok, false);
  assert.equal(existsSync(join(h.config, "calls.jsonl")), false);
});

test("cold follow-up accepts exact replay, caps the session's own mode at the ceiling, logs privately, never repeats", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  const action: Action = { kind: "follow_up", itemId: f.id, message: "A literal $(not shell); `still literal`\nnext line" };
  assert.deepEqual(await h.adapter.execute(action, "follow"), { ok: true });
  assert.deepEqual(await h.adapter.execute(action, "follow"), { ok: true });
  assert.equal(calls(h.config).length, 1);
  const args: string[] = calls(h.config)[0].args;
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto"); assert.ok(args.includes("--resume")); assert.ok(args.includes("--replay-user-messages")); assert.ok(!args.includes("--bare"));
  assert.ok(!args.includes(action.message));
  await until(async () => (await h.adapter.list())[0]?.status === "completed");
  assert.equal((await h.adapter.replies(f.id))[0]?.prompt, action.message);
  const { readdirSync } = await import("node:fs");
  for (const name of readdirSync(h.options.stateDir).filter((n) => n.endsWith(".log") || n.endsWith(".jsonl"))) assert.equal(statSync(join(h.options.stateDir, name)).mode & 0o777, 0o600);
});

test("a new transcript user record is positive evidence without stdout replay", async (t) => {
  env(t, "FAKE_CLAUDE_NO_REPLAY", "1"); const h = harness(t), f = h.completed(); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Transcript evidence" }, "record"), { ok: true });
});

test("matching init and exact user replay are sufficient even before transcript persistence", async (t) => {
  env(t, "FAKE_CLAUDE_NO_USER_RECORD", "1"); const h = harness(t), f = h.completed(); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Replay only" }, "replay"), { ok: true });
});

for (const [label, knob] of [["init without replay", "FAKE_CLAUDE_NO_REPLAY"], ["wrong replay uuid", "FAKE_CLAUDE_WRONG_UUID"], ["replay without matching init", "FAKE_CLAUDE_SKIP_INIT"]]) {
  test(`insufficient acceptance evidence: ${label}`, async (t) => {
    env(t, "FAKE_CLAUDE_NO_USER_RECORD", "1"); env(t, knob!, "1");
    const h = harness(t, { acceptanceTimeoutMs: 200 }), f = h.completed(); await h.adapter.start();
    const receipt = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Evidence" }, "insufficient");
    assert.equal(receipt.ok, false); if (!receipt.ok) assert.equal(receipt.unknown, true);
  });
}

test("no echo and no new user record returns durable unknown, even after restart", async (t) => {
  env(t, "FAKE_CLAUDE_NEVER_ECHO", "1"); const h = harness(t, { acceptanceTimeoutMs: 160 }), f = h.completed(); await h.adapter.start();
  const action: Action = { kind: "follow_up", itemId: f.id, message: "Synthetic request." };
  const first = await h.adapter.execute(action, "unknown"); assert.equal(first.ok, false); if (!first.ok) assert.equal(first.unknown, true);
  await h.adapter.close(); const next = h.reopen(); await next.start(); assert.deepEqual(await next.execute(action, "unknown"), first);
  assert.equal(calls(h.config).length, 1);
});

test("a reused key with changed words is rejected before any spawn", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "One" }, "same");
  const receipt = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Two" }, "same");
  assert.equal(receipt.ok, false); if (!receipt.ok) assert.match(receipt.error, /already used/);
  assert.equal(calls(h.config).length, 1);
});

test("a run 10 & 2 started blocks a different follow-up while held, including across adapter restart", async (t) => {
  env(t, "FAKE_CLAUDE_HOLD_MS", "1500"); const h = harness(t), f = h.completed(); await h.adapter.start();
  assert.equal((await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "One" }, "one")).ok, true);
  unlinkSync(join(h.config, "sessions", `${calls(h.config)[0].pid}.json`));
  await h.adapter.close(); const next = h.reopen(); await next.start();
  assert.match((await next.check({ kind: "follow_up", itemId: f.id, message: "Two" }))!, /already running/);
  assert.equal((await next.execute({ kind: "follow_up", itemId: f.id, message: "Two" }, "two")).ok, false);
  assert.equal(calls(h.config).length, 1);
});

test("concurrent dispatches for one session start only one process", async (t) => {
  env(t, "FAKE_CLAUDE_HOLD_MS", "500"); const h = harness(t), f = h.completed(); await h.adapter.start();
  const action: Action = { kind: "follow_up", itemId: f.id, message: "One" };
  const receipts = await Promise.all([h.adapter.execute(action, "a"), h.adapter.execute(action, "b"), h.adapter.execute(action, "a")]);
  assert.equal(receipts.filter((r) => r.ok).length, 1); assert.equal(calls(h.config).length, 1);
});

test("creation derives a stable UUID from the key and returns the new item's id", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  const action: Action = { kind: "start_work", placeId: h.adapter.places()[0]!.id, title: "New task", message: "Exact new work", profile };
  const receipt = await h.adapter.execute(action, "start-key");
  assert.deepEqual(receipt, { ok: true, itemId: sessionForKey("start-key") });
  assert.equal(calls(h.config)[0].id, sessionForKey("start-key")); assert.equal(calls(h.config)[0].cwd, h.cwd);
  const args: string[] = calls(h.config)[0].args; assert.equal(args[args.indexOf("--permission-mode") + 1], "default");
  assert.equal((await h.adapter.list()).find((w) => w.id === sessionForKey("start-key"))?.title, "New task");
  assert.notEqual(sessionForKey("start-key"), sessionForKey("different"));
  assert.deepEqual(await h.adapter.execute(action, "start-key"), receipt); assert.equal(calls(h.config).length, 1);
});

test("plan launches pass plan explicitly and modes match the measured CLI", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  assert.deepEqual(["approval-required", "auto-accept-edits", "auto", "full-access"].map((m) => permissionMode(m as LaunchProfile["runtimeMode"])), ["default", "acceptEdits", "auto", "bypassPermissions"]);
  const receipt = await h.adapter.execute({ kind: "start_work", placeId: h.adapter.places()[0]!.id, title: "Plan", message: "Plan", profile: { ...profile, interactionMode: "plan" } }, "plan");
  assert.equal(receipt.ok, true); const args: string[] = calls(h.config)[0].args; assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
});

test("ceiling, unverified worktrees, hidden places and disabled verbs refuse before spawning", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  const action: Extract<Action, { kind: "start_work" }> = { kind: "start_work", placeId: h.adapter.places()[0]!.id, title: "Task", message: "x", profile };
  assert.match((await h.adapter.check({ ...action, profile: { ...profile, runtimeMode: "full-access" } }))!, /ceiling/);
  assert.match((await h.adapter.check({ ...action, profile: { ...profile, workspace: "worktree" } }))!, /worktree/);
  assert.match((await h.adapter.check({ ...action, placeId: "/a/path/from/the/brain" }))!, /visible/);
  h.policy.actions = []; assert.match((await h.adapter.check(action))!, /policy/);
  assert.equal(existsSync(join(h.config, "calls.jsonl")), false);
});

test("measured headless worktree version uses native isolation and observes its transcript", async (t) => {
  env(t, "FAKE_CLAUDE_WORKTREE", "1"); env(t, "FAKE_CLAUDE_NO_REPLAY", "1");
  const h = harness(t); h.completed(); await h.adapter.start();
  const receipt = await h.adapter.execute({ kind: "start_work", placeId: h.adapter.places()[0]!.id, title: "Worktree task", message: "In a worktree", profile: { ...profile, workspace: "worktree" } }, "wt");
  assert.deepEqual(receipt, { ok: true, itemId: sessionForKey("wt") });
  const call = calls(h.config)[0]; assert.ok(call.args.includes("--worktree")); assert.ok(call.cwd.startsWith(join(h.cwd, ".claude", "worktrees")));
  assert.ok((await h.adapter.list()).some((w) => w.id === sessionForKey("wt")));
});

test("a crash-left dispatch row never starts a process, and an unknown run reservation remains a blocker", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  const db = new DatabaseSync(h.options.db);
  const action: Action = { kind: "follow_up", itemId: f.id, message: "No retry" };
  db.prepare("INSERT INTO claude_operations(key,hash) VALUES(?,?)").run("crashed", createHash("sha256").update(JSON.stringify(action)).digest("hex"));
  db.prepare("INSERT INTO claude_runs(sessionId) VALUES(?)").run(f.id); db.close();
  assert.match((await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "No retry" }))!, /can't yet verify/);
  const receipt = await h.adapter.execute(action, "crashed"); assert.equal(receipt.ok, false); if (!receipt.ok) assert.equal(receipt.unknown, true);
  assert.equal(existsSync(join(h.config, "calls.jsonl")), false);
});

test("close during acceptance finishes bookkeeping and leaves the detached child running", async (t) => {
  env(t, "FAKE_CLAUDE_HOLD_MS", "1000"); env(t, "FAKE_CLAUDE_BEFORE_ACCEPT_MS", "80");
  const h = harness(t), f = h.completed(); await h.adapter.start();
  const pending = h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Detached" }, "detached");
  await until(() => existsSync(join(h.config, "calls.jsonl")));
  const closing = h.adapter.close(); assert.equal((await pending).ok, true); await closing;
  assert.doesNotThrow(() => process.kill(calls(h.config)[0].pid, 0));
  assert.equal(h.adapter.connected(), false);
});

test("a missing Claude executable is a known local failure", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.close();
  const adapter = new ClaudeAdapter({ ...h.options, claudeBin: join(h.root, "missing-claude") }); t.after(() => adapter.close()); await adapter.start();
  const receipt = await adapter.execute({ kind: "follow_up", itemId: f.id, message: "x" }, "no-bin"); assert.equal(receipt.ok, false);
  if (!receipt.ok) { assert.equal(receipt.unknown, undefined); assert.match(receipt.error, /installed/); }
  const db = new DatabaseSync(h.options.db);
  assert.equal(db.prepare("SELECT 1 FROM claude_runs").get(), undefined); db.close();
});


test("startup clears pidless reservations without replaying the original operation", async (t) => {
  const h = harness(t), f = h.completed();
  const db = new DatabaseSync(h.options.db);
  db.prepare("INSERT INTO claude_runs(sessionId) VALUES(?)").run(f.id);
  db.prepare("INSERT INTO claude_operations(key,hash) VALUES(?,?)").run("orphan", createHash("sha256").update(JSON.stringify({ kind: "follow_up", itemId: f.id, message: "Original" })).digest("hex"));
  db.close(); await h.adapter.start();
  assert.equal(await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "New" }), null);
  const old = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Original" }, "orphan");
  assert.equal(old.ok, false); if (!old.ok) assert.equal(old.unknown, true);
  h.registry(f.id, "busy");
  assert.match((await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "New" }))!, /terminal/);
});

test("known acceptance removes logs; unknown logs survive until the seven-day startup prune", async (t) => {
  const { readdirSync, writeFileSync, utimesSync } = await import("node:fs");
  const h = harness(t, { acceptanceTimeoutMs: 160 }), f = h.completed(); await h.adapter.start();
  await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Accepted" }, "known-logs");
  const logs = () => readdirSync(h.options.stateDir).filter((n) => /\.(jsonl|log)$/.test(n));
  assert.deepEqual(logs(), []);
  await until(async () => await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "x" }) === null);
  env(t, "FAKE_CLAUDE_NEVER_ECHO", "1");
  const result = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Unknown" }, "unknown-logs");
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.unknown, true);
  const retained = logs(); assert.equal(retained.length, 2);
  for (const name of retained) assert.equal(statSync(join(h.options.stateDir, name)).mode & 0o777, 0o600);
  await h.adapter.close();
  const recent = h.reopen(); await recent.start(); assert.deepEqual(logs(), retained); await recent.close();
  const old = new Date(h.clock.now - 8 * 86_400_000);
  for (const name of retained) utimesSync(join(h.options.stateDir, name), old, old);
  const unrelated = join(h.options.stateDir, "unrelated.log"); writeFileSync(unrelated, "keep"); utimesSync(unrelated, old, old);
  const pruned = h.reopen(); await pruned.start(); assert.deepEqual(logs(), ["unrelated.log"]);
});

test("synchronous spawn failure releases its reservation and removes private logs", async (t) => {
  const { readdirSync } = await import("node:fs");
  const h = harness(t), f = h.completed(); await h.adapter.start();
  h.options.claudeBin = "invalid\0executable";
  const receipt = await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "x" }, "bad-spawn");
  assert.equal(receipt.ok, false); if (!receipt.ok) assert.match(receipt.error, /couldn't start/);
  const db = new DatabaseSync(h.options.db);
  assert.equal(db.prepare("SELECT 1 FROM claude_runs").get(), undefined); db.close();
  assert.deepEqual(readdirSync(h.options.stateDir).filter((n) => /\.(jsonl|log)$/.test(n)), []);
});


test("a start with no title has Claude Code name the session itself: no --name", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  assert.equal((await h.adapter.execute({ kind: "start_work", placeId: h.adapter.places()[0]!.id, message: "Words stay on stdin", profile }, "untitled")).ok, true);
  const args: string[] = calls(h.config)[0].args;
  assert.ok(!args.some((a) => a.startsWith("--name")), args.join(" "));
});

test("titles are one named argv value, and option-shaped titles are refused", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  const action: Extract<Action, { kind: "start_work" }> = { kind: "start_work", placeId: h.adapter.places()[0]!.id,
    title: "Literal title --permission-mode=bypassPermissions", message: "Words stay on stdin", profile };
  assert.equal((await h.adapter.execute(action, "argv-title")).ok, true);
  const args: string[] = calls(h.config)[0].args;
  assert.ok(args.includes(`--name=${action.title}`));
  assert.ok(!args.includes("--name")); assert.ok(!args.includes(action.message));
  for (const title of ["--dangerously-skip-permissions", "  -x"]) {
    assert.match((await h.adapter.check({ ...action, title }))!, /dash/);
    const result = await h.adapter.execute({ ...action, title }, title);
    assert.equal(result.ok, false);
  }
  assert.equal(calls(h.config).length, 1);
});

test("a follow-up resumes with the session's own permission mode, never above the ceiling", (t) => {
  assert.equal(resumeMode("acceptEdits", "auto"), "acceptEdits");
  assert.equal(resumeMode("plan", "approval-required"), "plan");
  assert.equal(resumeMode("dontAsk", "approval-required"), "dontAsk");
  assert.equal(resumeMode("bypassPermissions", "auto-accept-edits"), "acceptEdits");
  assert.equal(resumeMode("auto", "full-access"), "auto");
  assert.equal(resumeMode(null, "full-access"), null);
  assert.equal(resumeMode("someFutureMode", "full-access"), null);
});

test("a session in acceptEdits is resumed in acceptEdits under a full-access ceiling", async (t) => {
  const h = harness(t, { policy: { maxRuntimeMode: "full-access" } }), f = h.completed(undefined, undefined, "acceptEdits"); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Keep going" }, "own-mode"), { ok: true });
  const args: string[] = calls(h.config)[0].args; assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("a mode switched during the session is the one resumed", async (t) => {
  const h = harness(t, { policy: { maxRuntimeMode: "full-access" } }), f = h.completed(undefined, undefined, "default");
  f.append({ type: "permission-mode", permissionMode: "auto" }); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Carry on" }, "switched"), { ok: true });
  const args: string[] = calls(h.config)[0].args; assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
});

test("a session that doesn't say its permission mode is refused, and nothing runs", async (t) => {
  const h = harness(t, { policy: { maxRuntimeMode: "full-access" } }), f = h.completed(undefined, undefined, null); await h.adapter.start();
  const action: Action = { kind: "follow_up", itemId: f.id, message: "Do it" };
  assert.match((await h.adapter.check(action))!, /can't tell what permissions/);
  assert.equal((await h.adapter.execute(action, "no-mode")).ok, false);
  assert.equal(existsSync(join(h.config, "calls.jsonl")), false);
});
