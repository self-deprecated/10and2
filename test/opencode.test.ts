// The OpenCode adapter against a synthetic OpenCode database (fixtures/opencode/db.ts, 1.19.5's layout) and fake
// OpenCode servers (fixtures/opencode/server.ts): a terminal UI the plugin announces on a unix socket, and Driver's own
// `opencode serve` (a fake executable on TCP). No real OpenCode, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { OpenCodeAdapter, answersFor, openCodeCounts } from "../src/opencode/adapter.ts";
import { installOpenCodePlugin, openCodePluginStatus, uninstallOpenCodePlugin, MARKER, pluginSource } from "../src/opencode/plugin.ts";
import { reach, sessionRules, serveCeiling, evaluate } from "../src/opencode/rules.ts";
import { parseProc } from "../src/opencode/live.ts";
import type { Rule } from "../src/opencode/rules.ts";
import type { Policy } from "../src/policy.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { FakeDb } from "./fixtures/opencode/db.ts";
import { fakeOpenCode, AGENTS } from "./fixtures/opencode/server.ts";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error("Expected condition did not arrive");
}
const ALL: Policy["actions"] = ["follow_up", "settle", "snooze", "archive", "start_work"];

function harness(t: TestContext, o: { policy?: Partial<Policy>; acceptanceTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "driver-opencode-test-"));
  const data = join(root, "data"), live = join(root, "live"), state = join(root, "state"), cwd = join(root, "lap-timer");
  for (const d of [data, live, state, join(cwd, ".git")]) mkdirSync(d, { recursive: true });
  const db = new FakeDb(join(data, "opencode.db"));
  const logs: string[] = [];
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [root], actions: ALL, maxRuntimeMode: "auto", claude: false, t3: false, codex: false, opencode: true, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", ...o.policy };
  // Driver's own server: a fake `opencode` that serves the same database, scripted through a JSON file.
  const bin = join(root, "opencode"), serveConfig = join(root, "fake-serve.json"), serveLog = join(root, "fake-serve.log");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${resolve(import.meta.dirname, "fixtures/opencode/fake-opencode.ts")}" "$@"\n`); chmodSync(bin, 0o755);
  writeFileSync(serveConfig, JSON.stringify({ db: db.path, log: serveLog })); writeFileSync(serveLog, "");
  const old = process.env.FAKE_OPENCODE; process.env.FAKE_OPENCODE = serveConfig;
  const options = { policy, dataDir: data, configDir: join(root, "config"), liveDir: live, opencodeBin: bin, db: join(root, "driver.db"), stateDir: state,
    log: (m: string) => logs.push(m), readCacheMs: 0, scanProcesses: false, acceptanceTimeoutMs: o.acceptanceTimeoutMs ?? 1500 };
  const adapter = new OpenCodeAdapter(options);
  const fakes: { close: () => Promise<void> }[] = [];
  /** A terminal UI open in `dir`, as 10 & 2's plugin announces it: a fake server on its socket, and its JSON beside it. */
  async function tui(dir = cwd, n = 0) {
    const fake = fakeOpenCode(db.path);
    const socket = join(live, `${process.pid}-${n}.sock`);
    await fake.listen(socket);
    writeFileSync(join(live, `${process.pid}-${n}.json`), JSON.stringify({ v: 1, pid: process.pid, kind: "tui", socket, directory: dir, worktree: dir, projectID: "p", startedAt: Date.now(), sessions: {} }));
    fakes.push(fake);
    return fake;
  }
  const serve = {
    script: (s: object) => writeFileSync(serveConfig, JSON.stringify({ db: db.path, log: serveLog, ...s })),
    log: (): any[] => readFileSync(serveLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
  t.after(async () => {
    await adapter.close();
    for (const f of fakes) await f.close();
    try { const r = JSON.parse(readFileSync(join(state, "serve.json"), "utf8")); process.kill(-r.pid, "SIGTERM"); } catch { /* none left */ }
    for (const s of serve.log().filter((l) => l.start)) { try { process.kill(s.pid, "SIGTERM"); } catch { /* stopped */ } }
    if (old === undefined) delete process.env.FAKE_OPENCODE; else process.env.FAKE_OPENCODE = old;
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  return { root, cwd, data, live, state, db, adapter, policy, logs, tui, serve, options };
}
const follow = (itemId: string, message: string): Action => ({ kind: "follow_up", itemId, message });

test("lists the user's own top-level sessions from the last two weeks, in visible folders, with their titles", async (t) => {
  const h = harness(t);
  const recent = h.db.finished(h.cwd, "Add a lap counter", "Added it.", { title: "Lap counter" });
  const untitled = h.db.session({ directory: h.cwd }); h.db.user(untitled, "hello");
  h.db.session({ directory: h.cwd, parentId: recent, title: "Sub job (@general subagent)" });
  h.db.session({ directory: h.cwd, title: "Archived", archived: Date.now() });
  h.db.session({ directory: h.cwd, title: "Old", updated: Date.now() - 20 * 86_400_000 });
  h.db.session({ directory: "/somewhere/else", title: "Hidden" });
  h.db.session({ directory: h.cwd, title: "A script's run", permission: [{ permission: "question", pattern: "*", action: "deny" }, { permission: "plan_enter", pattern: "*", action: "deny" }, { permission: "plan_exit", pattern: "*", action: "deny" }] });
  await h.adapter.start();
  const items = await h.adapter.list();
  assert.deepEqual(items.map((i) => i.title).sort(), ["Lap counter", "an OpenCode session in lap-timer"]);
  const item = items.find((i) => i.id === recent)!;
  assert.equal(item.group, "lap-timer"); assert.equal(item.status, "completed"); assert.equal(item.parentId, null); assert.equal(item.pendingQuestion, false);
  assert.equal(items.find((i) => i.id === untitled)!.status, "idle", "a prompt nothing answered, with nothing running it");
  assert.deepEqual(h.adapter.places().map((p) => p.name), ["lap-timer"]);
  assert.deepEqual(openCodeCounts(h.data, h.live), { sessions: 4, open: 0 }, "top-level, unarchived, recent: a run and a hidden folder count too");
});

test("a session's state comes from its latest turn, and from the process running it", async (t) => {
  const h = harness(t);
  const failed = h.db.session({ directory: h.cwd, title: "Failed" }); h.db.assistant(failed, h.db.user(failed, "go"), { error: "APIError" });
  const cancelled = h.db.session({ directory: h.cwd, title: "Cancelled" }); h.db.assistant(cancelled, h.db.user(cancelled, "go"), { error: "MessageAbortedError" });
  const died = h.db.session({ directory: h.cwd, title: "Died", updated: Date.now() - 3600_000 }); h.db.assistant(died, h.db.user(died, "go", { at: Date.now() - 3600_000 }), { completed: false, text: "Looking", at: Date.now() - 3600_000 });
  const running = h.db.session({ directory: h.cwd, title: "Running" }); const u = h.db.user(running, "Refactor SLOW"); h.db.assistant(running, u, { completed: false, text: "Reading the code" });
  const asking = h.db.session({ directory: h.cwd, title: "Asking" }); h.db.assistant(asking, h.db.user(asking, "Pick one"), { completed: false });
  const permit = h.db.session({ directory: h.cwd, title: "Permit" }); h.db.assistant(permit, h.db.user(permit, "Write a file"), { completed: false });
  const fake = await h.tui();
  fake.state.status = { [running]: { type: "busy" }, [asking]: { type: "busy" }, [permit]: { type: "busy" } };
  fake.state.questions = [{ id: "que_1", sessionID: asking, questions: [{ question: "Which one?", header: "Pick", options: [{ label: "Alpha", description: "a" }, { label: "Beta", description: "b" }] }] }];
  fake.state.permissions = [{ id: "per_1", sessionID: permit, permission: "bash", patterns: ["rm -rf build"], metadata: { command: "rm -rf build" }, always: ["rm *"] }];
  await h.adapter.start();
  const by = Object.fromEntries((await h.adapter.list()).map((i) => [i.title, i]));
  assert.equal(by.Failed!.status, "failed"); assert.equal(by.Cancelled!.status, "cancelled");
  assert.equal(by.Died!.status, "idle", "unfinished an hour ago with nothing reachable running it: its process died");
  assert.equal(by.Running!.status, "running");
  assert.equal((await h.adapter.report(running)).progress, "Reading the code");
  assert.equal(by.Asking!.status, "waiting"); assert.equal(by.Asking!.pendingQuestion, true); assert.equal(by.Asking!.questionId, "que_1");
  assert.equal((await h.adapter.report(asking)).question, "Which one? Options: Alpha / Beta.");
  assert.equal(by.Permit!.status, "waiting"); assert.equal(by.Permit!.questionId, "per_1");
  assert.equal((await h.adapter.report(permit)).question, "OpenCode wants to run rm -rf build.");
});

test("reads the last reply and every finished turn's reply with its prompt, skipping steps that handed over to a tool", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Two turns" });
  const u1 = h.db.user(id, "First ask", { at: Date.now() - 5000 });
  h.db.assistant(id, u1, { text: "Let me look.", finish: "tool-calls", at: Date.now() - 4900 });
  const a1 = h.db.assistant(id, u1, { text: "First answer", at: Date.now() - 4800 });
  const u2 = h.db.user(id, "Second ask", { at: Date.now() - 3000, synthetic: "(file attached)" });
  const a2 = h.db.assistant(id, u2, { text: "Second answer", at: Date.now() - 2900 });
  await h.adapter.start();
  const report = await h.adapter.report(id);
  assert.equal(report.text, "Second answer"); assert.equal(report.question, null);
  assert.equal(report.reply!.messageId, a2.id); assert.equal(report.reply!.runId, u2);
  const replies = await h.adapter.replies(id);
  assert.deepEqual(replies.map((r) => [r.text, r.prompt]), [["Second answer", "Second ask"], ["First answer", "First ask"]]);
  assert.equal(replies[1]!.messageId, a1.id);
  const item = (await h.adapter.list())[0]!;
  assert.equal(item.lastRunAt, report.reply!.at); assert.ok(item.wroteAt);
});

test("a follow-up to a session open in a terminal goes to that terminal's OpenCode, idle or busy, once per key", async (t) => {
  const h = harness(t);
  const id = h.db.finished(h.cwd);
  const fake = await h.tui();
  await h.adapter.start();
  assert.equal(await h.adapter.check(follow(id, "x")), null);
  assert.deepEqual(await h.adapter.execute(follow(id, "Now add a reset button"), "idle"), { ok: true });
  const sent = fake.writes();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.path, `/session/${id}/prompt_async`);
  assert.deepEqual(sent[0]!.body, { parts: [{ type: "text", text: "Now add a reset button" }] });
  assert.equal(sent[0]!.directory, h.cwd);
  assert.deepEqual(await h.adapter.execute(follow(id, "Now add a reset button"), "idle"), { ok: true }, "the same key repeats its outcome");
  assert.deepEqual(await h.adapter.execute(follow(id, "Other words"), "idle"), { ok: false, error: "That operation key was already used for different words or settings." });
  assert.equal(fake.writes().length, 1, "and never sends again");
  // Busy: OpenCode queues it (no reply yet), and the user message is the evidence.
  fake.state.status = { [id]: { type: "busy" } }; fake.state.reply = null;
  assert.deepEqual(await h.adapter.execute(follow(id, "Also keep the laps"), "busy"), { ok: true });
  assert.equal(fake.writes().length, 2);
  assert.equal((await h.adapter.list())[0]!.status, "running");
});

test("with steering off, a session open in OpenCode is refused in words and nothing is sent", async (t) => {
  const h = harness(t, { policy: { steer: false } });
  const id = h.db.finished(h.cwd);
  const fake = await h.tui();
  await h.adapter.start();
  const why = "It's open in OpenCode, and this computer doesn't let 10 & 2 send to open sessions.";
  assert.equal(await h.adapter.check(follow(id, "x")), why);
  assert.deepEqual(h.adapter.refusals()[id], { follow_up: why });
  assert.deepEqual(await h.adapter.execute(follow(id, "x"), "k"), { ok: false, error: why });
  assert.equal(fake.writes().length, 0);
});

test("a session nothing has open is continued in 10 & 2's own OpenCode server, started once under the ceiling, with a password", async (t) => {
  const h = harness(t);
  const a = h.db.finished(h.cwd), b = h.db.finished(h.cwd, "Other", "Done", { title: "Other" });
  await h.adapter.start();
  assert.equal(await h.adapter.check(follow(a, "x")), null);
  assert.deepEqual(await h.adapter.execute(follow(a, "Continue with the tests"), "c1"), { ok: true });
  assert.deepEqual(await h.adapter.execute(follow(b, "And this one"), "c2"), { ok: true });
  const log = h.serve.log(), starts = log.filter((l) => l.start);
  assert.equal(starts.length, 1, "one server, reused");
  assert.equal(starts[0].password, true); assert.equal(starts[0].user, "opencode");
  assert.deepEqual(JSON.parse(starts[0].permission), JSON.parse(serveCeiling("auto")!), "every agent there runs within this machine's ceiling");
  const prompts = log.filter((l) => l.path?.endsWith("/prompt_async"));
  assert.deepEqual(prompts.map((p) => [p.path, p.directory, p.auth, p.body.parts[0].text]), [[`/session/${a}/prompt_async`, h.cwd, true, "Continue with the tests"], [`/session/${b}/prompt_async`, h.cwd, true, "And this one"]]);
  const saved = JSON.parse(readFileSync(join(h.state, "serve.json"), "utf8"));
  assert.equal(saved.dirs[0], h.cwd);
  assert.ok(!h.logs.some((l) => l.includes(saved.password)), "the password is never logged");
  await h.adapter.close();
  await until(() => !existsSync(join(h.state, "serve.json")));
});

test("10 & 2's own server outlives a connector that stops mid-turn, and the next connector picks it up instead of starting another", async (t) => {
  const h = harness(t);
  const a = h.db.finished(h.cwd), b = h.db.finished(h.cwd, "Other", "Done", { title: "Other" });
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute(follow(a, "Long job"), "c1"), { ok: true });
  h.serve.script({ status: { [a]: { type: "busy" } } });
  await until(async () => (await h.adapter.list()).find((i) => i.id === a)!.status === "running");
  await h.adapter.close();
  const saved = JSON.parse(readFileSync(join(h.state, "serve.json"), "utf8"));
  process.kill(saved.pid, 0); // still running its turn
  const next = new OpenCodeAdapter(h.options);
  t.after(() => next.close());
  await next.start();
  assert.equal((await next.list()).find((i) => i.id === a)!.status, "running", "its busy session is seen through it");
  assert.deepEqual(await next.execute(follow(b, "Meanwhile this"), "c2"), { ok: true });
  assert.equal(h.serve.log().filter((l) => l.start).length, 1, "the same server");
  h.serve.script({});
  await until(async () => (await next.list()).find((i) => i.id === a)!.status === "completed");
  await next.close();
  await until(() => !existsSync(join(h.state, "serve.json")));
});

