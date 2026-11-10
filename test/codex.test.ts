// The Codex adapter against a fake app-server daemon (test/fixtures/codex/fake-daemon.ts): listing and filtering,
// live states, reading, steering, follow-ups to open and closed sessions, new work, answering questions, never
// approving commands, unknown outcomes never resent, reconnecting. No real Codex, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { answersFor, CodexAdapter, daemonDisabled, messageIdFor, reachOf, trustedProjects, turnSettings } from "../src/codex/adapter.ts";
import type { Policy } from "../src/policy.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { FakeCodex, HANG } from "./fixtures/codex/fake-daemon.ts";

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(test: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await pause(10); }
  throw new Error("Expected condition did not arrive");
}
const QUESTION = "item/tool/requestUserInput";
const QUESTIONS = [{ id: "pick", header: "Pick", question: "Which one?", isOther: true, isSecret: false, options: [{ label: "Alpha", description: "the first" }, { label: "Beta", description: "the second" }] }];

function project(root: string, name = "lap-timer") {
  const dir = join(root, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

async function setup(t: TestContext, opts: { policy?: Partial<Policy>; acceptanceTimeoutMs?: number; before?: (fake: FakeCodex, cwd: string, root: string) => void; start?: boolean } = {}) {
  const fake = await FakeCodex.start();
  const root = mkdtempSync(join(tmpdir(), "driver-codex-test-")), cwd = project(root);
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "auto",
    claude: false, t3: false, codex: true, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", ...opts.policy };
  opts.before?.(fake, cwd, root);
  const logs: string[] = [];
  const adapter = new CodexAdapter({ policy, codexHome: fake.home, db: join(root, "codex.db"), stateDir: join(root, "state"), log: (m) => logs.push(m),
    autoStart: false, acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? 1000, refreshMs: 60_000 });
  t.after(async () => { await adapter.close(); await fake.stop().catch(() => {}); rmSync(root, { recursive: true, force: true }); rmSync(fake.home, { recursive: true, force: true }); });
  if (opts.start !== false) await adapter.start();
  return { fake, adapter, cwd, root, policy, logs };
}
const follow = (itemId: string, message: string): Action => ({ kind: "follow_up", itemId, message });

test("only the user's own threads are listed: not T3 Code's, internal ones or invisible ones, and old ones only while loaded", async (t) => {
  const days = (n: number) => Math.floor(Date.now() / 1000) - n * 86_400;
  let own = "", failed = "", stopped = "", empty = "", oldLoaded = "";
  const { adapter, cwd } = await setup(t, { before: (fake, cwd, root) => {
    own = fake.thread(cwd, { prompt: "Add a lap counter", reply: "Added it." }).id;
    failed = fake.thread(cwd, { turns: [fake.turnOf("Break it", null, days(1), "failed")] }).id;
    stopped = fake.thread(cwd, { turns: [fake.turnOf("Stop it", null, days(1), "interrupted")] }).id;
    empty = fake.thread(cwd, { reply: null, prompt: "" }).id;
    oldLoaded = fake.thread(cwd, { updatedAt: days(20), status: { type: "idle" } }).id;
    fake.thread(cwd, { originator: "T3 Code" });
    fake.thread(cwd, { ephemeral: true, threadSource: "thread_title" });
    fake.thread(cwd, { parentThreadId: own });
    fake.thread(cwd, { updatedAt: days(20) });
    fake.thread(project(root, "elsewhere"));
  } });
  const items = await adapter.list();
  assert.deepEqual(items.map((i) => i.id).sort(), [own, failed, stopped, empty, oldLoaded].sort());
  const item = items.find((i) => i.id === own)!;
  assert.equal(item.title, "Add a lap counter");
  assert.equal(item.group, "lap-timer");
  assert.equal(item.status, "completed");
  assert.ok(item.lastRunAt && item.wroteAt);
  assert.equal(items.find((i) => i.id === failed)!.status, "failed");
  assert.equal(items.find((i) => i.id === stopped)!.status, "cancelled");
  assert.equal(items.find((i) => i.id === empty)!.status, "idle");
  assert.equal(items.find((i) => i.id === empty)!.title, "a Codex session in lap-timer");
  assert.equal((await adapter.list()).find((i) => i.id === oldLoaded)!.status, "completed");
  void cwd;
});

test("T3 Code's worktrees are left out by their folders, whatever the originator says", async (t) => {
  let mine = "";
  const { adapter } = await setup(t, { policy: { projects: "*" }, before: (fake, cwd) => {
    mine = fake.thread(cwd).id;
    fake.thread(join(homedir(), ".t3", "worktrees", "lap-timer", "t3-1234"));
    fake.thread("/srv/code/workspaces/driver/t3-abcd1234");
  } });
  assert.deepEqual((await adapter.list()).map((i) => i.id), [mine]);
});

test("live states come from the daemon's notifications: running, then waiting on a question read out with its options", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  const seen: { ids: string[]; urgent: boolean }[] = [];
  adapter.watch((ids, urgent) => seen.push({ ids, urgent }));
  fake.begin(id, "Slow work");
  await until(async () => (await adapter.list())[0]!.status === "running");
  assert.ok(seen.some((s) => s.ids.includes(id) && !s.urgent));
  fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
  await until(async () => (await adapter.report(id)).question === "Which one? Options: Alpha / Beta.");
  const item = (await adapter.list())[0]!;
  assert.equal(item.status, "waiting");
  assert.equal(item.pendingQuestion, true);
  assert.ok(item.questionId);
  assert.ok(seen.some((s) => s.ids.includes(id) && s.urgent), "a new question is urgent");
  assert.equal(fake.count("thread/resume"), 1, "subscribed once, to have Codex replay the question");
  fake.finish(id, "All done.");
  await until(async () => (await adapter.list())[0]!.status === "completed");
  await until(() => fake.count("thread/unsubscribe") === 1);
});

test("a report is the last finished reply, with progress while a turn runs; replies are every finished turn's", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    const th = fake.thread(cwd, { status: { type: "idle" }, turns: [fake.turnOf("First ask", "First answer", 1_800_000_000 - 100), fake.turnOf("Second ask", "Second answer", 1_800_000_000)] });
    id = th.id;
  } });
  const r = await adapter.report(id);
  assert.equal(r.text, "Second answer");
  assert.equal(r.progress, null);
  assert.equal(r.question, null);
  assert.equal(r.reply?.at, new Date(1_800_000_000 * 1000).toISOString());
  const replies = await adapter.replies(id);
  assert.deepEqual(replies.map((x) => [x.text, x.prompt]), [["Second answer", "Second ask"], ["First answer", "First ask"]]);
  const turn = fake.begin(id, "Third ask");
  turn.items.push({ type: "agentMessage", id: "m-progress", text: "Looking at the tests", phase: "commentary" });
  await until(async () => (await adapter.report(id)).progress === "Looking at the tests");
  assert.equal((await adapter.report(id)).text, "Second answer", "a running turn's notes are progress, not the reply");
});

