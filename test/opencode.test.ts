// The OpenCode adapter against a synthetic OpenCode database (fixtures/opencode/db.ts, 1.19.5's layout) and fake
// OpenCode servers (fixtures/opencode/server.ts): a terminal UI the plugin announces on a unix socket (on Windows on
// 127.0.0.1 with a token), and Driver's own `opencode serve` (a fake command on TCP). No real OpenCode, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { OpenCodeAdapter, answersFor, openCodeCounts, sameFolder } from "../src/opencode/adapter.ts";
import { installOpenCodePlugin, openCodePluginStatus, uninstallOpenCodePlugin, MARKER, pluginSource } from "../src/opencode/plugin.ts";
import { reach, sessionRules, serveCeiling, evaluate, wildcard } from "../src/opencode/rules.ts";
import { alive, call, parseProc, pluginEndpoints } from "../src/opencode/live.ts";
import { fromStorage } from "../src/opencode/db.ts";
import { Serve } from "../src/opencode/serve.ts";
import type { Rule } from "../src/opencode/rules.ts";
import type { Policy } from "../src/policy.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { FakeDb } from "./fixtures/opencode/db.ts";
import { fakeOpenCode, AGENTS } from "./fixtures/opencode/server.ts";
import { fakeBun } from "./fixtures/opencode/bun.ts";
import { assertPrivate, nodeCommand, removeDir, SLOW, WINDOWS } from "./fixtures/platform.ts";
import { Local } from "../src/local.ts";
import { ANSWERED } from "../src/util.ts";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 3000 * SLOW) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error("Expected condition did not arrive");
}
const ALL: Policy["actions"] = ["follow_up", "settle", "snooze", "archive", "start_work"];
const FAKE_OPENCODE = resolve(import.meta.dirname, "fixtures/opencode/fake-opencode.ts");
/** Ends a fake server a test started: its process group, or on Windows (no groups) the one Node process it is. */
const end = (pid: number) => { try { process.kill(WINDOWS ? pid : -pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* stopped */ } } };
const freePort = () => new Promise<number>((done) => {
  const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); });
});