test("a session whose own rules allow more than the ceiling isn't continued", async (t) => {
  const h = harness(t, { policy: { maxRuntimeMode: "approval-required" } });
  const id = h.db.session({ directory: h.cwd, title: "Full access", permission: [{ permission: "*", pattern: "*", action: "allow" }] });
  h.db.assistant(id, h.db.user(id, "go"), { text: "done" });
  await h.adapter.start();
  const why = "That session may do more than this computer lets 10 & 2 run, so 10 & 2 won't send to it.";
  assert.equal(await h.adapter.check(follow(id, "x")), why);
  assert.deepEqual(await h.adapter.execute(follow(id, "x"), "k"), { ok: false, error: why });
  assert.equal(h.serve.log().length, 0, "no server was started");
});

test("new work starts in 10 & 2's own server, or in a terminal open in that project, with the profile's agent and rules", async (t) => {
  const h = harness(t);
  h.db.finished(h.cwd);
  await h.adapter.start();
  const place = h.adapter.places()[0]!.id;
  const profile: LaunchProfile = { name: "Normal", workspace: "root", runtimeMode: "auto-accept-edits", interactionMode: "default" };
  const start = (key: string, p: LaunchProfile, title?: string) => h.adapter.execute({ kind: "start_work", placeId: place, message: "Add a dark mode", profile: p, ...(title ? { title } : {}) }, key);
  const made = await start("s1", profile, "Dark mode");
  assert.equal(made.ok, true, JSON.stringify(made));
  const id = (made as { itemId: string }).itemId;
  assert.match(id, /^ses_/);
  const created = h.serve.log().find((l) => l.method === "POST" && l.path === "/session");
  assert.equal(created.directory, h.cwd); assert.equal(created.body.title, "Dark mode"); assert.equal(created.body.agent, "build");
  assert.deepEqual(created.body.permission.filter((r: Rule) => r.action === "ask").map((r: Rule) => r.permission), ["bash", "task", "webfetch", "websearch", "external_directory", "doom_loop"]);
  assert.equal(reach([...AGENTS()[0]!.permission as Rule[], ...created.body.permission]), "auto-accept-edits");
  assert.deepEqual(await start("s1", profile, "Dark mode"), made, "once per key");
  await until(async () => (await h.adapter.list()).some((i) => i.id === id && i.title === "Dark mode"));
  // A plan, in a terminal that's open in the project: made there, with the plan agent.
  const fake = await h.tui();
  await h.adapter.check({ kind: "start_work", placeId: place, message: "x", profile });
  const plan = await start("s2", { ...profile, interactionMode: "plan", runtimeMode: "approval-required" });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const there = fake.writes().find((w) => w.path === "/session")!;
  assert.equal(there.body.agent, "plan"); assert.equal(there.body.title, undefined, "no title: OpenCode names it");
  assert.equal(fake.writes().find((w) => w.path.endsWith("/prompt_async"))!.body.agent, "plan");
  // Refused in words: more than the ceiling.
  assert.equal(await h.adapter.check({ kind: "start_work", placeId: place, message: "x", profile: { ...profile, runtimeMode: "full-access" } }), "That launch profile exceeds this machine's permission ceiling.");
});

