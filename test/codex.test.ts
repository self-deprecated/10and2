// The Codex adapter against a fake app-server daemon (test/fixtures/codex/fake-daemon.ts): listing and filtering,
// live states, reading, steering, follow-ups to open and closed sessions, new work, answering questions, never
// approving commands, unknown outcomes never resent, reconnecting. No real Codex, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { answersFor, CodexAdapter, daemonDisabled, messageIdFor, reachOf, trustedProjects, turnChecks, turnSettings, windowsSandbox } from "../src/codex/adapter.ts";
import type { Policy } from "../src/policy.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { FakeCodex, HANG } from "./fixtures/codex/fake-daemon.ts";
import { NODE, removeDir, SLOW } from "./fixtures/platform.ts";
import { Local } from "../src/local.ts";
import { ANSWERED } from "../src/util.ts";

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

/** Codex's config as a test writes it, on Windows with its sandbox set up, as setup() makes it there. */
const config = (fake: FakeCodex, text: string) =>
  writeFileSync(join(fake.home, "config.toml"), process.platform === "win32" ? `${text}\n[windows]\nsandbox = "unelevated"\n` : text);

// Codex's proxy (the way in on Windows) as the fake daemon's: `node proxy.mjs app-server proxy`.
const PROXY = [NODE, fileURLToPath(new URL("./fixtures/codex/proxy.mjs", import.meta.url))];

async function setup(t: TestContext, opts: { policy?: Partial<Policy>; acceptanceTimeoutMs?: number; before?: (fake: FakeCodex, cwd: string, root: string) => void; start?: boolean; transport?: "socket" | "proxy"; heartbeatMs?: number; autoStart?: boolean; platform?: NodeJS.Platform; now?: () => number; daemonStartMs?: number } = {}) {
  const fake = await FakeCodex.start();
  // As a Windows computer whose Codex has its sandbox set up: without one, Codex won't edit on its own there, and the
  // adapter refuses such work (tested on its own below).
  if (process.platform === "win32") writeFileSync(join(fake.home, "config.toml"), "[windows]\nsandbox = \"unelevated\"\n");
  // Real paths, as parsePolicy makes a policy's folders and visible() compares them: macOS's $TMPDIR is under /var, a
  // link to /private/var, so a policy written with it saw nothing there.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "driver-codex-test-"))), cwd = project(root);
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "auto",
    claude: false, t3: false, codex: true, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD", ...opts.policy };
  opts.before?.(fake, cwd, root);
  const logs: string[] = [];
  const adapter = new CodexAdapter({ policy, codexHome: fake.home, db: join(root, "codex.db"), stateDir: join(root, "state"), log: (m) => logs.push(m),
    autoStart: opts.autoStart ?? false, acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? 1000 * SLOW, refreshMs: 60_000, codexCommand: PROXY, transport: opts.transport, heartbeatMs: opts.heartbeatMs, platform: opts.platform,
    now: opts.now, daemonStartMs: opts.daemonStartMs });
  t.after(async () => { await adapter.close(); await fake.stop().catch(() => {}); removeDir(root); removeDir(fake.home); });
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

test("through Codex's proxy (how Windows reaches it), threads are read and a follow-up reaches them", async (t) => {
  let own = "";
  const { adapter, fake } = await setup(t, { transport: "proxy", before: (fake, cwd) => { own = fake.thread(cwd, { prompt: "Add a lap counter", reply: "Added it.", status: { type: "idle" } }).id; } });
  assert.deepEqual((await adapter.list()).map((i) => i.id), [own]);
  const r = await adapter.execute(follow(own, "And a reset button."), "k-proxy");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fake.count("turn/start"), 1);
});

test("through Codex's proxy, which keeps its end open, a daemon that goes away is noticed and reconnected to", async (t) => {
  const { adapter, fake, logs } = await setup(t, { transport: "proxy", heartbeatMs: 100, before: (fake, cwd) => { fake.thread(cwd, { status: { type: "idle" } }); } });
  assert.equal(adapter.connected(), true);
  await fake.stop();
  await until(() => logs.some((l) => l.startsWith("codex: connection lost")));
  await fake.listen();
  await until(() => adapter.connected(), 5000);
});

