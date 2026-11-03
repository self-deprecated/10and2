import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Transcript } from "../src/claude/transcript.ts";
import { pidState, procStart, readRegistry, knownVersion, parsePsStart, darwinIdentity } from "../src/claude/registry.ts";
import { harness, until, pause } from "./fixtures/claude/helpers.ts";

test("registry validates process identity and refuses stale PID reuse", (t) => {
  const h = harness(t), id = randomUUID();
  h.registry(id, "busy");
  assert.equal(readRegistry(h.config)[0]?.status, ["linux", "darwin"].includes(process.platform) ? "busy" : null);
  h.registry(id, "busy", { procStart: process.platform === "darwin" ? "darwin:0" : "0" });
  assert.equal(readRegistry(h.config).length, ["linux", "darwin"].includes(process.platform) ? 0 : 1);

});

test("unknown registry versions and missing procStart block writes without guessing a status", async (t) => {
  const h = harness(t), f = h.completed(); h.registry(f.id, "waiting", { version: "unrecognized" });
  await h.adapter.start();
  assert.equal((await h.adapter.list())[0]?.status, "idle");
  assert.equal((await h.adapter.list())[0]?.pendingQuestion, false);
  assert.match((await h.adapter.check({ kind: "follow_up", itemId: f.id, message: "x" }))!, /terminal/);
  h.registry(f.id, "busy", { procStart: null }); assert.equal(readRegistry(h.config)[0]?.status, process.platform === "darwin" ? "busy" : null);
});

test("partial JSONL and split UTF-8 are read only after the newline, and old bytes are not parsed again", (t) => {
  const h = harness(t), f = h.transcript();
  const line = Buffer.from(JSON.stringify({ type: "assistant", uuid: "a", timestamp: new Date(h.clock.now).toISOString(), message: { content: [{ type: "text", text: "A 🦆 B" }], stop_reason: "end_turn" } }) + "\n");
  const split = line.indexOf(Buffer.from("🦆")) + 2;
  writeFileSync(f.path, line.subarray(0, split)); const reader = new Transcript(f.path); reader.read();
  assert.equal(reader.replies().length, 0); assert.equal(reader.offset, split);
  appendFileSync(f.path, line.subarray(split)); reader.read(); assert.equal(reader.reply?.text, "A 🦆 B");
  const offset = reader.offset; reader.read(); assert.equal(reader.offset, offset); assert.equal(reader.replies().length, 1);
  appendFileSync(f.path, '{"type":"future-record","timestamp":"2999-01-01T00:00:00Z"}\nnot json\n'); reader.read();
  assert.equal(reader.reply?.text, "A 🦆 B"); assert.notEqual(reader.updatedAt, "2999-01-01T00:00:00.000Z");
});

test("transcript replacement discards prior projection and partial line", (t) => {
  const h = harness(t), f = h.completed(), reader = new Transcript(f.path); reader.read(); assert.ok(reader.reply);
  const replacement = f.path + ".new"; writeFileSync(replacement, '{"type":"ai-title","aiTitle":"New conversation"}\n'); renameSync(replacement, f.path); reader.read();
  assert.equal(reader.reply, null); assert.equal(reader.title, "New conversation");
  writeFileSync(f.path, ""); reader.read(); assert.equal(reader.title, null);
});

test("final reply extraction keeps text and tool names, never tool inputs or thinking", async (t) => {
  const h = harness(t), f = h.completed();
  f.append({ type: "user", uuid: "prompt-2", promptId: "turn-2", message: { content: "Next request." } });
  f.append({ type: "assistant", uuid: "tool", message: { content: [{ type: "thinking", thinking: "SECRET_THOUGHT" }, { type: "text", text: "Making progress." }, { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "SECRET_TOOL_INPUT" } }], stop_reason: "tool_use" } });
  h.registry(f.id, "waiting"); await h.adapter.start();
  const report = await h.adapter.report(f.id); assert.equal(report.text, "Synthetic answer."); assert.equal(report.question, "wants to run Bash");
  const item = (await h.adapter.list())[0]!; assert.equal(item.status, "waiting"); assert.equal(item.questionId, "tool-1");
  const publicData = JSON.stringify([item, report, await h.adapter.replies(f.id)]);
  assert.doesNotMatch(publicData, /SECRET_/);
  h.registry(f.id, "busy"); assert.equal((await h.adapter.report(f.id)).progress, "Making progress.");
});