test("OpenCode's own question is answered with the option the user named, through the process asking it", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Asking" }); h.db.assistant(id, h.db.user(id, "Pick one"), { completed: false });
  const fake = await h.tui();
  fake.state.status = { [id]: { type: "busy" } };
  fake.state.questions = [{ id: "que_9", sessionID: id, questions: [{ question: "Which one?", header: "Pick", options: [{ label: "Alpha", description: "a" }, { label: "Beta", description: "b" }] }] }];
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute(follow(id, "Beta, please"), "a1"), { ok: true });
  assert.deepEqual(fake.writes().map((w) => [w.path, w.body]), [["/question/que_9/reply", { answers: [["Beta"]] }]]);
  // With answering off, it's refused.
  const off = harness(t, { policy: { answer: false } });
  const q = off.db.session({ directory: off.cwd, title: "Asking" }); off.db.assistant(q, off.db.user(q, "Pick"), { completed: false });
  const f2 = await off.tui();
  f2.state.status = { [q]: { type: "busy" } }; f2.state.questions = [{ id: "que_2", sessionID: q, questions: [{ question: "Which?", options: [] }] }];
  await off.adapter.start();
  assert.equal(await off.adapter.check(follow(q, "x")), "It's asking you a question in OpenCode, and this computer doesn't let 10 & 2 answer questions.");
});

