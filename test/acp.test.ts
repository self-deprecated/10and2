// The ACP adapter (Gemini CLI, Copilot CLI): their session files read into items and reports, a fake ACP agent
// (fixtures/acp/agent.mjs) continuing and starting sessions through the detached runner, and what a launch sets.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AcpAdapter } from "../src/acp/adapter.ts";
import { changes } from "../src/acp/turn.ts";
import { parseLsofCwd, parsePs, type Proc } from "../src/acp/processes.ts";
import { GeminiSession } from "../src/gemini/session.ts";
import { GeminiSource, isGemini } from "../src/gemini/source.ts";
import { askText, CopilotSession, parseWorkspace } from "../src/copilot/session.ts";
import { AGENT, CopilotSource, PLAN } from "../src/copilot/source.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import type { Policy } from "../src/policy.ts";
import { nodeCommand, removeDir, SLOW } from "./fixtures/platform.ts";

const agentScript = resolve(import.meta.dirname, "fixtures", "acp", "agent.mjs");
const runner = resolve(import.meta.dirname, "fixtures", "acp", "turn.ts");
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(test: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms * SLOW;
  while (Date.now() < end) { if (await test()) return; await pause(20); }
  throw new Error("Expected condition did not arrive");
}
const lines = (...records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const at = (s: number) => new Date(Date.UTC(2026, 10, 21, 10, 0, s)).toISOString();

test("a Gemini session file: its edits, rewinds and patches applied; Gemini's own context and slash commands left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "gemini-session-")), path = join(dir, "session-2026-11-21T10-00-abcdef12.jsonl");
  writeFileSync(path, lines(
    { sessionId: "abcdef12-0000-4000-8000-000000000000", projectHash: "h", startTime: at(0), lastUpdated: at(0), kind: "main" },
    { id: "ctx", timestamp: at(1), type: "user", content: [{ text: "<session_context>\nThis is the Gemini CLI." }] },
    { id: "u1", timestamp: at(2), type: "user", content: [{ text: "Fix the build" }] },
    { id: "g1", timestamp: at(3), type: "gemini", content: "Looking.", toolCalls: [{ id: "c1", name: "read_file" }] },
    { id: "g2", timestamp: at(4), type: "gemini", content: "Fixed it." },
    { $set: { lastUpdated: at(4), summary: "Fix the build" } },
    { id: "slash", timestamp: at(5), type: "user", content: [{ text: "/stats" }] },
    { id: "u2", timestamp: at(6), type: "user", content: [{ text: "And the tests?" }] },
    { id: "g3", timestamp: at(7), type: "gemini", content: "Wrong answer" },
    { $rewindTo: "g3" },
    { id: "g4", timestamp: at(8), type: "gemini", content: "Draft" },
    { $patch: { updates: [{ id: "g4", content: [{ text: "Tests pass." }] }] } },
  ));
  const s = new GeminiSession(path);
  s.read();
  assert.equal(s.id, "abcdef12-0000-4000-8000-000000000000");
  assert.equal(s.summary, "Fix the build");
  const p = s.projection;
  assert.equal(p.status, "completed");
  assert.deepEqual(p.first, { text: "Fix the build", at: at(2) });
  assert.deepEqual(p.replies.map((r) => [r.text, r.prompt]), [["Tests pass.", "And the tests?"], ["Fixed it.", "Fix the build"]]);
  assert.equal(s.userCount, 2);
  assert.ok(s.says("And the tests?", 1) && !s.says("Fix the build", 1));
  // Appended later: read from where it left off.
  appendFileSync(path, lines({ id: "u3", timestamp: at(9), type: "user", content: [{ text: "Now ship it" }] }));
  s.read();
  assert.equal(s.projection.status, "idle");
  assert.equal(s.projection.unanswered, true);
  // Releases before JSON lines wrote one object.
  const old = join(dir, "session-2026-01-01T00-00-11111111.json");
  writeFileSync(old, JSON.stringify({ sessionId: "11111111-0000-4000-8000-000000000000", projectHash: "h", startTime: at(0), lastUpdated: at(2),
    messages: [{ id: "a", timestamp: at(1), type: "user", content: "Hello" }, { id: "b", timestamp: at(2), type: "gemini", content: "Hi." }] }));
  const o = new GeminiSession(old); o.read();
  assert.equal(o.projection.replies[0]?.text, "Hi.");
  removeDir(dir);
});