function harness(t: TestContext, o: { policy?: Partial<Policy>; acceptanceTimeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "driver-opencode-test-"));
  const data = join(root, "data"), live = join(root, "live"), state = join(root, "state"), cwd = join(root, "lap-timer");
  for (const d of [data, live, state, join(cwd, ".git")]) mkdirSync(d, { recursive: true });
  const db = new FakeDb(join(data, "opencode.db"));
  const logs: string[] = [];
  // The project as a real path, as parsePolicy makes a policy's folders: macOS's $TMPDIR is under /var, a link to
  // /private/var, so a policy written with it saw nothing there.
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [realpathSync(root)], actions: ALL, maxRuntimeMode: "auto", claude: false, t3: false, codex: false, opencode: true, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", ...o.policy };
  // Driver's own server: a fake `opencode` that serves the same database, scripted through a JSON file.
  const serveConfig = join(root, "fake-serve.json"), serveLog = join(root, "fake-serve.log");
  writeFileSync(serveConfig, JSON.stringify({ db: db.path, log: serveLog })); writeFileSync(serveLog, "");
  const old = process.env.FAKE_OPENCODE; process.env.FAKE_OPENCODE = serveConfig;
  const options = { policy, dataDir: data, configDir: join(root, "config"), liveDir: live, opencodeCommand: nodeCommand(FAKE_OPENCODE), db: join(root, "driver.db"), stateDir: state,
    log: (m: string) => logs.push(m), readCacheMs: 0, scanProcesses: false, acceptanceTimeoutMs: o.acceptanceTimeoutMs ?? 1500 };
  const adapter = new OpenCodeAdapter(options);
  const fakes: { close: () => Promise<void> }[] = [];
  /**
   * A terminal UI open in `dir`, as 10 & 2's plugin announces it: a fake server on its socket, or (`tcp`, and always on
   * Windows, where the plugin can't use a socket) on 127.0.0.1 with a token, and its JSON beside it.
   */
  async function tui(dir = cwd, n = 0, o: { tcp?: boolean; announce?: object } = {}) {
    const fake = fakeOpenCode(db.path);
    let where: object;
    if (o.tcp ?? WINDOWS) {
      fake.state.auth = `Bearer ${randomBytes(32).toString("hex")}`;
      where = { url: `http://127.0.0.1:${await fake.listen(0)}`, auth: fake.state.auth };
    } else {
      const socket = join(live, `${process.pid}-${n}.sock`);
      await fake.listen(socket);
      where = { socket };
    }
    writeFileSync(join(live, `${process.pid}-${n}.json`), JSON.stringify({ v: 1, pid: process.pid, kind: "tui", ...where, directory: dir, worktree: dir, projectID: "p", startedAt: Date.now(), sessions: {}, ...o.announce }));
    fakes.push(fake);
    return fake;
  }
  const serve = {
    script: (s: object) => writeFileSync(serveConfig, JSON.stringify({ db: db.path, log: serveLog, ...s })),
    log: (): any[] => readFileSync(serveLog, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)),
  };
  t.after(async () => {
    await adapter.close();
    for (const f of fakes) await f.close();
    try { end(JSON.parse(readFileSync(join(state, "serve.json"), "utf8")).pid); } catch { /* none left */ }
    for (const s of serve.log().filter((l) => l.start)) end(s.pid);
    if (old === undefined) delete process.env.FAKE_OPENCODE; else process.env.FAKE_OPENCODE = old;
    db.close(); removeDir(root);
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

test("a session's start is its time_created, and its first ask the user's first words, not what OpenCode added", async (t) => {
  const h = harness(t), start = Date.now() - 10_000;
  const id = h.db.session({ directory: h.cwd, title: "Screenshots", created: start });
  h.db.user(id, "", { at: start + 1000, synthetic: "(file attached)" });
  h.db.assistant(id, h.db.user(id, "  Improve the screenshot stuff.\n", { at: start + 2000 }), { text: "Done.", at: start + 3000 });
  h.db.user(id, "Now the tests.", { at: start + 4000 });
  const quiet = h.db.session({ directory: h.cwd, title: "Quiet" });
  await h.adapter.start();
  const items = new Map((await h.adapter.list()).map((i) => [i.id, i]));
  assert.equal(items.get(id)?.createdAt, new Date(start).toISOString());
  assert.deepEqual(await h.adapter.firstAsk(id), { text: "Improve the screenshot stuff.", at: new Date(start + 2000).toISOString(), complete: true });
  assert.equal(await h.adapter.firstAsk(quiet), null);
  await assert.rejects(h.adapter.firstAsk("ses_missing"), /isn't visible/);
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
  // The plugin inside it announces it too, marked as Driver's own (its pid may be a launcher's, as with Scoop's shims):
  // that's never taken for a terminal the user has open.
  const own = await h.tui(h.cwd, 0, { announce: { driverServe: JSON.parse(readFileSync(join(h.state, "serve.json"), "utf8")).mark } });
  assert.deepEqual(await h.adapter.execute(follow(b, "And this one"), "c2"), { ok: true });
  assert.equal(own.writes().length, 0);
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
  // Refused in words: more than the ceiling, and a model (it lists none to 10 & 2 yet).
  assert.equal(await h.adapter.check({ kind: "start_work", placeId: place, message: "x", profile: { ...profile, runtimeMode: "full-access" } }), "That launch profile exceeds this machine's permission ceiling.");
  assert.deepEqual(h.adapter.places()[0]!.models, []);
  assert.equal(await h.adapter.check({ kind: "start_work", placeId: place, message: "x", profile, model: "anthropic/claude-opus-5-5" }), "OpenCode can't start on a chosen model through 10 & 2 yet.");
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

test("a question OpenCode holds is input, its own options its choices, and a tap answers it; a permission is an approval, with none", async (t) => {
  const h = harness(t);
  const asking = h.db.session({ directory: h.cwd, title: "Asking" }); h.db.assistant(asking, h.db.user(asking, "Pick one"), { completed: false });
  const open = h.db.session({ directory: h.cwd, title: "Open" }); h.db.assistant(open, h.db.user(open, "Ask me"), { completed: false });
  const permit = h.db.session({ directory: h.cwd, title: "Permit" }); h.db.assistant(permit, h.db.user(permit, "Clean up"), { completed: false });
  const done = h.db.finished(h.cwd);
  const fake = await h.tui();
  fake.state.status = { [asking]: { type: "busy" }, [open]: { type: "busy" }, [permit]: { type: "busy" } };
  fake.state.questions = [
    { id: "que_1", sessionID: asking, questions: [{ question: "Which one?", header: "Pick", options: [{ label: "C++", description: "a" }, { label: "C#", description: "b" }] }] },
    { id: "que_2", sessionID: open, questions: [{ question: "What should it be called?", options: [] }] },
  ];
  fake.state.permissions = [{ id: "per_1", sessionID: permit, permission: "bash", patterns: ["rm -rf build"], metadata: { command: "rm -rf build" } }];
  await h.adapter.start();
  const by = Object.fromEntries((await h.adapter.list()).map((i) => [i.id, i]));
  assert.deepEqual([asking, open, permit, done].map((id) => by[id]!.questionKind), ["input", "input", "approval", undefined]);
  assert.deepEqual((await h.adapter.report(asking)).choices, ["C++", "C#"]);
  assert.equal((await h.adapter.report(open)).choices, null, "an open question: no options to tap");
  assert.equal((await h.adapter.report(permit)).choices, null);
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: asking, message: "C#", questionId: "que_1" }, "tap"), { ok: true });
  assert.deepEqual(fake.writes().map((w) => [w.path, w.body]), [["/question/que_1/reply", { answers: [["C#"]] }]]);
});

test("a tap answers only the question it was for: one asked instead, or none, while Local's check awaited sends nothing", async (t) => {
  for (const asksAgain of [true, false]) {
    const h = harness(t);
    const asking = h.db.session({ directory: h.cwd, title: "Asking" }); h.db.assistant(asking, h.db.user(asking, "Pick one"), { completed: false });
    const fake = await h.tui();
    const options = [{ label: "C++", description: "a" }, { label: "C#", description: "b" }];
    fake.state.status = { [asking]: { type: "busy" } };
    fake.state.questions = [{ id: "que_1", sessionID: asking, questions: [{ question: "Which one?", header: "Pick", options }] }];
    await h.adapter.start();
    const local = new Local([{ prefix: "", adapter: h.adapter }], h.policy);
    // After Local looked, while the adapter's check yields: OpenCode asks another question instead, or none and works on.
    const check = h.adapter.check.bind(h.adapter);
    let moved = false;
    h.adapter.check = async (a) => {
      const why = await check(a);
      if (!moved) { moved = true; fake.state.questions = asksAgain ? [{ id: "que_2", sessionID: asking, questions: [{ question: "Delete production?", header: "Sure", options }] }] : []; }
      return why;
    };
    assert.deepEqual(await local.execute({ kind: "follow_up", itemId: asking, message: "C#", questionId: "que_1" }, "old-tap"), { ok: false, error: ANSWERED });
    assert.deepEqual(fake.writes(), [], asksAgain ? "never the answer to the question asked since" : "never sent as a message");
  }
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
  t.after(() => removeDir(root));
  const path = join(config, "plugins", "10and2.js"), shipped = readFileSync(pluginSource(), "utf8");
  assert.equal(shipped.split(/\r?\n/)[0], MARKER);
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
  assert.equal(parseProc(3, "opencode ../other -m mock/mock-model", "/w/p")!.directory, "/w/other", "ps's paths are POSIX's, whatever this system is");
  assert.equal(parseProc(4, "opencode serve --port 4096", "/")!.kind, "serve");
  assert.equal(parseProc(5, "opencode run hello", "/")!.kind, "run");
  assert.equal(parseProc(6, "opencode attach http://127.0.0.1:4096", "/")!.kind, "other");
  assert.equal(parseProc(7, "node /usr/lib/node_modules/opencode-ai/bin/opencode --port=5000", "/p")!.port, 5000);
  assert.equal(parseProc(8, "vim opencode.json", "/"), null);
  // Windows' own paths.
  assert.deepEqual(parseProc(9, "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\OpenCode.exe --port 4097", "C:\\p"), { pid: 9, kind: "tui", port: 4097, host: "127.0.0.1", directory: "C:\\p" });
  assert.equal(parseProc(10, "opencode.exe ..\\other", "C:\\w\\p")!.directory, "C:\\w\\other");
  assert.equal(parseProc(11, "C:\\Program-Files\\nodejs\\node.exe C:\\npm\\opencode serve", "C:\\")!.kind, "serve");
});

test("on Windows: OpenCode's stored folders read back as Windows writes them, and folders match whatever their case or slashes", () => {
  assert.equal(fromStorage("C:/Users/Me/proj", "win32"), "C:\\Users\\Me\\proj");
  assert.equal(fromStorage("//server/share/proj", "win32"), "\\\\server\\share\\proj");
  assert.equal(fromStorage("C:\\Users\\Me\\proj", "win32"), "C:\\Users\\Me\\proj", "an older row, already Windows'");
  assert.equal(fromStorage("/", "win32"), "/", "the global project");
  assert.equal(fromStorage("C:/Users/Me/proj", "linux"), "C:/Users/Me/proj", "elsewhere it's as stored");
  assert.equal(sameFolder("C:\\Users\\Me\\Proj", "c:/users/me/proj/", "win32"), true);
  assert.equal(sameFolder("C:\\Users\\Me\\Proj", "C:\\Users\\Me\\Other", "win32"), false);
  assert.equal(sameFolder("/home/me/Proj", "/home/me/proj", "linux"), false, "Linux's folders keep their case");
  assert.equal(sameFolder(null, "C:\\p", "win32"), false);
});

test("on Windows: permission rules match as OpenCode's do there, without case and either slash, and a drive-wide allow is full access", () => {
  assert.equal(wildcard("C:\\Users\\Me\\proj\\a.ts", "c:/users/me/*", "win32"), true);
  assert.equal(wildcard("C:\\Users\\Me\\proj\\a.ts", "c:/users/me/*", "linux"), false, "Linux's case counts");
  assert.equal(wildcard("src\\a.ts", "src/*", "linux"), true, "\\ is / to OpenCode everywhere");
  assert.equal(evaluate([{ permission: "edit", pattern: "SRC/*", action: "allow" }], "edit", "src\\a.ts", "win32"), "allow");
  const build = AGENTS()[0]!.permission as Rule[];
  for (const pattern of ["C:/*", "C:\\*", "c:/*"]) {
    const rules: Rule[] = [...build, { permission: "external_directory", pattern, action: "allow" }];
    assert.equal(reach(rules, "win32"), "full-access", `${pattern} on Windows`);
    assert.equal(reach(rules, "linux"), "auto", `${pattern} isn't a folder elsewhere`);
  }
  assert.equal(reach(build, "win32"), "auto", "build still asks outside the project");
});

test("on Windows the plugin serves OpenCode on 127.0.0.1 behind a token (elsewhere on a private socket), and announces it", async (t) => {
  // A short name: on macOS the temporary folder alone is ~49 characters, and a socket's path must fit in 104 bytes there.
  const root = mkdtempSync(join(tmpdir(), "oc-live-")), dir = join(root, "proj");
  const bun = fakeBun(await freePort());
  // Under `bun test` the plugin serves with Bun's own serve, as it does in OpenCode: Bun can't be replaced there, and
  // the fake's Node http is made with that serve. Each server it makes is stopped with the test.
  const g = globalThis as any, serve: ((o: object) => { stop(force?: boolean): void }) | undefined = g.Bun?.serve, served: { stop(force?: boolean): void }[] = [];
  t.after(async () => { for (const s of served) s.stop(true); await bun.close(); removeDir(root); });
  const seen: Request[] = [];
  const client = { _client: { getConfig: () => ({ baseUrl: "http://opencode.internal", fetch: async (req: Request) => { seen.push(req); return Response.json({ ses_1: { type: "busy" } }); } }) } };
  /** The plugin as OpenCode loads it on `platform` (which this process pretends to be while it loads), started in `dir`. */
  async function load(platform: NodeJS.Platform, live: string, mark?: string) {
    const env = { TENANDTWO_OPENCODE_DIR: process.env.TENANDTWO_OPENCODE_DIR, TENANDTWO_OPENCODE_SERVE: process.env.TENANDTWO_OPENCODE_SERVE };
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    process.env.TENANDTWO_OPENCODE_DIR = live;
    if (mark) process.env.TENANDTWO_OPENCODE_SERVE = mark; else delete process.env.TENANDTWO_OPENCODE_SERVE;
    try {
      Object.defineProperty(process, "platform", { ...real, value: platform });
      if (serve) g.Bun.serve = (o: object) => { const s = serve.call(g.Bun, o); served.push(s); return s; }; else g.Bun = bun.Bun;
      // The shipped file's source, a fresh module for each platform: Bun keeps one module per file, whatever its URL's
      // query, and its first import of a file under a /tmp as full as Lattice's took 0.4 s (it reads the folder).
      const source = `${readFileSync(pluginSource(), "utf8")}\n// ${platform}\n`;
      const { TenAndTwo } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
      assert.notDeepEqual(await TenAndTwo({ client, directory: dir, worktree: dir, project: { id: "prj_1" } }), {}, "it started");
    } finally {
      Object.defineProperty(process, "platform", real);
      if (serve) g.Bun.serve = serve; else delete g.Bun;
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return JSON.parse(readFileSync(join(live, `${process.pid}-0.json`), "utf8"));
  }

  const win = await load("win32", join(root, "live-win"), "m1");
  assert.equal(win.socket, undefined);
  assert.match(win.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(win.auth, /^Bearer [0-9a-f]{64}$/);
  assert.equal(win.driverServe, "m1", "Driver's own server says so");
  const [ep] = pluginEndpoints(join(root, "live-win"));
  assert.deepEqual([ep!.url, ep!.auth, ep!.directory, ep!.driverServe], [win.url, win.auth, dir, "m1"]);
  const r = await call(ep!, "GET", "/session/status");
  assert.deepEqual([r.status, r.body], [200, { ses_1: { type: "busy" } }]);
  assert.equal(seen[0]!.headers.get("authorization"), null, "the token stops at the plugin");
  assert.equal(seen[0]!.headers.get("x-opencode-directory"), encodeURIComponent(dir));
  for (const auth of [undefined, `Bearer ${"0".repeat(64)}`, win.auth + "0"]) {
    assert.equal((await call({ ...ep!, auth }, "GET", "/session/status")).status, 401, `refused with ${auth}`);
  }
  assert.equal(seen.length, 1, "nothing refused reached OpenCode");
  assert.deepEqual(pluginEndpoints(join(root, "live-win"), "win32").length, 1);

  if (WINDOWS) return; // Node can't serve a unix socket there.
  const unix = await load(process.platform, join(root, "live"));
  assert.equal(unix.socket, join(root, "live", `${process.pid}-0.sock`));
  assert.equal(unix.url, undefined); assert.equal(unix.auth, undefined); assert.equal(unix.driverServe, undefined);
  assertPrivate(unix.socket);
  const [sock] = pluginEndpoints(join(root, "live"));
  assert.equal((await call(sock!, "GET", "/session/status")).status, 200);
  assert.deepEqual(pluginEndpoints(join(root, "live"), "win32"), [], "a socket file is no way in on Windows");
});

test("an announce reached at an address must be 127.0.0.1 with a token", (t) => {
  const live = mkdtempSync(join(tmpdir(), "driver-opencode-announce-"));
  t.after(() => removeDir(live));
  const announce = (n: number, a: object) => writeFileSync(join(live, `${process.pid}-${n}.json`), JSON.stringify({ v: 1, pid: process.pid, kind: "tui", directory: "/p", sessions: {}, ...a }));
  announce(0, { url: "http://127.0.0.1:4100", auth: "Bearer abc" });
  announce(1, { url: "http://example.com:4100", auth: "Bearer abc" });
  announce(2, { url: "http://127.0.0.1:4100" });
  announce(3, { url: "http://127.0.0.1:4100", auth: "Bearer abc\r\nX-Other: 1" });
  assert.deepEqual(pluginEndpoints(live).map((e) => e.url), ["http://127.0.0.1:4100"]);
});

test("on Windows an announce whose pid is another account's (it refuses the check) is an OpenCode that's gone", (t) => {
  // The system's first process is one, unless these tests run as an administrator or in a sandbox whose first is theirs.
  const foreign = [1, 4].find((pid) => { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } });
  if (foreign === undefined) return t.skip("no process here refuses the check");
  const live = mkdtempSync(join(tmpdir(), "driver-opencode-foreign-"));
  t.after(() => removeDir(live));
  writeFileSync(join(live, `${foreign}-0.json`), JSON.stringify({ v: 1, pid: foreign, kind: "tui", url: "http://127.0.0.1:4100", auth: "Bearer abc", directory: "/p", sessions: {} }));
  assert.deepEqual(pluginEndpoints(live, "win32"), []);
  assert.equal(alive(foreign, "win32"), false);
  assert.equal(pluginEndpoints(live, "linux").length, 1, "elsewhere it's still running");
});

test("on Windows 10 & 2's own server is known by its password, and stopped with what it started (taskkill /T)", async (t) => {
  const h = harness(t);
  const ran: string[][] = [], logs: string[] = [];
  const opts = { command: nodeCommand(FAKE_OPENCODE), stateDir: join(h.root, "serve-win"), log: (m: string) => logs.push(m), permission: null, platform: "win32" as const,
    run: async (command: string, args: string[]) => { ran.push([command, ...args]); try { process.kill(Number(args[1])); } catch { /* gone */ } return true; } };
  const first = new Serve(opts);
  const ep = await first.ensure();
  const kept = JSON.parse(readFileSync(join(opts.stateDir, "serve.json"), "utf8"));
  assert.equal(h.serve.log().find((l) => l.start).mark, kept.mark, "started with the mark its plugin announces");
  // A connector that restarted picks it up: it answers with its password.
  const again = new Serve(opts);
  assert.equal(again.pid, kept.pid);
  assert.deepEqual(await again.ensure(), ep);
  assert.equal(h.serve.log().filter((l) => l.start).length, 1, "the same server");
  // A record whose server doesn't know its password (a pid now someone else's) is forgotten, and nothing is ended.
  writeFileSync(join(opts.stateDir, "serve.json"), JSON.stringify({ ...kept, password: "not-its-password" }));
  await new Serve(opts).stop();
  assert.deepEqual(ran, []);
  assert.ok(alive(kept.pid));
  assert.equal(existsSync(join(opts.stateDir, "serve.json")), false);
  assert.ok(logs.some((l) => l.includes(`process ${kept.pid}`)), "the process left running is named in the log");
  // Its own is ended as a tree.
  await again.stop();
  assert.deepEqual(ran, [["taskkill", "/pid", String(kept.pid), "/T", "/F"]]);
  await until(() => !alive(kept.pid));
});

test("on Windows 10 & 2's own server from an earlier run that's slow to answer is asked again before it's let go, except at shutdown", async (t) => {
  // A stand-in for that server: busy for every other health check, answering the next.
  let asked = 0;
  const server = createHttpServer((req, res) => { if (asked++ % 2) res.end(JSON.stringify({ healthy: true })); });
  const port = await new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as { port: number }).port)));
  const stateDir = mkdtempSync(join(tmpdir(), "driver-opencode-slow-"));
  t.after(() => { server.closeAllConnections(); server.close(); removeDir(stateDir); });
  // Its record names this test's own process, which stands in for the server's: what's run to end it is only watched.
  const record = JSON.stringify({ pid: process.pid, port, password: "p", ceiling: null, startedAt: Date.now(), dirs: [] });
  writeFileSync(join(stateDir, "serve.json"), record);
  const ran: string[][] = [], logs: string[] = [];
  const opts = { command: ["opencode"], stateDir, log: (m: string) => logs.push(m), permission: null, platform: "win32" as const, run: async (command: string, args: string[]) => { ran.push([command, ...args]); return true; } };
  const serve = new Serve(opts);
  assert.equal(serve.pid, process.pid);
  await serve.stop();
  assert.equal(asked, 2);
  assert.deepEqual(ran, [["taskkill", "/pid", String(process.pid), "/T", "/F"]], "it's its own, and is ended");
  // The connector stopping isn't patient: one check, or the supervisor's 5 s grace runs out. It's left running then.
  writeFileSync(join(stateDir, "serve.json"), record);
  const started = Date.now();
  await new Serve(opts).stop(false);
  assert.equal(asked, 3, "asked once");
  assert.ok(Date.now() - started < 4000, "well within the supervisor's grace");
  assert.equal(ran.length, 1, "nothing more is ended");
  assert.ok(logs.some((l) => l.includes(`left process ${process.pid} running`)));
});