test("an answer is the option named (each one, when several may be chosen), else the user's own words", () => {
  const q = [{ question: "Seconds or milliseconds?", options: ["Seconds", "Milliseconds"], multiple: false }];
  assert.deepEqual(answersFor(q, "milliseconds, please."), [["Milliseconds"]]);
  assert.deepEqual(answersFor(q, "Neither: show both"), [["Neither: show both"]]);
  assert.deepEqual(answersFor([{ question: "Which?", options: ["Lint", "Tests", "Types"], multiple: true }], "lint and tests"), [["Lint", "Tests"]]);
});

test("a permission request is never granted by a follow-up: it's refused, saying what OpenCode wants", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Permit" }); h.db.assistant(id, h.db.user(id, "Clean up"), { completed: false });
  const fake = await h.tui();
  fake.state.status = { [id]: { type: "busy" } };
  fake.state.permissions = [{ id: "per_1", sessionID: id, permission: "bash", patterns: ["rm -rf build"], metadata: { command: "rm -rf build" } }];
  await h.adapter.start();
  const why = "It's waiting for your OK in OpenCode to run rm -rf build. 10 & 2 doesn't give that; answer it in OpenCode.";
  assert.equal(await h.adapter.check(follow(id, "yes, allow it")), why);
  assert.deepEqual(await h.adapter.execute(follow(id, "yes, allow it"), "p"), { ok: false, error: why });
  assert.equal(fake.writes().length, 0, "nothing sent, and no permission reply");
});