for (const [label, record, expected] of [
  ["API failure", { type: "system", subtype: "api_error" }, "failed"],
  ["assistant failure", { type: "assistant", isApiErrorMessage: true }, "failed"],
  ["interruption", { type: "user", interruptedByShutdown: true }, "cancelled"],
  ["aborted result", { type: "result", terminal_reason: "aborted_by_user" }, "cancelled"],
  ["unfinished prompt", { type: "user", message: { content: "Unfinished" } }, "idle"],
] as const) test(`status mapping: ${label}`, async (t) => {
  const h = harness(t), f = h.completed(); f.append(record); await h.adapter.start();
  assert.equal((await h.adapter.list())[0]?.status, expected);
});

test("busy, idle completed and live-only registry sessions map independently", async (t) => {
  const h = harness(t), f = h.completed(); h.registry(f.id, "busy"); await h.adapter.start();
  assert.equal((await h.adapter.list())[0]?.status, "running");
  h.registry(f.id, "idle"); assert.equal((await h.adapter.list())[0]?.status, "completed");
  const id = randomUUID(); h.registry(id, "waiting"); assert.equal((await h.adapter.list()).find((w) => w.id === id)?.pendingQuestion, true);
});

test("reply refs use the finishing assistant timestamp, one final reply per turn, newest first", async (t) => {
  const h = harness(t), f = h.completed(); h.clock.now += 1000;
  f.append({ type: "user", uuid: "p2", promptId: "run2", message: { content: "Second prompt" } });
  f.append({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "First part" }], stop_reason: "end_turn" } });
  f.append({ type: "assistant", uuid: "a3", message: { content: [{ type: "text", text: "Last part" }], stop_reason: "end_turn" } });
  f.append({ type: "cost-state", totalCostUSD: 1 });
  await h.adapter.start(); const replies = await h.adapter.replies(f.id);
  assert.equal(replies.length, 2); assert.equal(replies[0]?.text, "Last part"); assert.equal(replies[0]?.prompt, "Second prompt");
  assert.equal((await h.adapter.report(f.id)).reply?.runId, "run2");
  assert.equal((await h.adapter.list())[0]?.lastRunAt, replies[0]?.at);
});

test("unknown transcript version degrades to idle rather than inferring a completed turn", async (t) => {
  const h = harness(t), f = h.transcript();
  f.append({ type: "assistant", version: "unrecognized", uuid: "future", message: { content: [{ type: "text", text: "Future schema" }], stop_reason: "end_turn" } });
  await h.adapter.start(); assert.equal((await h.adapter.list())[0]?.status, "idle"); assert.equal((await h.adapter.report(f.id)).text, "");
});

test("sidechain records in a parent transcript never replace its reply or hide the parent", async (t) => {
  const h = harness(t), f = h.completed();
  f.append({ type: "assistant", isSidechain: true, uuid: "child", message: { content: [{ type: "text", text: "PRIVATE_CHILD_REPLY" }], stop_reason: "end_turn" } });
  await h.adapter.start(); assert.equal((await h.adapter.list()).length, 1); assert.equal((await h.adapter.report(f.id)).text, "Synthetic answer.");
});

test("unknown auxiliary versions are ignored and a current resumed turn recovers from an old schema", async (t) => {
  const h = harness(t), f = h.transcript();
  f.append({ type: "user", version: "1.0.0", message: { content: "Old" } });
  f.append({ type: "user", uuid: "current", message: { content: "Current" } });
  f.append({ type: "assistant", uuid: "current-reply", message: { content: [{ type: "text", text: "Current answer" }], stop_reason: "end_turn" } });
  f.append({ type: "future-record", version: "unrecognized" });
  await h.adapter.start(); assert.equal((await h.adapter.list())[0]?.status, "completed"); assert.equal((await h.adapter.report(f.id)).text, "Current answer");
});

test("the fourteen-day cutoff excludes old transcripts but always includes a live holder", async (t) => {
  const h = harness(t); h.clock.now -= 15 * 86_400_000; const f = h.completed(); const old = new Date(h.clock.now); utimesSync(f.path, old, old); h.clock.now += 15 * 86_400_000;
  await h.adapter.start(); assert.deepEqual(await h.adapter.list(), []);
  h.registry(f.id, "idle"); assert.equal((await h.adapter.list())[0]?.id, f.id);
});

test("policy hides sessions from list, report, replies, places and actions", async (t) => {
  const h = harness(t); const outside = join(h.root, "private"); mkdirSync(join(outside, ".git"), { recursive: true });
  const hidden = h.completed(randomUUID(), outside), allowed = h.completed(); await h.adapter.start();
  assert.deepEqual((await h.adapter.list()).map((i) => i.id), [allowed.id]);
  await assert.rejects(h.adapter.report(hidden.id), /visible/); await assert.rejects(h.adapter.replies(hidden.id), /visible/);
  assert.match((await h.adapter.check({ kind: "settle", itemId: hidden.id }))!, /visible/);
  assert.equal(h.adapter.places().length, 1); assert.notEqual(h.adapter.places()[0]?.id, h.cwd);
  h.policy.projects = []; assert.deepEqual(await h.adapter.list(), []); assert.deepEqual(h.adapter.places(), []);
});