test("on Windows a terminal in the same folder, spelled with other case, has the session", { skip: !WINDOWS && "Windows' folders only" }, async (t) => {
  const h = harness(t);
  const id = h.db.finished(h.cwd);
  const fake = await h.tui(h.cwd.toUpperCase());
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute(follow(id, "Same folder"), "k"), { ok: true });
  assert.equal(fake.writes().length, 1);
  assert.equal(h.serve.log().length, 0, "not continued in 10 & 2's own server");
});

// Receipts (docs/launch/spikes/run-receipts.md): the reply's turn's checks, from its bash parts' exits
// (`state.metadata.exit`) and edits, read from OpenCode's database: only the command and the exit, never the output.
test("receipts: a report carries its turn's checks from bash parts' exits; an edit after the last test run makes it stale", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Billing" });
  const u1 = h.db.user(id, "Earlier", { at: Date.now() - 9000 });
  const old = h.db.assistant(id, u1, { finish: "tool-calls", at: Date.now() - 8900 });
  h.db.tool(id, old.id, "bash", { status: "completed", input: { command: "go test ./..." }, output: "", metadata: { exit: 1 } });
  h.db.assistant(id, u1, { text: "Earlier answer", at: Date.now() - 8800 });
  const u2 = h.db.user(id, "Fix the test", { at: Date.now() - 5000 });
  const step = h.db.assistant(id, u2, { finish: "tool-calls", at: Date.now() - 4900 });
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "cd SECRET_DIR && go test ./...", description: "SECRET" }, output: "SECRET_OUTPUT\nFAIL\tSECRET_PKG\t0.01s\n", metadata: { exit: 1, output: "SECRET_OUTPUT\nFAIL\tSECRET_PKG\t0.01s\n" } });
  h.db.tool(id, step.id, "edit", { status: "completed", input: { filePath: "/SECRET_PATH" }, output: "", metadata: {} });
  // Run again where it failed: a run elsewhere isn't at least as broad as the failing one (checks.ts `receipts`).
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "cd SECRET_DIR && go test ./..." }, output: "ok", metadata: { exit: 0 } });
  h.db.tool(id, step.id, "bash", { status: "error", input: { command: "go vet ./..." }, error: "aborted" });
  h.db.tool(id, step.id, "write", { status: "completed", input: { filePath: "/SECRET_PATH2" }, output: "", metadata: {} });
  h.db.assistant(id, u2, { text: "Fixed; tests pass.", at: Date.now() - 4000 });
  await h.adapter.start();
  const report = await h.adapter.report(id);
  assert.equal(report.text, "Fixed; tests pass.");
  assert.deepEqual(report.checks, { tests: { ok: true, runs: 2, failed: 1, label: "go test", stale: true, edited: true } });
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