test("a message OpenCode took without recording it is unknown, and never sent again", async (t) => {
  const h = harness(t, { acceptanceTimeoutMs: 300 });
  const id = h.db.finished(h.cwd);
  const fake = await h.tui();
  fake.state.accept = false;
  await h.adapter.start();
  const unknown = await h.adapter.execute(follow(id, "Did it arrive?"), "u");
  assert.deepEqual(unknown, { ok: false, unknown: true, error: "I can't tell whether OpenCode received that. 10 & 2 won't send it again." });
  assert.deepEqual(await h.adapter.execute(follow(id, "Did it arrive?"), "u"), unknown);
  assert.equal(fake.writes().length, 1);
  // One OpenCode refused outright was never sent: said so, not unknown.
  fake.state.accept = 400;
  assert.deepEqual(await h.adapter.execute(follow(id, "Again"), "r"), { ok: false, error: "OpenCode didn't take the message. 10 & 2 won't send it again." });
  // A socket nobody answers on (a crashed terminal) isn't a way in: continued in Driver's own server instead.
  await fake.close();
  await h.adapter.check(follow(id, "x"));
  assert.deepEqual(await h.adapter.execute(follow(id, "After the crash"), "after"), { ok: true });
  assert.equal(h.serve.log().filter((l) => l.path?.endsWith("/prompt_async")).length, 1);
});