test("a follow-up to a running session steers its turn, by its id, once", async (t) => {
  let id = "", turnId = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  turnId = fake.begin(id, "Slow work").id;
  await until(async () => (await adapter.list())[0]!.status === "running");
  assert.equal(await adapter.check(follow(id, "Also add tests")), null);
  assert.deepEqual(await adapter.execute(follow(id, "Also add tests"), "steer-1"), { ok: true });
  assert.deepEqual(fake.last("turn/steer"), { threadId: id, input: [{ type: "text", text: "Also add tests", text_elements: [] }], expectedTurnId: turnId, clientUserMessageId: messageIdFor("steer-1") });
  assert.deepEqual(await adapter.execute(follow(id, "Also add tests"), "steer-1"), { ok: true });
  assert.equal(fake.count("turn/steer"), 1, "the same key never sends twice");
  assert.equal(fake.count("turn/start"), 0);
  assert.deepEqual(await adapter.execute(follow(id, "Different words"), "steer-1"), { ok: false, error: "That operation key was already used for different words or settings." });
});

test("a steer that finds the turn just ended starts a turn instead (Codex took nothing the first time)", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  fake.begin(id, "Slow work");
  await until(async () => (await adapter.list())[0]!.status === "running");
  fake.handlers["turn/steer"] = () => { throw Object.assign(new Error("no active turn to steer"), { code: -32600 }); };
  assert.deepEqual(await adapter.execute(follow(id, "Carry on"), "late"), { ok: true });
  assert.equal(fake.count("turn/start"), 1);
});