// The skeptic on 5828b30370cf: OpenCode's bash runs in its `workdir` (from the session's folder) when it's given one. A
// failing run in api, then a passing one in the session's folder, isn't the tests passing.
test("receipts: a bash part's workdir is where it ran; a pass in another folder never covers a failure", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Api" });
  const u = h.db.user(id, "Fix api's test", { at: Date.now() - 5000 });
  const step = h.db.assistant(id, u, { finish: "tool-calls", at: Date.now() - 4900 });
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "go test ./...", workdir: "api" }, output: "FAIL", metadata: { exit: 1 } });
  h.db.tool(id, step.id, "edit", { status: "completed", input: { filePath: "/x" }, output: "", metadata: {} });
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "go test ./..." }, output: "ok", metadata: { exit: 0 } });
  h.db.assistant(id, u, { text: "Fixed.", at: Date.now() - 4000 });
  await h.adapter.start();
  assert.deepEqual((await h.adapter.report(id)).checks, { tests: { ok: false, runs: 1, failed: 1, label: "go test", stale: true } }, "was a pass");
  // The same folder, by its workdir or a cd, is.
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "cd api && go test ./..." }, output: "ok", metadata: { exit: 0 } });
  h.db.assistant(id, u, { text: "Fixed, really.", at: Date.now() - 3000 });
  assert.deepEqual((await h.adapter.report(id)).checks, { tests: { ok: true, runs: 2, failed: 1, label: "go test", edited: true } });
});