test("settle, snooze and archive are kept by 10 & 2; archive hides it here and changes nothing in OpenCode", async (t) => {
  const h = harness(t);
  const id = h.db.finished(h.cwd);
  const fake = await h.tui();
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute({ kind: "settle", itemId: id }, "s"), { ok: true });
  assert.equal((await h.adapter.list())[0]!.settled, true);
  const until_ = new Date(Date.now() + 3600_000).toISOString();
  assert.deepEqual(await h.adapter.execute({ kind: "snooze", itemId: id, until: until_ }, "z"), { ok: true });
  assert.equal((await h.adapter.list())[0]!.snoozedUntil, until_);
  assert.deepEqual(await h.adapter.execute({ kind: "archive", itemId: id }, "a"), { ok: true });
  assert.deepEqual(await h.adapter.list(), []);
  assert.equal(fake.writes().length, 0);
  assert.equal((h.db.db.prepare("SELECT time_archived FROM session WHERE id = ?").get(id) as any).time_archived, null);
});

test("the plugin installs into OpenCode's plugins folder, replaces only its own file, and uninstalls", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "driver-opencode-plugin-")), config = join(root, "opencode");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(config, "plugins", "10and2.js"), shipped = readFileSync(pluginSource(), "utf8");
  assert.equal(shipped.split("\n")[0], MARKER);
  assert.deepEqual(await openCodePluginStatus(config), { installed: false, current: false, path });
  assert.deepEqual(await installOpenCodePlugin(config), { installed: true, current: true, path });
  assert.equal(readFileSync(path, "utf8"), shipped);
  writeFileSync(path, MARKER + "\n// an older version\n");
  assert.deepEqual(await openCodePluginStatus(config), { installed: true, current: false, path });
  await installOpenCodePlugin(config);
  assert.equal(readFileSync(path, "utf8"), shipped, "its own older file is replaced");
  mkdirSync(join(config, "plugin"), { recursive: true }); writeFileSync(join(config, "plugin", "10and2.js"), MARKER + "\n");
  await installOpenCodePlugin(config);
  assert.equal(existsSync(join(config, "plugin", "10and2.js")), false, "a copy in the singular folder would load twice");
  await uninstallOpenCodePlugin(config);
  assert.equal(existsSync(path), false);
  writeFileSync(path, "export const Mine = async () => ({});\n");
  await assert.rejects(installOpenCodePlugin(config), /someone else's file/);
  await uninstallOpenCodePlugin(config);
  assert.equal(readFileSync(path, "utf8"), "export const Mine = async () => ({});\n", "a file of the user's own stays");
});