test("with steering off, open sessions are refused in words and a session nothing has open is still continued", async (t) => {
  let busy = "", open = "", closed = "";
  const { fake, adapter } = await setup(t, { policy: { steer: false }, before: (fake, cwd) => {
    busy = fake.thread(cwd, { status: { type: "idle" } }).id;
    open = fake.thread(cwd, { status: { type: "idle" } }).id;
    closed = fake.thread(cwd).id;
  } });
  fake.begin(busy, "Slow work");
  await until(async () => (await adapter.list()).find((i) => i.id === busy)!.status === "running");
  const refusal = "It's open in Codex, and this computer doesn't let Driver send to open sessions.";
  assert.equal(await adapter.check(follow(busy, "x")), refusal);
  assert.equal(await adapter.check(follow(open, "x")), refusal);
  assert.deepEqual(adapter.refusals()[open], { follow_up: refusal });
  assert.deepEqual(await adapter.execute(follow(open, "x"), "open"), { ok: false, error: refusal });
  assert.equal(fake.count("turn/steer") + fake.count("turn/start"), 0);
  assert.equal(await adapter.check(follow(closed, "Carry on")), null);
  assert.deepEqual(await adapter.execute(follow(closed, "Carry on"), "closed"), { ok: true });
  assert.equal(fake.last("turn/start").threadId, closed);
});

test("a follow-up to an idle session open in Codex starts a turn there, within the ceiling as it is, and lets go after", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  assert.deepEqual(await adapter.execute(follow(id, "Next step"), "idle"), { ok: true });
  const start = fake.last("turn/start");
  assert.equal(start.clientUserMessageId, messageIdFor("idle"));
  assert.equal(start.sandboxPolicy, undefined, "on-request in its workspace is within an auto ceiling: unchanged");
  assert.ok(fake.count("thread/resume") >= 1);
  await until(() => fake.count("thread/unsubscribe") >= 1);
});

test("continuing a session nothing has open loads it and caps what it runs with at this machine's ceiling", async (t) => {
  let id = "", narrow = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    id = fake.thread(cwd, { settings: { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, approvalsReviewer: "user" } }).id;
    narrow = fake.thread(cwd, { settings: { approvalPolicy: "untrusted", sandbox: { type: "readOnly", networkAccess: false }, approvalsReviewer: "user" } }).id;
  } });
  assert.deepEqual(await adapter.execute(follow(id, "Carry on"), "full"), { ok: true });
  const start = fake.last("turn/start");
  assert.deepEqual({ approvalPolicy: start.approvalPolicy, approvalsReviewer: start.approvalsReviewer, sandbox: start.sandboxPolicy.type }, { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspaceWrite" });
  assert.deepEqual(await adapter.execute(follow(narrow, "Carry on"), "narrow"), { ok: true });
  assert.equal(fake.last("turn/start").sandboxPolicy, undefined, "never raised");
  await until(() => fake.count("thread/unsubscribe") >= 2);
});

test("a session another Codex process writes, or one on another provider, is refused in words, not left unknown", async (t) => {
  let writer = "", provider = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    writer = fake.thread(cwd, { refuse: "writer" }).id;
    provider = fake.thread(cwd, { refuse: "provider" }).id;
  } });
  const a = await adapter.execute(follow(writer, "Hi"), "w");
  assert.equal(a.ok, false); if (!a.ok) { assert.equal(a.unknown, undefined); assert.match(a.error, /open in a Codex window Driver can't reach/); }
  const b = await adapter.execute(follow(provider, "Hi"), "p");
  assert.equal(b.ok, false); if (!b.ok) { assert.equal(b.unknown, undefined); assert.match(b.error, /different AI provider/); assert.doesNotMatch(b.error, /mock|other/); }
  assert.equal(fake.count("turn/start"), 0);
});