// "Call me when the tests pass" mid-run (the skeptic, 16 November): a busy session's turn still going, its checks so far.
test("receipts: a busy session's unfinished turn carries its checks so far as running", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Flaky" });
  const u = h.db.user(id, "Fix the flaky test");
  const step = h.db.assistant(id, u, { finish: "tool-calls" });
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "go test ./..." }, output: "FAIL", metadata: { exit: 1 } });
  h.db.tool(id, step.id, "edit", { status: "completed", input: { filePath: "/x" }, output: "", metadata: {} });
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "go test ./..." }, output: "ok", metadata: { exit: 0 } });
  h.db.assistant(id, u, { completed: false, text: "Checking the other packages" });
  const fake = await h.tui();
  fake.state.status = { [id]: { type: "busy" } };
  await h.adapter.start();
  const report = await h.adapter.report(id);
  assert.equal(report.progress, "Checking the other packages");
  assert.deepEqual(report.running, { tests: { ok: true, runs: 2, failed: 1, label: "go test", edited: true } });
  assert.equal(report.runningId, u, "its run, as its reply will carry it (F6)");
});

// The Skeptic on 3.10: an answer to OpenCode's question is no message at all, so the Ledger drops its record of it
// (`sendLeftOut`); a message to a session is written as the user's, and its record takes it.
test("an answer to OpenCode's question is never a person's message (sendLeftOut); a message is", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Asking" }); h.db.assistant(id, h.db.user(id, "Pick one"), { completed: false });
  const fake = await h.tui();
  fake.state.status = { [id]: { type: "busy" } };
  fake.state.questions = [{ id: "que_9", sessionID: id, questions: [{ question: "Which one?", header: "Pick", options: [{ label: "Alpha", description: "a" }, { label: "Beta", description: "b" }] }] }];
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute(follow(id, "Beta"), "a1"), { ok: true });
  assert.equal(h.adapter.sendLeftOut(follow(id, "Beta"), "a1"), true);
  assert.equal(h.adapter.sendLeftOut(follow(id, "Beta"), "a1"), false, "asked once");
  assert.equal(h.adapter.sendLeftOut(follow(id, "Carry on"), "m1"), false);
});