test("through Codex's proxy, a running daemon is reached when Node can't stat its socket's file (as on Windows)", async (t) => {
  let own = "";
  const { adapter, fake } = await setup(t, { transport: "proxy", start: false, autoStart: true, before: (fake, cwd) => { own = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  t.after(fake.statRefused());
  await adapter.start();
  assert.equal(adapter.connected(), true);
  assert.deepEqual((await adapter.list()).map((i) => i.id), [own]);
  assert.equal(existsSync(join(fake.home, "daemon-starts")), false, "a daemon that runs isn't started");
});

test("Codex's first start of its daemon, which installs it and can take minutes, is waited for and not started again", async (t) => {
  let clock = Date.now();
  const { adapter, fake, logs } = await setup(t, { transport: "proxy", start: false, autoStart: true, now: () => clock });
  await fake.stop();
  const installing = join(fake.home, "daemon-installing"), starts = join(fake.home, "daemon-starts");
  writeFileSync(installing, "");
  const started = adapter.start();
  await until(() => existsSync(starts), 5000 * SLOW);
  // Longer than 10 & 2 once gave it (30 s), and than its once-a-minute limit: it's still installing, not ended.
  clock += 90_000;
  await pause(300);
  const pid = Number(readFileSync(starts, "utf8").trim());
  assert.doesNotThrow(() => process.kill(pid, 0));
  rmSync(installing);
  // It says Codex runs, which can't be reached yet: no second start, a minute counts from when the first ended.
  await started;
  assert.deepEqual(readFileSync(starts, "utf8").trim().split("\n"), [String(pid)]);
  assert.ok(logs.some((l) => l.startsWith("codex: starting Codex's daemon")), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("its daemon isn't running")), logs.join("\n"));
  await fake.listen();
  await until(() => adapter.connected(), 5000 * SLOW);
});

test("a start of Codex's daemon still going past its limit is ended, with what it started", async (t) => {
  const { adapter, fake, logs } = await setup(t, { transport: "proxy", start: false, autoStart: true, daemonStartMs: 1000 * SLOW });
  await fake.stop();
  writeFileSync(join(fake.home, "daemon-installing"), "");
  await adapter.start();
  assert.ok(logs.includes("codex: couldn't start Codex's daemon (it took too long)"), logs.join("\n"));
  const pid = Number(readFileSync(join(fake.home, "daemon-starts"), "utf8").trim());
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
});

test("through Codex's proxy, a socket file nothing listens on (Windows, after a restart) is a daemon to start", async (t) => {
  const { adapter, fake } = await setup(t, { transport: "proxy", start: false, autoStart: true });
  await fake.stop();
  // What Codex leaves on Windows: the socket's file, with no daemon behind it.
  writeFileSync(fake.socketPath, process.platform === "win32" ? "\\\\.\\pipe\\10and2-test-nobody-listens" : "");
  void adapter.start();
  await until(() => existsSync(join(fake.home, "daemon-starts")), 5000);
});

test("through Codex's proxy, one that never answers the connection is given up on, and stopped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-silent-"));
  const silent = join(dir, "silent.mjs"), pidFile = join(dir, "pid");
  // Starts, then reads its input and never answers.
  writeFileSync(silent, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume();`);
  mkdirSync(join(dir, "home", "app-server-control"), { recursive: true });
  writeFileSync(join(dir, "home", "app-server-control", "app-server-control.sock"), "");
  const logs: string[] = [];
  const policy: Policy = { brain: "wss://brain.invalid/connector", projects: [dir], actions: [], maxRuntimeMode: "auto", claude: false, t3: false, codex: true, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" };
  const adapter = new CodexAdapter({ policy, codexHome: join(dir, "home"), db: join(dir, "codex.db"), log: (m) => logs.push(m), autoStart: false,
    transport: "proxy", codexCommand: [NODE, silent], connectTimeoutMs: 300 });
  // Closed before its folder goes: Windows can't delete the database while it's open.
  t.after(async () => { await adapter.close(); removeDir(dir); });
  await adapter.start();
  assert.equal(adapter.connected(), false);
  // Given up on (through the proxy, any failure before the connection is up is a daemon to start), not left waiting.
  assert.ok(logs.some((l) => l.startsWith("codex: can't reach Codex")), logs.join("\n"));
  const pid = Number(readFileSync(pidFile, "utf8"));
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000);
});

test("through Codex's proxy, a daemon that isn't there is a daemon to start, not a broken connection", async (t) => {
  const { adapter, fake, logs } = await setup(t, { transport: "proxy", start: false });
  await fake.stop();
  await adapter.start();
  assert.ok(logs.some((l) => l.includes("its daemon isn't running")), logs.join("\n"));
  assert.equal(adapter.connected(), false);
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

test("a thread's start is Codex's createdAt (seconds), and its first ask is read from its oldest turn", async (t) => {
  let id = "", empty = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    const first = fake.turnOf("  Improve the screenshot stuff.\n", "Done.", 1_800_000_000 - 100);
    first.items.unshift({ type: "hookPrompt", id: "hook-1" });
    id = fake.thread(cwd, { status: { type: "idle" }, createdAt: 1_800_000_000 - 200, turns: [first, ...Array.from({ length: 12 }, (_, n) => fake.turnOf(`Ask ${n}`, `Answer ${n}`, 1_800_000_000 + n))] }).id;
    empty = fake.thread(cwd, { reply: null, prompt: "" }).id;
  } });
  const items = new Map((await adapter.list()).map((i) => [i.id, i]));
  assert.equal(items.get(id)?.createdAt, new Date((1_800_000_000 - 200) * 1000).toISOString());
  assert.deepEqual(await adapter.firstAsk(id), { text: "Improve the screenshot stuff.", at: new Date((1_800_000_000 - 100) * 1000).toISOString(), complete: true });
  assert.equal(fake.last("thread/turns/list").sortDirection, "asc");
  assert.equal(await adapter.firstAsk(empty), null, "a thread with no turn yet has no ask");
  await assert.rejects(adapter.firstAsk("not-a-thread"), /isn't visible/);
});

test("a first message with no time of its own (older Codex) is still the first: at the thread's start, else not complete", async (t) => {
  const untimed = (fake: FakeCodex, words: string) => {
    const turn = fake.turnOf(words, "Done.", 1_800_000_000 - 100);
    turn.startedAt = null; turn.completedAt = null; delete turn.items[0]!.startedAtMs;
    return turn;
  };
  let started = "", unknown = "";
  const { adapter } = await setup(t, { before: (fake, cwd) => {
    started = fake.thread(cwd, { status: { type: "idle" }, createdAt: 1_800_000_000 - 200, turns: [untimed(fake, "Improve the screenshot stuff."), fake.turnOf("Now the tests.", "Tested.", 1_800_000_000)] }).id;
    unknown = fake.thread(cwd, { status: { type: "idle" }, createdAt: 0, updatedAt: 1_800_000_000, turns: [untimed(fake, "Fix the build."), fake.turnOf("And the docs.", "Fixed.", 1_800_000_000)] }).id;
  } });
  assert.deepEqual(await adapter.firstAsk(started), { text: "Improve the screenshot stuff.", at: new Date((1_800_000_000 - 200) * 1000).toISOString(), complete: true });
  assert.deepEqual(await adapter.firstAsk(unknown), { text: "Fix the build.", at: new Date(1_800_000_000 * 1000).toISOString(), complete: false }, "the latest the thread was worked on, or earlier");
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
  const refusal = "It's open in Codex, and this computer doesn't let 10 & 2 send to open sessions.";
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
  assert.equal(a.ok, false); if (!a.ok) { assert.equal(a.unknown, undefined); assert.match(a.error, /open in a Codex window 10 & 2 can't reach/); }
  const b = await adapter.execute(follow(provider, "Hi"), "p");
  assert.equal(b.ok, false); if (!b.ok) { assert.equal(b.unknown, undefined); assert.match(b.error, /different AI provider/); assert.doesNotMatch(b.error, /mock|other/); }
  assert.equal(fake.count("turn/start"), 0);
});

test("new work starts in the project's checkout with the profile's settings, gets its id back and its name", async (t) => {
  const { fake, adapter, cwd, root } = await setup(t, { policy: { projects: "*" }, before: (fake, cwd, root) => {
    fake.thread(cwd);
    const trusted = project(root, "trusted-one");
    config(fake, `model = "m"\n\n[projects."${trusted}"]\ntrust_level = "trusted"\n\n[projects."${join(root, "missing")}"]\ntrust_level = "trusted"\n`);
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
  assert.match(cwd, /[/\\]\.codex[/\\]worktrees[/\\]10and2-[0-9a-f]{12}$/);
  assert.ok(cwd.startsWith(project));
  assert.ok(existsSync(join(cwd, "README")), "the worktree has the project's files");
  assert.equal(execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" }), "", "the worktree stays out of the project's status");
  await until(async () => (await adapter.list()).length === 2);
  assert.equal(adapter.places().length, 1, "the worktree isn't offered as a project of its own");
});

// Through the proxy too (Windows' way in, and its only one), whose slower round trips once let a replayed question lose
// its answer.
for (const transport of process.platform === "win32" ? ["proxy"] as const : ["socket", "proxy"] as const) test(`Codex's question is answered with the option the user named, or their own words (${transport})`, async (t) => {
  let id = "";
  const { fake, adapter, logs } = await setup(t, { transport, before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  fake.begin(id, "Ask me");
  fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
  await until(async () => !!(await adapter.report(id)).question?.startsWith("Which one?"));
  assert.equal(await adapter.check(follow(id, "Beta, please")), null);
  const first = await adapter.execute(follow(id, "Beta, please"), "answer-1");
  assert.deepEqual(first, { ok: true }, JSON.stringify({ answers: fake.answers, calls: fake.calls.map((c) => c.method), logs }));
  assert.deepEqual(fake.answers, [{ method: QUESTION, result: { answers: { pick: { answers: ["Beta"] } } } }]);
  await until(async () => !(await adapter.list())[0]!.pendingQuestion);
  fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
  await until(async () => !!(await adapter.report(id)).question);
  assert.deepEqual(await adapter.execute(follow(id, "Neither, show both"), "answer-2"), { ok: true });
  assert.deepEqual(fake.answers[1]!.result, { answers: { pick: { answers: ["Neither, show both"] } } });
  assert.equal(fake.count("turn/start") + fake.count("turn/steer"), 0, "an answer is never sent as a message");
});

test("a tap answers only the question it was for: one asked instead, or none, while Local's check awaited sends nothing", async (t) => {
  for (const asksAgain of [true, false]) {
    let id = "";
    const { fake, adapter, policy } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
    fake.begin(id, "Ask me");
    const first = fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
    await until(async () => (await adapter.report(id)).choices?.length === 2);
    const questionId = (await adapter.list())[0]!.questionId!;
    const local = new Local([{ prefix: "", adapter }], policy);
    // After Local looked, while the adapter's check yields: it's answered in the terminal, and Codex asks another, or works on.
    const check = adapter.check.bind(adapter);
    let moved = false;
    adapter.check = async (a) => {
      const why = await check(a);
      if (moved) return why;
      moved = true;
      fake.resolve(first);
      if (asksAgain) fake.ask(id, QUESTION, { questions: [{ ...QUESTIONS[0], question: "Delete production?" }], isBlocking: true });
      await until(async () => { const now = (await adapter.list())[0]!; return asksAgain ? now.pendingQuestion && now.questionId !== questionId : !now.pendingQuestion; });
      return why;
    };
    assert.deepEqual(await local.execute({ kind: "follow_up", itemId: id, message: "Beta", questionId }, "old-tap"), { ok: false, error: ANSWERED });
    assert.deepEqual(fake.answers, [], "never the answer to the question asked since");
    assert.equal(fake.count("turn/start") + fake.count("turn/steer"), 0, "never sent as a message");
  }
});

test("Codex's question is input, its own options its choices; a command waiting for approval is an approval, with none", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  fake.begin(id, "Ask me");
  fake.ask(id, QUESTION, { questions: QUESTIONS, isBlocking: true });
  await until(async () => !!(await adapter.report(id)).question?.startsWith("Which one?"));
  assert.equal((await adapter.list())[0]!.questionKind, "input");
  assert.deepEqual((await adapter.report(id)).choices, ["Alpha", "Beta"]);
  assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: id, message: "Beta", questionId: (await adapter.list())[0]!.questionId! }, "tap"), { ok: true });
  assert.deepEqual(fake.answers, [{ method: QUESTION, result: { answers: { pick: { answers: ["Beta"] } } } }]);
  await until(async () => !(await adapter.list())[0]!.pendingQuestion);
  assert.equal("questionKind" in (await adapter.list())[0]!, false, "asks nothing");
  fake.ask(id, QUESTION, { questions: [...QUESTIONS, { ...QUESTIONS[0], id: "why", question: "Why?" }], isBlocking: true });
  await until(async () => (await adapter.report(id)).question?.includes("Why?") === true);
  assert.equal((await adapter.report(id)).choices, null, "two questions at once: one tap can't answer both");
  fake.finish(id, "Done.");
  await until(async () => (await adapter.list())[0]!.status === "completed");
  fake.begin(id, "Clean up");
  fake.ask(id, "item/commandExecution/requestApproval", { kind: "command", command: "rm -rf build", reason: "Remove old output?", startedAtMs: Date.now() });
  await until(async () => (await adapter.report(id)).question?.startsWith("Codex wants to run rm -rf build") === true);
  assert.equal((await adapter.list())[0]!.questionKind, "approval");
  assert.equal((await adapter.report(id)).choices, null);
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
  assert.match((await off.adapter.check(follow(id, "Beta")))!, /doesn't let 10 & 2 answer them/);
});