test("new work starts in the project's checkout with the profile's settings, gets its id back and its name", async (t) => {
  const { fake, adapter, cwd, root } = await setup(t, { policy: { projects: "*" }, before: (fake, cwd, root) => {
    fake.thread(cwd);
    const trusted = project(root, "trusted-one");
    writeFileSync(join(fake.home, "config.toml"), `model = "m"\n\n[projects."${trusted}"]\ntrust_level = "trusted"\n\n[projects."${join(root, "missing")}"]\ntrust_level = "trusted"\n`);
  } });
  const places = adapter.places();
  assert.deepEqual(places.map((p) => p.name).sort(), ["lap-timer", "trusted-one"]);
  const place = places.find((p) => p.name === "lap-timer")!.id;
  const profile: LaunchProfile = { name: "Normal", workspace: "root", runtimeMode: "auto", interactionMode: "default" };
  const receipt = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Build the timer", profile }, "start-1");
  assert.equal(receipt.ok, true);
  const id = (receipt as { itemId: string }).itemId;
  assert.ok(fake.threads.has(id));
  assert.deepEqual(fake.last("thread/start"), { cwd, approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review", threadSource: "10and2" });
  assert.deepEqual(fake.last("turn/start"), { threadId: id, input: [{ type: "text", text: "Build the timer", text_elements: [] }], clientUserMessageId: messageIdFor("start-1") });
  await until(() => fake.threads.get(id)!.name === "Harness start");
  assert.deepEqual(await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Build the timer", profile }, "start-1"), receipt);
  assert.equal(fake.count("thread/start"), 1);
  await until(async () => (await adapter.list()).some((i) => i.id === id));
  void root;
});

test("new work: plan profiles start in plan mode; more than the ceiling is refused in words", async (t) => {
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { fake.thread(cwd); } });
  const place = adapter.places()[0]!.id;
  const plan: LaunchProfile = { name: "Plan", workspace: "root", runtimeMode: "approval-required", interactionMode: "plan" };
  assert.equal((await adapter.execute({ kind: "start_work", placeId: place, message: "Plan it", profile: plan }, "plan")).ok, true);
  assert.deepEqual(fake.last("turn/start").collaborationMode, { mode: "plan", settings: { model: "mock-model", reasoning_effort: null, developer_instructions: null } });
  assert.deepEqual({ a: fake.last("thread/start").approvalPolicy, s: fake.last("thread/start").sandbox }, { a: "untrusted", s: "read-only" });
  const full: LaunchProfile = { name: "Full", workspace: "root", runtimeMode: "full-access", interactionMode: "default" };
  assert.deepEqual(await adapter.execute({ kind: "start_work", placeId: place, message: "x", profile: full }, "full"),
    { ok: false, error: "That launch profile exceeds this machine's permission ceiling." });
  assert.equal(fake.count("thread/start"), 1);
});

test("new work with a worktree profile runs in a fresh worktree inside the project, kept out of its git status", async (t) => {
  let project = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    project = cwd;
    rmSync(join(cwd, ".git"), { recursive: true, force: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main"); writeFileSync(join(cwd, "README"), "hi\n"); git("add", "."); git("commit", "-qm", "first");
    fake.thread(cwd);
  } });
  assert.equal(adapter.places().length, 1);
  const place = adapter.places()[0]!.id;
  const build: LaunchProfile = { name: "Build", workspace: "worktree", runtimeMode: "auto", interactionMode: "default" };
  const r = await adapter.execute({ kind: "start_work", placeId: place, message: "Build it", profile: build }, "wt-1");
  assert.equal(r.ok, true, JSON.stringify(r));
  const cwd: string = fake.last("thread/start").cwd;
  assert.match(cwd, /[/]\.codex[/]worktrees[/]driver-[0-9a-f]{12}$/);
  assert.ok(cwd.startsWith(project));
  assert.ok(existsSync(join(cwd, "README")), "the worktree has the project's files");
  assert.equal(execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" }), "", "the worktree stays out of the project's status");
  await until(async () => (await adapter.list()).length === 2);
  assert.equal(adapter.places().length, 1, "the worktree isn't offered as a project of its own");
});

test("Codex's question is answered with the option the user named, or their own words", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  fake.begin(id, "Ask me");
  fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
  await until(async () => !!(await adapter.report(id)).question?.startsWith("Which one?"));
  assert.equal(await adapter.check(follow(id, "Beta, please")), null);
  assert.deepEqual(await adapter.execute(follow(id, "Beta, please"), "answer-1"), { ok: true });
  assert.deepEqual(fake.answers, [{ method: QUESTION, result: { answers: { pick: { answers: ["Beta"] } } } }]);
  await until(async () => !(await adapter.list())[0]!.pendingQuestion);
  fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
  await until(async () => !!(await adapter.report(id)).question);
  assert.deepEqual(await adapter.execute(follow(id, "Neither, show both"), "answer-2"), { ok: true });
  assert.deepEqual(fake.answers[1]!.result, { answers: { pick: { answers: ["Neither, show both"] } } });
  assert.equal(fake.count("turn/start") + fake.count("turn/steer"), 0, "an answer is never sent as a message");
});