test("a Copilot session: its workspace, the user's words only, a pending ask_user, an abort, and who holds it open", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-session-")), id = randomUUID();
  writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: /work/app\nname: "Fix: the build"\nuser_named: true\ncreated_at: ${at(0)}\n`);
  const e = (type: string, data: object, s: number) => ({ type, data, id: randomUUID(), timestamp: at(s), parentId: null });
  writeFileSync(join(dir, "events.jsonl"), lines(
    e("session.start", { sessionId: id, context: { cwd: "/work/app" } }, 0),
    e("user.message", { content: "Fix the build", transformedContent: "<current_datetime/>Fix the build" }, 1),
    e("assistant.message", { content: "", toolRequests: [{ toolCallId: "c1", name: "bash" }] }, 2),
    e("tool.execution_start", { toolCallId: "c1", toolName: "bash" }, 2),
    e("tool.execution_complete", { toolCallId: "c1", success: true }, 3),
    e("assistant.message", { content: "Done.", toolRequests: [] }, 4),
    e("user.message", { content: "keep going", isAutopilotContinuation: true }, 5),
    e("user.message", { content: "Which db?" }, 6),
    e("assistant.message", { content: "", toolRequests: [{ toolCallId: "q1", name: "ask_user" }] }, 7),
    e("tool.execution_start", { toolCallId: "q1", toolName: "ask_user", arguments: { message: "Which one?", requestedSchema: { properties: { pick: { type: "string", enum: ["Alpha", "Beta"] } } } } }, 7),
  ));
  writeFileSync(join(dir, `inuse.${process.pid}.lock`), String(process.pid));
  const s = new CopilotSession(dir); s.read();
  assert.equal(s.id, id); assert.equal(s.cwd, "/work/app"); assert.equal(s.name, "Fix: the build");
  assert.equal(s.question, "Which one? Options: Alpha / Beta.");
  assert.equal(s.userCount, 2, "autopilot's own continuation isn't the user's");
  assert.deepEqual(s.projection.replies.map((r) => r.text), ["Done."]);
  assert.deepEqual(s.holders(), [process.pid]);
  appendFileSync(join(dir, "events.jsonl"), lines(e("tool.execution_complete", { toolCallId: "q1" }, 8), e("abort", { reason: "user" }, 9)));
  s.read();
  assert.equal(s.question, null);
  assert.equal(s.projection.status, "cancelled");
  assert.deepEqual(parseWorkspace("id: x\nname: 'it''s'\nuser_named: false\n"), { id: "x", name: "it's", user_named: "false" });
  writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: /work/app\nname: Fix the build\nuser_named: false\n`);
  s.read();
  assert.equal(s.name, null, "Copilot's own name for it is only its first words");
  assert.equal(askText({ message: "Go?" }), "Go?");
  removeDir(dir);
});