test("commands are never approved: a follow-up to a session waiting for an OK says what it wants to run", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" } }).id; } });
  fake.begin(id, "Clean up");
  fake.ask(id, "item/commandExecution/requestApproval", { kind: "command", command: "rm -rf build", reason: "Remove old output?", startedAtMs: Date.now() });
  await until(async () => (await adapter.report(id)).question === "Codex wants to run rm -rf build. Remove old output?");
  const why = await adapter.check(follow(id, "Yes, go ahead"));
  assert.equal(why, "Codex is waiting for your OK: it wants to run rm -rf build. 10 & 2 can't approve that, so answer it in Codex.");
  assert.deepEqual(await adapter.execute(follow(id, "Yes, go ahead"), "approve"), { ok: false, error: why });
  await pause(50);
  assert.equal(fake.answers.length, 0, "never answered");
  assert.equal(fake.count("turn/start") + fake.count("turn/steer"), 0);
});

test("an outcome 10 & 2 can't confirm is unknown, and never sent again", async (t) => {
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
  const adapter = new CodexAdapter({ policy: { brain: "wss://x.invalid/c", projects: "*", actions: ["follow_up"], maxRuntimeMode: "auto", claude: false, t3: false, codex: true, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" },
    codexHome: join(root, "codex"), db: join(root, "codex.db"), log: () => {}, autoStart: false });
  // Its store is closed first: Windows won't remove a folder with a file open in it.
  t.after(async () => { await adapter.close(); removeDir(root); });
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
  // A Windows folder (C:\Users\…) is written as a literal string, or a basic one with its backslashes escaped.
  assert.deepEqual(trustedProjects(`[projects.'${dir}']\ntrust_level = "trusted"\n`), [dir]);
  assert.deepEqual(trustedProjects(`[projects."${dir.replaceAll("\\", "\\\\")}"]\ntrust_level = 'trusted'\n`), [dir]);
  removeDir(dir);
  assert.equal(windowsSandbox("[windows]\nsandbox = \"elevated\"\n"), true);
  assert.equal(windowsSandbox("windows.sandbox = 'unelevated'\n"), true);
  assert.equal(windowsSandbox("[profiles.work.windows]\nsandbox = \"unelevated\"\n"), true, "Codex writes it to the profile in use");
  assert.equal(windowsSandbox("[features]\nexperimental_windows_sandbox = true\n"), true, "Codex's older switch");
  assert.equal(windowsSandbox("[features]\nexperimental_windows_sandbox = false\n# sandbox = \"elevated\"\nsandbox_mode = \"workspace-write\"\n"), false);
  assert.equal(windowsSandbox(""), false);
  assert.equal(daemonDisabled("[features]\ndaemon_auto_start = false\n"), true);
  assert.equal(daemonDisabled("features.daemon_auto_start = false\n"), true);
  assert.equal(daemonDisabled("[tui]\ndaemon_auto_start = false\n"), false);
  assert.equal(daemonDisabled(""), false);
  assert.match(messageIdFor("k"), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(messageIdFor("k"), messageIdFor("k"));
  assert.notEqual(messageIdFor("k"), messageIdFor("l"));
});

test("new work can start on a model Codex lists: on thread/start, which a plan follows; one it doesn't list isn't sent", async (t) => {
  const { fake, adapter, cwd } = await setup(t, { before: (fake, cwd) => { fake.thread(cwd); fake.modelPage = 1; } });
  // Every page of `model/list`, less the hidden one.
  await until(() => adapter.places()[0]!.models!.length > 0);
  assert.deepEqual(adapter.places()[0]!.models, [{ id: "astra-6", name: "Astra-6" }, { id: "astra-6-mini", name: "Astra-6 Mini" }]);
  assert.equal(fake.count("model/list"), 3);
  const place = adapter.places()[0]!.id;
  const normal: LaunchProfile = { name: "Normal", workspace: "root", runtimeMode: "auto", interactionMode: "default" };
  assert.equal((await adapter.execute({ kind: "start_work", placeId: place, message: "Build it", profile: normal, model: "astra-6-mini" }, "model-1")).ok, true);
  assert.deepEqual(fake.last("thread/start"), { cwd, approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review", threadSource: "10and2", model: "astra-6-mini" });
  const plan: LaunchProfile = { name: "Plan", workspace: "root", runtimeMode: "approval-required", interactionMode: "plan" };
  assert.equal((await adapter.execute({ kind: "start_work", placeId: place, message: "Plan it", profile: plan, model: "astra-6-mini" }, "model-plan")).ok, true);
  assert.equal(fake.last("turn/start").collaborationMode.settings.model, "astra-6-mini");
  for (const model of ["astra-5-codex", "nope"]) {
    assert.deepEqual(await adapter.execute({ kind: "start_work", placeId: place, message: "x", profile: normal, model }, `no-${model}`), { ok: false, error: "Codex doesn't offer that model now." }, model);
  }
  assert.equal(fake.count("thread/start"), 2);
  // Read again: the same list says nothing; a new model tells the brain.
  const seen: string[][] = [];
  adapter.watch((ids) => seen.push(ids));
  await (adapter as any).readModels();
  assert.deepEqual(seen, []);
  fake.models.push({ id: "astra-7", model: "astra-7", displayName: "Astra-7", hidden: false, isDefault: false });
  await (adapter as any).readModels();
  assert.deepEqual(seen, [[]]);
  assert.equal(adapter.places()[0]!.models!.at(-1)!.id, "astra-7");
});

test("a Codex that doesn't list its models offers none, and a start on one is refused before anything is sent", async (t) => {
  const { fake, adapter, logs } = await setup(t, { before: (fake, cwd) => { fake.thread(cwd); fake.handlers["model/list"] = () => { throw Object.assign(new Error("unknown method model/list"), { code: -32601 }); }; } });
  await until(() => logs.some((l) => /couldn't read Codex's models/.test(l)));
  assert.deepEqual(adapter.places()[0]!.models, []);
  const normal: LaunchProfile = { name: "Normal", workspace: "root", runtimeMode: "auto", interactionMode: "default" };
  assert.deepEqual(await adapter.execute({ kind: "start_work", placeId: adapter.places()[0]!.id, message: "x", profile: normal, model: "astra-6" }, "none"), { ok: false, error: "Codex doesn't offer that model now." });
  assert.equal(fake.count("thread/start"), 0);
});

test("on Windows, work that would edit on its own waits for Codex's Windows sandbox: refused in words, with nothing sent", async (t) => {
  const NO_SANDBOX = "Codex can't edit on its own here until its Windows sandbox is set up. Set it up in Codex, then try again.";
  let edits = "", full = "", readOnly = "";
  const { fake, adapter } = await setup(t, { platform: "win32", policy: { maxRuntimeMode: "full-access" }, before: (fake, cwd) => {
    writeFileSync(join(fake.home, "config.toml"), ""); // no sandbox set up, even where setup() made one (Windows)
    edits = fake.thread(cwd, { status: { type: "idle" } }).id; // on-request in its workspace
    full = fake.thread(cwd, { settings: { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, approvalsReviewer: "user" } }).id;
    readOnly = fake.thread(cwd, { settings: { approvalPolicy: "untrusted", sandbox: { type: "readOnly", networkAccess: false }, approvalsReviewer: "user" } }).id;
  } });
  const place = adapter.places()[0]!.id;
  const auto: LaunchProfile = { name: "Normal", workspace: "root", runtimeMode: "auto", interactionMode: "default" };
  const start = (profile: LaunchProfile, key: string) => adapter.execute({ kind: "start_work", placeId: place, message: "Build it", profile }, key);
  assert.equal(await adapter.check({ kind: "start_work", placeId: place, message: "Build it", profile: auto }), NO_SANDBOX);
  assert.deepEqual(await start(auto, "auto"), { ok: false, error: NO_SANDBOX });
  assert.deepEqual(await start({ ...auto, runtimeMode: "auto-accept-edits" }, "edits"), { ok: false, error: NO_SANDBOX });
  assert.deepEqual(await adapter.execute(follow(edits, "Next step"), "follow-edits"), { ok: false, error: NO_SANDBOX });
  assert.equal(fake.count("thread/start") + fake.count("turn/start"), 0, "nothing was sent");
  // Full access has no sandbox, and read-only work asks before editing wherever it runs.
  assert.equal((await start({ ...auto, runtimeMode: "full-access" }, "full")).ok, true);
  assert.deepEqual(await adapter.execute(follow(full, "Carry on"), "follow-full"), { ok: true });
  assert.deepEqual(await adapter.execute(follow(readOnly, "Carry on"), "follow-read-only"), { ok: true });
  // Once it's set up in Codex, the same work goes.
  writeFileSync(join(fake.home, "config.toml"), "[windows]\nsandbox = \"unelevated\"\n");
  assert.equal(await adapter.check({ kind: "start_work", placeId: place, message: "Build it", profile: auto }), null);
  assert.deepEqual(await adapter.execute(follow(edits, "Next step"), "follow-edits-again"), { ok: true });

  // Under an auto ceiling, a full-access session is capped to work that edits on its own: refused too.
  let capped = "";
  const narrow = await setup(t, { platform: "win32", before: (fake, cwd) => {
    writeFileSync(join(fake.home, "config.toml"), ""); // no sandbox set up
    capped = fake.thread(cwd, { settings: { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" }, approvalsReviewer: "user" } }).id;
  } });
  assert.deepEqual(await narrow.adapter.execute(follow(capped, "Carry on"), "capped"), { ok: false, error: NO_SANDBOX });
  assert.equal(narrow.fake.count("turn/start"), 0);
});

test("on Windows, a folder Codex trusts in lower case and a session's folder are one place, named as the session spells it", async (t) => {
  // Lower case to its end on Linux, so the folder Codex's lower-cased key names can be made there too.
  const home = join(realpathSync(tmpdir()), `driver-codex-case-${randomUUID()}`);
  t.after(() => removeDir(home));
  const spelled = project(home, "Lap-Timer"), trusted = spelled.toLowerCase();
  mkdirSync(join(trusted, ".git"), { recursive: true }); // the same folder on Windows and macOS
  const places = async (platform: NodeJS.Platform) => {
    const { adapter } = await setup(t, { platform, policy: { projects: "*" }, before: (fake) => {
      fake.thread(spelled, { status: { type: "idle" } });
      config(fake, `[projects.'${trusted}']\ntrust_level = "trusted"\n`);
    } });
    return adapter.places();
  };
  const windows = await places("win32");
  assert.deepEqual(windows.map((p) => p.name), ["Lap-Timer"]);
  assert.ok(windows[0]!.activeAt, "the session's work counts for the place");
  assert.equal((await places("linux")).length, 2, "elsewhere, folders differ by case");
});

test("what a person typed (the engine's stage 3.9): a prompt typed in Codex is, at this computer; 10 & 2's own steer isn't, by its message id, even after a restart", async (t) => {
  let id = "";
  const { fake, adapter, root, policy } = await setup(t, { before: (fake, cwd) => { id = fake.thread(cwd, { status: { type: "idle" }, prompt: "Add a lap counter", reply: "Added it." }).id; } });
  await until(async () => adapter.personWrites(id).length === 1);
  const first = adapter.personWrites(id)[0]!;
  assert.equal(first.desk, true);
  fake.begin(id, "Slow work");
  await until(async () => adapter.personWrites(id).length === 2);
  assert.deepEqual(await adapter.execute(follow(id, "Also add tests"), "steer-1"), { ok: true });
  fake.finish(id, "Done.");
  await until(async () => (await adapter.list())[0]!.status === "completed");
  assert.equal(adapter.personWrites(id).length, 2, "10 & 2's steer isn't a person's");
  // A new adapter on the same store (the connector restarted) still knows its own sends.
  const again = new CodexAdapter({ policy, codexHome: fake.home, db: join(root, "codex.db"), stateDir: join(root, "state2"), log: () => {}, autoStart: false, acceptanceTimeoutMs: 1000 * SLOW, refreshMs: 60_000, codexCommand: PROXY });
  t.after(() => again.close());
  await again.start();
  await until(async () => again.personWrites(id).length === 2);
  assert.deepEqual(again.personWrites(id).map((w) => w.at), adapter.personWrites(id).map((w) => w.at));
  // Closed before setup's cleanup removes its folder: Windows won't remove the store it has open.
  await again.close();
});

test("what a person typed, on a Codex that doesn't date its messages (0.157.0): the one that started a turn by the turn's start; one sent into a running turn not at all", async (t) => {
  let id = "";
  const at = Math.floor(Date.now() / 1000) - 600;
  const { adapter } = await setup(t, { before: (fake, cwd) => {
    const turn = fake.turnOf("Add a lap counter", "Added it.", at);
    delete turn.items[0]!.startedAtMs;
    turn.items.splice(1, 0, { type: "userMessage", id: "steered", clientId: "someone-else", content: [{ type: "text", text: "And tests.", text_elements: [] }] });
    id = fake.thread(cwd, { status: { type: "idle" }, turns: [turn] }).id;
  } });
  await until(async () => (await adapter.list()).some((i) => i.id === id));
  assert.deepEqual(adapter.personWrites(id).map((w) => w.at), [new Date(at * 1000).toISOString()]);
});

// Fable on 3.9 and 3.10: Codex 0.167.0 dates a message queued with Tab while a turn runs when it takes it, as that turn
// ends, so a last instruction queued as you leave and taken 30 minutes in would read as typed then and end Away.
test("what a person typed: a message whose turn starts as the turn before it ends was queued while it ran, and isn't counted; one typed seconds later is", async (t) => {
  let id = "";
  const at = Math.floor(Date.now() / 1000) - 3600;
  const { adapter } = await setup(t, { before: (fake, cwd) => {
    const busy = fake.turnOf("Slow work", "Done.", at);
    busy.completedAt = at + 1800;
    const queued = fake.turnOf("Then add tests", "Added them.", at + 1800);
    queued.items[0]!.startedAtMs = (at + 1800) * 1000 + 400;
    queued.completedAt = at + 1900;
    const typed = fake.turnOf("Now the docs", "Done.", at + 1905);
    id = fake.thread(cwd, { status: { type: "idle" }, turns: [busy, queued, typed] }).id;
  } });
  await until(async () => (await adapter.list()).some((i) => i.id === id));
  assert.deepEqual(adapter.personWrites(id).map((w) => w.at), [new Date(at * 1000).toISOString(), new Date((at + 1905) * 1000).toISOString()]);
});

// Receipts (docs/launch/spikes/run-receipts.md): the summary view the adapter keeps has only a turn's messages, so a
// report reads the reply's turn in full for its commands' exit codes.
test("receipts: a report carries the reply's turn's checks, read in full: a test run that exited 1 after one that passed", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    const turn = fake.turnOf("Fix the flaky test", "All fixed, tests pass!", 1_800_000_000);
    turn.items.splice(1, 0,
      { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'cd SECRET_DIR && npm test'", status: "completed", exitCode: 0, aggregatedOutput: "SECRET_OUTPUT" },
      { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/SECRET_PATH", kind: "update" }] },
      { type: "commandExecution", id: "c2", command: "/bin/zsh -lc 'npm test'", status: "failed", exitCode: 1, aggregatedOutput: "SECRET_FAILURE" },
      { type: "commandExecution", id: "c3", command: "/bin/zsh -lc 'npm test'", status: "declined", exitCode: null });
    id = fake.thread(cwd, { status: { type: "idle" }, turns: [turn] }).id;
  } });
  const r = await adapter.report(id);
  assert.equal(r.text, "All fixed, tests pass!");
  assert.deepEqual(r.checks, { tests: { ok: false, runs: 2, failed: 1, label: "npm test", edited: true } });
  assert.equal(fake.last("thread/turns/list").itemsView, "full");
  assert.doesNotMatch(JSON.stringify(r), /SECRET_|zsh/);
});

// The skeptic on 5828b30370cf (cx.ts): each commandExecution says where it ran (`cwd`). A failing run in api, then a
// passing one in the root, isn't the tests passing; the same folder, however the line got there, is.
test("receipts: a test run in another folder (commandExecution.cwd) never covers a failure; the same folder does", () => {
  const run = (id: string, command: string, cwd: string, exitCode: number) => ({ type: "commandExecution", id, command: `/bin/zsh -lc '${command}'`, cwd, status: exitCode ? "failed" : "completed", exitCode, aggregatedOutput: exitCode ? "ℹ tests 1\nℹ fail 1" : "x" });
  const edit = { type: "fileChange", id: "f1", status: "completed", changes: [] };
  assert.deepEqual(turnChecks([run("c1", "npm test", "/w/mono/api", 1), edit, run("c2", "npm test", "/w/mono", 0)]), { tests: { ok: false, runs: 1, failed: 1, label: "npm test", stale: true } }, "was a pass");
  assert.deepEqual(turnChecks([run("c1", "cd api && npm test", "/w/mono", 1), edit, run("c2", "npm test", "/w/mono/api", 0)]), { tests: { ok: true, runs: 2, failed: 1, label: "npm test", edited: true } });
});

// One rule for a pass (engine.md): a turn's checks start where the thread's turns before it left them (`Tested`, kept in
// the adapter's store), so a pass in the root in one turn never settles a failure in api in the turn before it.
test("receipts: a turn's checks start where the thread's turns before it left them", async (t) => {
  const run = (id: string, command: string, cwd: string, exitCode: number) => ({ type: "commandExecution", id, command: `/bin/zsh -lc '${command}'`, cwd, status: exitCode ? "failed" : "completed", exitCode, aggregatedOutput: exitCode ? "ℹ tests 1\nℹ fail 1" : "x" });
  const edit = { type: "fileChange", id: "f1", status: "completed", changes: [] };
  const ids: Record<string, string> = {};
  const { adapter } = await setup(t, { before: (fake, cwd) => {
    for (const [name, line] of [["root", "npm test"], ["api", "cd api && npm test"]]) {
      const done = fake.turnOf("Fix api", "Still failing.", 1_800_000_000);
      done.items.splice(1, 0, run("c1", "cd api && npm test", cwd, 1));
      const going = fake.turnOf("Keep going", null, 1_800_000_100, "inProgress");
      going.items.push(edit, run("c2", line, cwd, 0));
      ids[name] = fake.thread(cwd, { status: { type: "active", activeFlags: [] }, turns: [done, going] }).id;
    }
  } });
  const root = await adapter.report(ids.root);
  assert.deepEqual(root.checks, { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } });
  assert.equal(root.running, undefined, "the root's pass leaves api's failure standing, so it isn't counted");
  assert.deepEqual((await adapter.report(ids.api)).running, { tests: { ok: true, runs: 1, failed: 0, label: "npm test", edited: true } }, "api's whole run again");
});

// "Call me when the tests pass" mid-run (the skeptic, 16 November): the turn still going's checks so far, from the same
// read of the newest turns in full.
test("receipts: a report on a turn still going carries its checks so far as running", async (t) => {
  let id = "";
  const { adapter } = await setup(t, { before: (fake, cwd) => {
    const done = fake.turnOf("Fix the flaky test", "It still fails; looking at the clock mock.", 1_800_000_000);
    const going = fake.turnOf("Keep going", null, 1_800_000_100, "inProgress");
    going.items.push(
      { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test'", status: "failed", exitCode: 1, aggregatedOutput: "x" },
      { type: "commandExecution", id: "c2", command: "/bin/zsh -lc 'npm test'", status: "completed", exitCode: 0, aggregatedOutput: "x" },
      { type: "commandExecution", id: "c3", command: "/bin/zsh -lc 'npm run lint'", status: "inProgress", exitCode: null });
    id = fake.thread(cwd, { status: { type: "active", activeFlags: [] }, turns: [done, going] }).id;
  } });
  const r = await adapter.report(id);
  assert.equal(r.text, "It still fails; looking at the clock mock.");
  assert.equal(r.checks, undefined);
  assert.deepEqual(r.running, { tests: { ok: true, runs: 2, failed: 1, label: "npm test" } });
});

// Fable, 16 November: a follow-up steered into a turn already going. The turn's run, for receipts, starts at the user's
// latest words in it, as a typed message does in Claude Code: what it ran before them isn't the pass asked for, and
// `runningSince` says when that was, so the brain takes the turn for the follow-up's (not one it's queued behind).
test("receipts: a turn still going with a message steered into it reports its checks from that message, and when it came", async (t) => {
  let id = "";
  const began = 1_800_000_100, steered = 1_800_000_400;
  const { adapter } = await setup(t, { before: (fake, cwd) => {
    const going = fake.turnOf("Refactor the billing module", null, began, "inProgress");
    going.items.push(
      { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/x", kind: "update" }] },
      { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test'", status: "completed", exitCode: 0, aggregatedOutput: "x" },
      { type: "userMessage", id: "u2", clientId: "steer", content: [{ type: "text", text: "Also fix the flaky test", text_elements: [] }], startedAtMs: steered * 1000 },
      { type: "commandExecution", id: "c2", command: "/bin/zsh -lc 'npm test'", status: "completed", exitCode: 0, aggregatedOutput: "x" });
    id = fake.thread(cwd, { status: { type: "active", activeFlags: [] }, turns: [going] }).id;
  } });
  const r = await adapter.report(id);
  assert.equal(r.runningSince, new Date(steered * 1000).toISOString());
  assert.deepEqual(r.running, { tests: { ok: true, runs: 1, failed: 0, label: "npm test" } }, "the pass after the change but before the steer isn't counted, and no change since");
});

// Sol on 45ec9eccdf6f (F1): steering a turn started its checks again from the steer with nothing of what the turn ran
// before it, so a failure in api before the steer was forgotten and a pass in the root after it rang "tests pass". What
// the turn ran before the steer is where its checks start (every failing or stale folder kept); only `edited` and the
// pass's counts start at the steer. After a restart, the same.
test("receipts: a message steered into a turn keeps every failure the turn ran before it, after a restart too", async (t) => {
  const began = Math.floor(Date.now() / 1000) - 100;
  const run = (id: string, dir: string, exitCode: number, command = "npm test") => ({ type: "commandExecution", id, command: `/bin/zsh -lc '${command}'`, cwd: dir, status: exitCode ? "failed" : "completed", exitCode, aggregatedOutput: exitCode ? "ℹ tests 1\nℹ fail 1" : "ℹ tests 1\nℹ fail 0" });
  let id = "", going: any;
  const { fake, adapter, cwd, root, policy } = await setup(t, { before: (fake, cwd) => {
    going = fake.turnOf("Fix api", null, began, "inProgress");
    going.items.push(run("c1", join(cwd, "api"), 1));
    id = fake.thread(cwd, { status: { type: "active", activeFlags: [] }, turns: [going] }).id;
  } });
  assert.deepEqual((await adapter.report(id)).running, { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } });
  // Steered: a change, and the root's whole run passing. api's failure still stands.
  going.items.push({ type: "userMessage", id: "u2", clientId: "human", content: [{ type: "text", text: "Fix the root too", text_elements: [] }], startedAtMs: (began + 30) * 1000 },
    { type: "fileChange", id: "f1", status: "completed", changes: [] }, run("c2", cwd, 0));
  const steered = await adapter.report(id);
  assert.equal(steered.running, undefined, "was { ok: true, edited: true }: the root's pass leaves api's failure standing");
  assert.deepEqual(turnChecks(going.items), { tests: { ok: false, runs: 1, failed: 1, label: "npm test", stale: true } }, "as the whole turn says");
  // A restart, on the same store: the same.
  await adapter.close();
  const again = new CodexAdapter({ policy, codexHome: fake.home, db: join(root, "codex.db"), stateDir: join(root, "state"), log: () => {}, autoStart: false, refreshMs: 60_000, codexCommand: PROXY });
  t.after(() => again.close());
  await again.start();
  assert.equal((await again.report(id)).running, undefined, "after a restart");
  // api's own whole run again, after the steer: now every folder passes, after a change in this run.
  going.items.push(run("c3", join(cwd, "api"), 0));
  const passed = await again.report(id);
  assert.deepEqual(passed.running, { tests: { ok: true, runs: 1, failed: 0, label: "npm test", edited: true } }, "counted from the steer");
  assert.equal(passed.runningSince, new Date((began + 30) * 1000).toISOString());
  assert.equal(passed.runningId, going.id, "its turn, as its reply will carry it (F6)");
  // Closed before setup's cleanup removes its folder: Windows won't remove the store it has open.
  await again.close();
});

// The review's finding on 3.10: a report whose turns couldn't be read in full said nothing of its checks, which the brain
// took for "no test ran". It says so (`checksUnread`), and only while the read fails.
test("receipts: when the reply's turn can't be read in full, the report says its checks weren't read, not that none ran", async (t) => {
  let id = "", failing = true;
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    const turn = fake.turnOf("Fix the flaky test", "All fixed, tests pass!", 1_800_000_000);
    turn.items.splice(1, 0, { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test'", status: "failed", exitCode: 1, aggregatedOutput: "x" });
    id = fake.thread(cwd, { status: { type: "idle" }, turns: [turn] }).id;
  } });
  const handle = (fake as any).handle.bind(fake);
  fake.handlers["thread/turns/list"] = (p) => {
    if (failing && p.itemsView === "full") throw Object.assign(new Error("internal error"), { code: -32603 });
    return handle(undefined, "thread/turns/list", p);
  };
  const r = await adapter.report(id);
  assert.equal(r.text, "All fixed, tests pass!");
  assert.equal(r.checks, undefined);
  assert.equal(r.checksUnread, true);
  failing = false;
  const again = await adapter.report(id);
  assert.deepEqual(again.checks, { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } });
  assert.equal(again.checksUnread, undefined);
});

// The review's finding on 3.10: every report read the newest turns in full (each command's output with them), however
// often the brain asked. A finished turn's checks are kept once read; only a turn still going is read in full again.
test("receipts: a finished turn's checks are read in full once, then kept; a turn still going is read in full each time", async (t) => {
  let id = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    const turn = fake.turnOf("Fix the flaky test", "All fixed, tests pass!", 1_800_000_000);
    turn.items.splice(1, 0, { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test'", status: "failed", exitCode: 1, aggregatedOutput: "x" });
    id = fake.thread(cwd, { status: { type: "idle" }, turns: [turn] }).id;
  } });
  const full = () => fake.calls.filter((c) => c.method === "thread/turns/list" && c.params?.itemsView === "full").length;
  const checks = { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } };
  assert.deepEqual((await adapter.report(id)).checks, checks);
  assert.deepEqual((await adapter.report(id)).checks, checks);
  assert.deepEqual((await adapter.report(id)).checks, checks);
  assert.equal(full(), 1, "read in full once");
  fake.begin(id, "Keep going");
  await until(async () => (await adapter.list())[0]!.status === "running");
  const before = full();
  assert.deepEqual((await adapter.report(id)).checks, checks, "the finished turn's, kept");
  await adapter.report(id);
  assert.equal(full() - before, 2, "the turn still going, read in full each time");
});

test("an idle parent thread with an active subagent stays running with subagent progress, then completes when the subagent finishes", async (t) => {
  let parent = "", sub1 = "", sub2 = "";
  const { fake, adapter } = await setup(t, { before: (fake, cwd) => {
    parent = fake.thread(cwd, { name: "Turret design", reply: "Started the workers.", status: { type: "idle" } }).id;
    sub1 = fake.thread(cwd, { name: "Balance pass", parentThreadId: parent, status: { type: "active" } }).id;
    sub2 = fake.thread(cwd, { name: "Map generator", source: { subAgent: { thread_spawn: { parent_thread_id: parent } } }, status: { type: "idle" } }).id;
  } });
  const list1 = await adapter.list();
  assert.deepEqual(list1.map((i) => [i.id, i.status]), [[parent, "running"]]);
  const rep1 = await adapter.report(parent);
  assert.equal(rep1.text, "Started the workers.");
  assert.match(rep1.progress ?? "", /Waiting on subagent: Balance pass/);

  const changes: string[][] = [];
  adapter.watch((ids) => changes.push(ids));
  // First subagent finishes while the second becomes active: parent stays running.
  fake.threads.get(sub2)!.status = { type: "active" };
  fake.notify("thread/status/changed", { threadId: sub2, status: { type: "active" } });
  fake.threads.get(sub1)!.status = { type: "idle" };
  fake.notify("thread/status/changed", { threadId: sub1, status: { type: "idle" } });
  await until(async () => /Map generator/.test((await adapter.report(parent)).progress ?? ""));
  assert.equal((await adapter.list()).find((i) => i.id === parent)!.status, "running");

  // Second subagent finishes: parent flips back to completed.
  fake.threads.get(sub2)!.status = { type: "idle" };
  fake.notify("thread/status/changed", { threadId: sub2, status: { type: "idle" } });
  await until(async () => (await adapter.list()).find((i) => i.id === parent)!.status === "completed");
  assert.equal((await adapter.report(parent)).progress, null);
  assert.ok(changes.some((ids) => ids.includes(parent)));
});