test("disabled Claude policy reads no items, and a visible subfolder doesn't grant the git parent", async (t) => {
  const h = harness(t), sub = join(h.cwd, "sub"); mkdirSync(sub); h.completed(randomUUID(), sub); h.policy.projects = [sub];
  await h.adapter.start(); assert.equal((await h.adapter.list()).length, 1); assert.deepEqual(h.adapter.places(), []);
  h.policy.claude = false; assert.deepEqual(await h.adapter.list(), []);
});

test("T3's sessions, other programs' headless and SDK sessions and sidechains are left out; the user's own stay", async (t) => {
  const h = harness(t, { policy: { projects: "*" } });
  const own = h.completed(); own.append({ type: "system", entrypoint: "cli" });
  const sdk = h.completed(); sdk.append({ type: "system", entrypoint: "sdk-ts" });
  const headless = h.completed(); headless.append({ type: "system", entrypoint: "sdk-cli" });
  const marked = h.completed(); marked.append({ type: "api-request-blob", request: { system: "## T3 Code orchestration\nInjected instructions" } });
  const t3 = join(h.root, "workspaces", "project", "t3-123"); mkdirSync(t3, { recursive: true }); h.completed(randomUUID(), t3);
  const side = h.transcript(); side.append({ type: "assistant", isSidechain: true });
  await h.adapter.start(); assert.deepEqual((await h.adapter.list()).map((w) => w.id), [own.id]);
});

test("title prefers a user name over generated title and reports use meaningful timestamps", async (t) => {
  const h = harness(t), f = h.completed(); f.append({ type: "ai-title", aiTitle: "Generated", timestamp: undefined });
  f.append({ type: "agent-name", agentName: "Mine", timestamp: undefined }); f.append({ type: "ai-title", aiTitle: "Later", timestamp: undefined });
  await h.adapter.start(); const w = (await h.adapter.list())[0]!;
  assert.equal(w.title, "Mine"); assert.equal(w.updatedAt, new Date(h.clock.now - 1000).toISOString());
});

test("watch suppresses progress-only and untimestamped churn, emits urgent for a new question", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start(); const changes: { ids: string[]; urgent: boolean }[] = [];
  const off = h.adapter.watch((ids, urgent) => changes.push({ ids, urgent }));
  f.append({ type: "cost-state", timestamp: undefined }); await pause(80); assert.equal(changes.length, 0);
  h.registry(f.id, "busy"); await until(() => changes.length === 1); assert.equal(changes[0]?.urgent, false);
  f.append({ type: "assistant", uuid: "tool", message: { content: [{ type: "text", text: "Progress" }, { type: "tool_use", name: "Read", id: "q1", input: { private: true } }], stop_reason: "tool_use" } });
  await pause(80); assert.equal(changes.length, 1);
  h.registry(f.id, "waiting"); await until(() => changes.length === 2); assert.equal(changes[1]?.urgent, true);
  h.registry(f.id, "waiting"); await pause(80); assert.equal(changes.length, 2);
  off(); h.registry(f.id, "idle"); await pause(80); assert.equal(changes.length, 2);
});

test("overlay persists, repeats do not reset it, newer finished turns wake settle and snooze", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "settle", itemId: f.id }, "settle"), { ok: true });
  assert.equal((await h.adapter.list())[0]?.settled, true);
  await h.adapter.close(); const reopened = h.reopen(); await reopened.start(); assert.equal((await reopened.list())[0]?.settled, true);
  h.clock.now += 10_000; f.append({ type: "assistant", uuid: "new", message: { content: [{ type: "text", text: "New reply" }], stop_reason: "end_turn" } });
  assert.equal((await reopened.list())[0]?.settled, false);
  await reopened.execute({ kind: "settle", itemId: f.id }, "settle"); assert.equal((await reopened.list())[0]?.settled, false);
  const untilAt = new Date(h.clock.now + 60_000).toISOString();
  await reopened.execute({ kind: "snooze", itemId: f.id, until: untilAt }, "snooze"); assert.equal((await reopened.list())[0]?.snoozedUntil, untilAt);
  h.clock.now += 10_000; f.append({ type: "assistant", uuid: "newer", message: { content: [{ type: "text", text: "Newer reply" }], stop_reason: "end_turn" } });
  assert.equal((await reopened.list())[0]?.snoozedUntil, null);
  await reopened.execute({ kind: "archive", itemId: f.id }, "archive"); assert.deepEqual(await reopened.list(), []);
  assert.equal(statSync(h.options.db).mode & 0o777, 0o600);
});