test("a question that takes only its options isn't answered with other words; with answering off, none is", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  fake.begin(id, "Ask me");
  fake.ask(id, QUESTION, { questions: [{ ...QUESTIONS[0], isOther: false }], isBlocking: true });
  await until(async () => !!(await adapter.report(id)).question);
  assert.deepEqual(await adapter.execute(follow(id, "Whatever you like"), "strict"), { ok: false, error: "That question takes one of its options: Alpha / Beta. Nothing was sent." });
  assert.equal(fake.answers.length, 0);

  const off = await setup(t, { policy: { answer: false }, before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  off.fake.begin(id, "Ask me");
  off.fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
  await until(async () => (await off.adapter.list())[0]!.pendingQuestion);
  assert.match((await off.adapter.check(follow(id, "Beta")))!, /doesn't let Driver answer them/);
});

test("commands are never approved: a follow-up to a session waiting for an OK says what it wants to run", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  fake.begin(id, "Clean up");
  fake.ask(id, "item/commandExecution/requestApproval", { kind: "command", command: "rm -rf build", reason: "Remove old output?", startedAtMs: Date.now() });
  await until(async () => (await adapter.report(id)).question === "Codex wants to run rm -rf build. Remove old output?");
  const why = await adapter.check(follow(id, "Yes, go ahead"));
  assert.equal(why, "Codex is waiting for your OK: it wants to run rm -rf build. Driver can't approve that, so answer it in Codex.");
  assert.deepEqual(await adapter.execute(follow(id, "Yes, go ahead"), "approve"), { ok: false, error: why });
  await pause(50);
  assert.equal(fake.answers.length, 0, "never answered");
  assert.equal(fake.count("turn/start") + fake.count("turn/steer"), 0);
});

test("an outcome Driver can't confirm is unknown, and never sent again", async (t) => {
  let id = "", taken = "";
  const { fake, adapter } = await setup(t, { acceptanceTimeoutMs: 300, before: (fake, cwd) => {
    id = fake.thread(cwd, { status: { type: "idle" } }).id;
    taken = fake.thread(cwd, { status: { type: "idle" } }).id;
  } });
  fake.handlers["turn/start"] = () => HANG;
  const lost = await adapter.execute(follow(id, "Hello"), "lost");
  assert.equal(lost.ok, false); if (!lost.ok) assert.equal(lost.unknown, true);
  assert.deepEqual(await adapter.execute(follow(id, "Hello"), "lost"), lost);
  assert.equal(fake.count("turn/start"), 1);
  // Codex took it but its answer was lost: the message's id in the thread confirms it.
  fake.handlers["turn/start"] = (p) => { fake.threads.get(p.threadId)!.turns.push(fake.turnOf("Hello", null)); fake.threads.get(p.threadId)!.turns.at(-1)!.items[0]!.clientId = p.clientUserMessageId; return HANG; };
  assert.deepEqual(await adapter.execute(follow(taken, "Hello"), "taken"), { ok: true });
});

test("reconnects when Codex's daemon restarts, and reads everything again", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd).id; } });
  assert.equal(adapter.connected(), true);
  await fake.stop();
  await until(() => !adapter.connected());
  assert.equal(await adapter.check(follow(id, "x")), "Codex isn't connected right now.");
  await fake.listen();
  await until(() => adapter.connected(), 5000);
  assert.equal(fake.count("initialize"), 2);
  assert.deepEqual((await adapter.list()).map((i) => i.id), [id]);
});