test("permission rules: OpenCode's last-match-wins, what a ruleset amounts to, and new sessions' rules only ever ask", () => {
  const build = AGENTS()[0]!.permission as Rule[], plan = AGENTS()[1]!.permission as Rule[];
  assert.equal(reach(build), "auto", "build asks only outside the project");
  assert.equal(reach(plan), "auto", "plan denies edits, but runs commands");
  assert.equal(evaluate(build, "read", "app/.env"), "ask");
  assert.equal(evaluate([{ permission: "bash", pattern: "git *", action: "allow" }], "bash", "git"), "allow", "a trailing ' *' also matches nothing");
  for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
    const rules = sessionRules(mode, build, false);
    assert.ok(rules.every((r) => r.action === "ask" || (r.permission === "external_directory" && r.pattern !== "*")));
    assert.equal(reach([...build, ...rules]), mode);
  }
  assert.equal(reach([...build, ...sessionRules("full-access", build, false)]), "full-access");
  assert.deepEqual(sessionRules("full-access", plan, true), [], "a plan keeps the plan agent's rules");
  assert.equal(evaluate([...build, ...sessionRules("auto", build, false)], "external_directory", "/home/u/.local/share/opencode/tool-output/x"), "allow", "OpenCode's own folders stay allowed");
  assert.equal(serveCeiling("full-access"), null);
});

test("ps lines: terminal UIs (with --port or a project path) are told from serve, run and attach", () => {
  assert.deepEqual(parseProc(1, "opencode", "/p"), { pid: 1, kind: "tui", port: null, host: "127.0.0.1", directory: "/p" });
  assert.deepEqual(parseProc(2, "/usr/local/bin/opencode --port 4097", "/p"), { pid: 2, kind: "tui", port: 4097, host: "127.0.0.1", directory: "/p" });
  assert.equal(parseProc(3, "opencode ../other -m mock/mock-model", "/w/p")!.directory, "/w/other");
  assert.equal(parseProc(4, "opencode serve --port 4096", "/")!.kind, "serve");
  assert.equal(parseProc(5, "opencode run hello", "/")!.kind, "run");
  assert.equal(parseProc(6, "opencode attach http://127.0.0.1:4096", "/")!.kind, "other");
  assert.equal(parseProc(7, "node /usr/lib/node_modules/opencode-ai/bin/opencode --port=5000", "/p")!.port, 5000);
  assert.equal(parseProc(8, "vim opencode.json", "/"), null);
});