// The review's finding on 3.10: a database locked as the checks are read said nothing of them, which the brain took for
// "no test ran". It says so (`checksUnread`).
test("receipts: a database that can't be opened as its checks are read says they weren't read, not that none ran", async (t) => {
  const h = harness(t);
  const id = h.db.session({ directory: h.cwd, title: "Billing" });
  const u = h.db.user(id, "Fix the test", { at: Date.now() - 5000 });
  const step = h.db.assistant(id, u, { finish: "tool-calls", at: Date.now() - 4900 });
  h.db.tool(id, step.id, "bash", { status: "completed", input: { command: "go test ./..." }, output: "FAIL", metadata: { exit: 1 } });
  h.db.assistant(id, u, { text: "Fixed; tests pass.", at: Date.now() - 4000 });
  await h.adapter.start();
  assert.deepEqual((await h.adapter.report(id)).checks, { tests: { ok: false, runs: 1, failed: 1, label: "go test" } });
  // The session as last scanned (no scan due), and the checks' own read can't open the database.
  const adapter = h.adapter as any, real = adapter.dbPath;
  adapter.scannedAt = Date.now() + 60_000;
  adapter.dbPath = real + ".unreadable";
  const report = await h.adapter.report(id);
  adapter.dbPath = real;
  assert.equal(report.text, "Fixed; tests pass.");
  assert.equal(report.checks, undefined);
  assert.equal(report.checksUnread, true);
});