test("with no daemon (and starting one off), it isn't connected and refuses in words", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "driver-codex-none-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = new CodexAdapter({ policy: { brain: "wss://x.invalid/c", projects: "*", actions: ["follow_up"], maxRuntimeMode: "auto", claude: false, t3: false, codex: true, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" },
    codexHome: join(root, "codex"), db: join(root, "codex.db"), log: () => {}, autoStart: false });
  t.after(() => adapter.close());
  await adapter.start();
  assert.equal(adapter.isLoaded, false);
  assert.equal(adapter.connected(), false);
  assert.deepEqual(await adapter.list(), []);
});

test("settle, snooze and archive stay on this computer; archive hides it, a newer run unsettles it", async (t) => {
  let id = "", gone = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; gone = fake.thread(cwd).id; } });
  assert.deepEqual(await adapter.execute({ kind: "settle", itemId: id }, "settle"), { ok: true });
  assert.equal((await adapter.list()).find((i) => i.id === id)!.settled, true);
  assert.deepEqual(await adapter.execute({ kind: "archive", itemId: gone }, "archive"), { ok: true });
  assert.equal((await adapter.list()).some((i) => i.id === gone), false);
  assert.equal(fake.count("thread/archive"), 0, "Codex's own archive is never used");
  await pause(1100); // a run that finishes in a later second than the settle
  fake.begin(id, "More"); fake.finish(id, "Done again");
  await until(async () => (await adapter.list()).find((i) => i.id === id)!.settled === false);
});

test("helpers: runtime modes, reach, answers, trusted projects, daemon switch, message ids", () => {
  assert.deepEqual(turnSettings("approval-required"), { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false } });
  assert.equal(turnSettings("full-access").sandboxPolicy && (turnSettings("full-access").sandboxPolicy as any).type, "dangerFullAccess");
  assert.equal(reachOf("untrusted", { type: "readOnly" }, "user"), "approval-required");
  assert.equal(reachOf("on-request", { type: "workspaceWrite" }, "user"), "auto-accept-edits");
  assert.equal(reachOf("never", { type: "workspaceWrite" }, "user"), "auto-accept-edits");
  assert.equal(reachOf("on-request", { type: "workspaceWrite" }, "auto_review"), "auto");
  assert.equal(reachOf("never", { type: "dangerFullAccess" }, "user"), "full-access");
  assert.equal(reachOf(undefined, { type: "somethingNew" }, "user"), "full-access", "unknown counts as the most");
  assert.deepEqual(answersFor(QUESTIONS, "alpha"), { answers: { pick: { answers: ["Alpha"] } } });
  assert.deepEqual(answersFor(QUESTIONS, "alpha or beta"), { answers: { pick: { answers: ["alpha or beta"] } } }, "two named: their words decide");
  assert.deepEqual(answersFor([{ id: "r", question: "Which?", isOther: false, options: [{ label: "Red (Recommended)" }, { label: "Blue" }] }], "red"), { answers: { r: { answers: ["Red (Recommended)"] } } });
  const dir = mkdtempSync(join(tmpdir(), "codex-trust-"));
  assert.deepEqual(trustedProjects(`[projects."${dir}"]\ntrust_level = "trusted"\n[projects.'/nope/x']\ntrust_level = "trusted"\n[projects."${tmpdir()}"]\ntrust_level = "untrusted"\n`), [dir]);
  rmSync(dir, { recursive: true });
  assert.equal(daemonDisabled("[features]\ndaemon_auto_start = false\n"), true);
  assert.equal(daemonDisabled("features.daemon_auto_start = false\n"), true);
  assert.equal(daemonDisabled("[tui]\ndaemon_auto_start = false\n"), false);
  assert.equal(daemonDisabled(""), false);
  assert.match(messageIdFor("k"), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(messageIdFor("k"), messageIdFor("k"));
  assert.notEqual(messageIdFor("k"), messageIdFor("l"));
});