test("snooze expires and a pending question wakes it without a newer reply", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  await h.adapter.execute({ kind: "snooze", itemId: f.id, until: new Date(h.clock.now + 1000).toISOString() }, "s1");
  h.clock.now += 2000; assert.equal((await h.adapter.list())[0]?.snoozedUntil, null);
  await h.adapter.execute({ kind: "snooze", itemId: f.id, until: new Date(h.clock.now + 60_000).toISOString() }, "s2");
  h.registry(f.id, "waiting"); assert.equal((await h.adapter.list())[0]?.snoozedUntil, null);
});

test("removed transcripts disappear and unread marking is unsupported", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start(); rmSync(f.path);
  assert.deepEqual(await h.adapter.list(), []); assert.equal(await h.adapter.markRead(), "unsupported");
});


test("registry and transcripts accept versions above the schema floor and log each newer version once", async (t) => {
  const h = harness(t), f = h.transcript();
  f.append({ type: "user", version: "2.1.312", uuid: "p", message: { content: "New version" } });
  f.append({ type: "assistant", version: "2.1.312", uuid: "a", message: { content: [{ type: "text", text: "Still readable" }], stop_reason: "end_turn" } });
  h.registry(f.id, "busy", { version: "2.1.312" }); await h.adapter.start();
  assert.equal((await h.adapter.list())[0]?.status, "running");
  assert.equal((await h.adapter.report(f.id)).text, "Still readable");
  const logs: string[] = [];
  for (let i = 0; i < 3; i++) assert.equal(knownVersion("2.1.3456", (s) => logs.push(s)), true);
  assert.equal(logs.length, 1);
  assert.equal(knownVersion("2.1.279"), false);
  assert.equal(knownVersion("3.0.0", () => {}), true);
});

for (const stop_reason of ["end_turn", "stop_sequence", "refusal"]) test(`terminal reply is retained: ${stop_reason}`, async (t) => {
  const h = harness(t), f = h.transcript();
  f.append({ type: "user", uuid: "p", message: { content: "Prompt" } });
  f.append({ type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "Terminal answer" }], stop_reason } });
  await h.adapter.start();
  assert.equal((await h.adapter.list())[0]?.status, "completed");
  assert.equal((await h.adapter.report(f.id)).text, "Terminal answer");
  assert.equal((await h.adapter.replies(f.id))[0]?.prompt, "Prompt");
});

test("Darwin ps parsing verifies Claude/node identity and detects reused pids", () => {
  const stamp = "Fri Oct 30 10:12:34 2026";
  const at = parsePsStart(stamp)!;
  assert.ok(Number.isFinite(at));
  assert.equal(parsePsStart("garbage"), null);
  assert.equal(darwinIdentity("/usr/local/bin/claude\n", stamp, `darwin:${at}`), "verified");
  assert.equal(darwinIdentity("/opt/homebrew/bin/node", stamp, null, new Date(at + 2000).toISOString()), "verified");
  assert.equal(darwinIdentity("node", stamp, `darwin:${at - 60_000}`), "dead");
  assert.equal(darwinIdentity("/usr/bin/python3", stamp, null), "dead");
  assert.equal(darwinIdentity("claude", stamp, null), "verified");
});

test("a transcript whose first records rule it out is read no further, however big it grows", async (t) => {
  const h = harness(t);
  const own = h.completed();
  own.append({ type: "user", uuid: "x", entrypoint: "cli", message: { content: "Mine." } });
  const sdk = h.transcript();
  sdk.append({ type: "user", uuid: "s1", entrypoint: "sdk-ts", message: { content: "An app's prompt." } });
  // Megabytes of an app's run after its first record.
  const big = "y".repeat(64 * 1024);
  for (let n = 0; n < 32; n++) sdk.append({ type: "assistant", uuid: `a${n}`, message: { content: [{ type: "text", text: big }], stop_reason: "end_turn" } });
  await h.adapter.start();
  assert.deepEqual((await h.adapter.list()).map((i) => i.id), [own.id], "only the user's own session is listed");
  const readers: Map<string, { offset: number }> = (h.adapter as any).readers;
  assert.equal(readers.has(sdk.path), false, "no reader is kept for the app's transcript");
  assert.ok((h.adapter as any).skipped.has(sdk.path), "it is remembered as left out");
  // More of it later isn't read either.
  sdk.append({ type: "assistant", uuid: "late", message: { content: [{ type: "text", text: big }], stop_reason: "end_turn" } });
  await h.adapter.list();
  assert.equal(readers.has(sdk.path), false);
});