test("the Copilot source lists sessions with something said, and one is open while a running Copilot holds its lock", () => {
  const home = mkdtempSync(join(tmpdir(), "copilot-home-")), source = new CopilotSource({ dir: home });
  const make = (said: boolean, pid?: number) => {
    const id = randomUUID(), dir = join(home, "session-state", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.yaml"), `id: ${id}\ncwd: /work/app\n`);
    writeFileSync(join(dir, "events.jsonl"), said ? lines({ type: "user.message", data: { content: "Hi" }, id: "1", timestamp: at(1) }) : "");
    if (pid) writeFileSync(join(dir, `inuse.${pid}.lock`), String(pid));
    return id;
  };
  const open = make(true, process.pid), gone = make(true, 2 ** 22 + 12345), empty = make(false);
  const found = source.sessions(0, new Set());
  assert.deepEqual(new Set(found.filter((f) => f.started).map((f) => f.id)), new Set([open, gone]));
  assert.ok(found.some((f) => f.id === empty && !f.started), "read, but not started");
  assert.deepEqual([...source.open(found, new Set())], [open], "a lock whose Copilot is gone doesn't count");
  assert.deepEqual([...source.open(found, new Set([process.pid]))], [], "nor does one of Driver's own runs");
  assert.equal(source.find(open)?.cwd, "/work/app");
  removeDir(home);
});

test("a launch's mode and approvals: exact for new work, kept where the ceiling allows and lowered where it doesn't", () => {
  const gemini = new GeminiSource({ dir: "/nonexistent" }), copilot = new CopilotSource({ dir: "/nonexistent" });
  assert.deepEqual(gemini.launch("full-access", false), { mode: "yolo" });
  assert.deepEqual(gemini.launch("auto-accept-edits", false), { mode: "autoEdit" });
  assert.deepEqual(gemini.launch("approval-required", false), { mode: "default" });
  assert.deepEqual(gemini.launch("full-access", true), { mode: "plan" });
  assert.deepEqual(copilot.launch("auto", false), { mode: AGENT, options: { allow_all: "off" } }, "Copilot has no edits-only mode: below full access it asks, and Driver refuses");
  assert.deepEqual(copilot.launch("full-access", true), { mode: PLAN, options: { allow_all: "on" } });
  // A session the user ran in YOLO, continued under an auto-accept-edits ceiling, is lowered; one in plan mode is kept.
  const lowered = { settings: gemini.launch("auto-accept-edits", false), exact: false, allowed: gemini.allowed("auto-accept-edits") };
  assert.deepEqual(changes({ command: [], cwd: "", message: "", ...lowered }, { mode: "yolo", options: {} }), [["mode", "mode", "autoEdit"]]);
  assert.deepEqual(changes({ command: [], cwd: "", message: "", ...lowered }, { mode: "plan", options: {} }), []);
  // Copilot's allow_all on is turned off below full access; an autopilot session leaves autopilot and sets it again.
  const cp = { settings: copilot.launch("approval-required", false), exact: false, allowed: copilot.allowed("approval-required") };
  assert.deepEqual(changes({ command: [], cwd: "", message: "", ...cp }, { mode: AGENT, options: { allow_all: "on" } }), [["option", "allow_all", "off"]]);
  assert.deepEqual(changes({ command: [], cwd: "", message: "", ...cp }, { mode: `${AGENT.slice(0, -5)}autopilot`, options: { allow_all: "off" } }), [["mode", "mode", AGENT], ["option", "allow_all", "off"]]);
  assert.deepEqual(changes({ command: [], cwd: "", message: "", settings: copilot.launch("full-access", false), exact: true }, { mode: AGENT, options: { allow_all: "off" } }), [["option", "allow_all", "on"]]);
});

test("processes: a Gemini CLI is told by its command, and macOS's ps and lsof are read", () => {
  assert.ok(isGemini(["node", "/usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js"]));
  assert.ok(isGemini(["/nix/store/x-gemini-cli-0.70.0/bin/.gemini-wrapped", "--resume", "abc"]));
  assert.ok(isGemini(["gemini"]));
  assert.ok(!isGemini(["node", "/home/me/gemini-notes/server.js"]) && !isGemini(["vim", "gemini.md"]));
  const ps = parsePs("  412 Sat Nov 21 10:00:05 2026     node /opt/homebrew/bin/gemini --resume 5feaeb47\n 9 junk\n");
  assert.equal(ps.length, 1); assert.equal(ps[0]!.pid, 412); assert.deepEqual(ps[0]!.args.slice(1), ["/opt/homebrew/bin/gemini", "--resume", "5feaeb47"]);
  assert.deepEqual([...parseLsofCwd("p412\nfcwd\nn/Users/me/app\np413\nn/tmp\n")], [[412, "/Users/me/app"], [413, "/tmp"]]);
});

type Opts = { policy?: Partial<Policy>; procs?: Proc[]; env?: Record<string, string> };
/** A private Gemini folder, a project, the fake ACP agent as `gemini --acp`, and an adapter over them. */
function harness(t: TestContext, opts: Opts = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-test-"))), gemini = join(root, ".gemini"), cwd = join(root, "project"), log = join(root, "acp.jsonl");
  mkdirSync(join(cwd, ".git"), { recursive: true }); mkdirSync(join(gemini, "tmp"), { recursive: true }); writeFileSync(log, "");
  const saved = { ...process.env };
  Object.assign(process.env, { FAKE_GEMINI_DIR: gemini, FAKE_ACP_LOG: log }, opts.env ?? {});
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
    claude: false, t3: false, codex: false, opencode: false, pi: false, gemini: true, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", ...opts.policy };
  const procs = opts.procs ?? [];
  const source = new GeminiSource({ dir: gemini, command: nodeCommand(agentScript), processes: () => procs });
  const logs: string[] = [];
  const adapter = new AcpAdapter({ policy, source, db: join(root, "gemini.db"), stateDir: join(root, "state"), entryScript: runner, readCacheMs: 0,
    log: (s) => logs.push(s), acceptanceTimeoutMs: 8000 * SLOW });
  t.after(async () => { await adapter.close(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); removeDir(root); });
  /** A session the user had in a terminal, as Gemini writes it. */
  function session(text: string, reply: string, id = randomUUID()) {
    const chats = join(gemini, "tmp", "project", "chats");
    mkdirSync(chats, { recursive: true }); writeFileSync(join(gemini, "tmp", "project", ".project_root"), cwd);
    const path = join(chats, `session-2026-11-21T10-00-${id.slice(0, 8)}.jsonl`), now = Date.now();
    writeFileSync(path, lines({ sessionId: id, projectHash: "h", startTime: new Date(now - 60_000).toISOString(), lastUpdated: new Date(now).toISOString(), kind: "main" },
      { id: "u", timestamp: new Date(now - 50_000).toISOString(), type: "user", content: [{ text }] },
      { id: "g", timestamp: new Date(now - 40_000).toISOString(), type: "gemini", content: reply }));
    return { id, path };
  }
  const requests = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { adapter, cwd, root, session, requests, logs, procs };
}
const follow = (itemId: string, message: string): Action => ({ kind: "follow_up", itemId, message });
const profile = (p: Partial<LaunchProfile> = {}): LaunchProfile => ({ name: "Build", workspace: "root", runtimeMode: "full-access", interactionMode: "default", ...p });

test("Gemini through ACP: listed and read; a closed session continued; new work started on a chosen model; tidy kept here", async (t) => {
  const h = harness(t), s = h.session("Fix the flaky test", "Fixed it: the clock was real.");
  await h.adapter.start();
  const [item] = await h.adapter.list();
  assert.equal(item?.id, s.id); assert.equal(item?.title, "Fix the flaky test"); assert.equal(item?.status, "completed"); assert.equal(item?.group, "project");
  assert.equal((await h.adapter.report(s.id)).text, "Fixed it: the clock was real.");
  const asked = await h.adapter.firstAsk(s.id);
  assert.equal(asked?.text, "Fix the flaky test"); assert.equal(asked?.complete, true);
  // The models a new session can start on, read from the agent's own list (the one it would use first).
  await until(() => (h.adapter.places()[0]?.models ?? []).length > 0);
  assert.deepEqual(h.adapter.places()[0]!.models, [{ id: "m-flash", name: "Flash" }, { id: "m-pro", name: "Pro" }]);

  // A closed session the user had: continued as it was, Gemini's own mode kept within the ceiling.
  assert.equal(await h.adapter.check(follow(s.id, "x")), null);
  assert.deepEqual(await h.adapter.execute(follow(s.id, "And the other one?"), "k1"), { ok: true });
  await until(async () => (await h.adapter.report(s.id)).text === "ACK And the other one? [default/m-flash]");
  assert.ok(!h.requests().some((r) => r.method === "session/set_mode"), "a mode within the ceiling is kept");
  assert.deepEqual(await h.adapter.execute(follow(s.id, "And the other one?"), "k1"), { ok: true }, "the same key is the same receipt");

  // New work on a chosen model, full access: YOLO, titled as the brain named it.
  const place = h.adapter.places()[0]!.id;
  const started = await h.adapter.execute({ kind: "start_work", placeId: place, title: "Speed up CI", message: "/make it fast", profile: profile(), model: "m-pro" }, "k2");
  assert.equal(started.ok, true, JSON.stringify(started));
  const id = started.ok ? started.itemId! : "";
  await until(async () => (await h.adapter.report(id)).text === "ACK /make it fast [yolo/m-pro]");
  assert.equal((await h.adapter.list()).find((i) => i.id === id)?.title, "Speed up CI");
  // Its follow-up runs as it was started.
  await until(async () => (await h.adapter.check(follow(id, "x"))) === null);
  assert.deepEqual(await h.adapter.execute(follow(id, "PERM touch it"), "k3"), { ok: true });
  await until(async () => (await h.adapter.report(id)).text.startsWith("ACK PERM touch it (permission: no) [yolo"), 8000);

  for (const [kind, key] of [["settle", "k4"], ["archive", "k5"]] as const) assert.deepEqual(await h.adapter.execute({ kind, itemId: s.id }, key), { ok: true });
  assert.ok(!(await h.adapter.list()).some((i) => i.id === s.id), "archived here, never in Gemini's own files");
});

test("Gemini through ACP: a permission is never granted, a plan starts in plan mode, and a session open in a terminal isn't sent to", async (t) => {
  const h = harness(t, { policy: { maxRuntimeMode: "auto-accept-edits" } }), s = h.session("Tidy the docs", "Tidied.");
  await h.adapter.start();
  const place = h.adapter.places()[0]!.id;
  assert.match(await h.adapter.check({ kind: "start_work", placeId: place, message: "x", profile: profile() }) ?? "", /more access than this machine allows/);
  const started = await h.adapter.execute({ kind: "start_work", placeId: place, message: "PERM plan it", profile: profile({ runtimeMode: "auto-accept-edits", interactionMode: "plan" }) }, "p1");
  assert.equal(started.ok, true, JSON.stringify(started));
  const id = started.ok ? started.itemId! : "";
  await until(async () => (await h.adapter.report(id)).text === "ACK PERM plan it (permission: no) [plan/m-flash]");

  // A Gemini running in the project since before the session was last written has it open.
  h.procs.push({ pid: 999_999, args: ["gemini"], cwd: h.cwd, startMs: Date.now() - 3_600_000 });
  const refused = await h.adapter.check(follow(s.id, "x"));
  assert.match(refused ?? "", /open in Gemini CLI/);
  assert.deepEqual(await h.adapter.execute(follow(s.id, "x"), "p2"), { ok: false, error: refused });
  // Not what Driver's own run wrote, though: that's its own.
  assert.equal(await h.adapter.check(follow(id, "x")), null);
});

test("Gemini through ACP: a mode the agent refuses stops the turn before anything is sent, and says why", async (t) => {
  const h = harness(t, { env: { FAKE_UNTRUSTED: "1" } });
  h.session("Start", "Started.");
  await h.adapter.start();
  const r = await h.adapter.execute({ kind: "start_work", placeId: h.adapter.places()[0]!.id, message: "go", profile: profile() }, "u1");
  assert.deepEqual(r, { ok: false, error: "Gemini CLI said: Cannot enable privileged approval modes in an untrusted folder." });
  assert.ok(!h.requests().some((q) => q.method === "session/prompt"));
});