test("a finished parent session with a busy or asking child subagent stays running or waiting", async (t) => {
  const h = harness(t);
  const parent = h.db.finished(h.cwd, "Design the game", "Delegated to workers.", { title: "Game design" });
  const sub = h.db.session({ directory: h.cwd, parentId: parent, title: "Balance pass (@general subagent)" });
  const nested = h.db.session({ directory: h.cwd, parentId: sub, title: "Wave simulator" });
  const fake = await h.tui();
  fake.state.status = { [nested]: { type: "busy" } };
  await h.adapter.start();
  const running = (await h.adapter.list()).find((i) => i.id === parent)!;
  assert.equal(running.status, "running");
  const rep = await h.adapter.report(parent);
  assert.equal(rep.text, "Delegated to workers.");
  assert.match(rep.progress ?? "", /Waiting on subagent: Wave simulator/);

  // A child subagent asking a question surfaces as waiting on the parent.
  fake.state.questions = [{ id: "que_sub", sessionID: nested, questions: [{ question: "Hard mode?", header: "Difficulty", options: [{ label: "Yes", description: "y" }, { label: "No", description: "n" }] }] }];
  const waiting = (await h.adapter.list()).find((i) => i.id === parent)!;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.pendingQuestion, true);
  assert.equal(waiting.questionId, "que_sub");
  assert.equal((await h.adapter.report(parent)).question, "Hard mode? Options: Yes / No.");

  // Once the subagent clears, the parent returns to completed.
  fake.state.status = {};
  fake.state.questions = [];
  const done = (await h.adapter.list()).find((i) => i.id === parent)!;
  assert.equal(done.status, "completed");
  assert.equal((await h.adapter.report(parent)).progress, null);
});
