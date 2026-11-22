// Claude Code, for real, against the fake model: a session open in its terminal UI is listed, read, followed up when
// idle, steered mid-turn, has its question answered through the hook; a closed one is continued; new work starts.
// Runs in the harness container only (run.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ClaudeAdapter } from "../../src/claude/adapter.ts";
import { installHooks } from "../../src/claude/hooks.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { ANSWERED } from "../../src/util.ts";
import { checkFiles, checksByStart, has, home, inContainer, local, mockModel, PASSING, project, same, scheduled, Terminal, typedOf, until } from "./lib.ts";
import { ipcPath } from "../fixtures/platform.ts";

const skip = !inContainer || !has("claude") ? "runs in the harness container (test/harness/run.sh)" : false;
const KEY = "sk-ant-mock-00000000000000000000000000";

test("Claude Code: list, read, steer idle and busy, answer a question, continue a closed session, start work", { skip, timeout: 420_000 }, async (t) => {
  const mock = await mockModel(t), cwd = project(), config = join(home("claude"), ".claude"), state = join(config, "..", "connector");
  mkdirSync(config, { recursive: true }); mkdirSync(state, { recursive: true });
  const hooks = ipcPath(state, "hooks.sock");
  // Claude Code on the fake model with a throwaway key: onboarding, the key and the folder already answered.
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: KEY, HARNESS_HOOK_SOCKET: hooks });
  writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, theme: "dark",
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  // Quoted, with forward slashes: Git Bash, which runs hooks on Windows, reads a backslash as an escape.
  await installHooks(config, `node "${join(import.meta.dirname, "hook.ts").replaceAll("\\", "/")}"`);
  const env = { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: KEY, HARNESS_HOOK_SOCKET: hooks };

  const adapter = new ClaudeAdapter({ configDir: config, db: join(state, "claude.db"), stateDir: state, hookSocketPath: hooks, log: (m) => t.diagnostic(m),
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", claude: true, t3: false, codex: false, opencode: false, pi: false, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  // What the brain is told of who wrote (the engine's stage 3.9): every send below is 10 & 2's, recorded as it goes.
  const typed = typedOf(adapter);
  let typedFrom = 0, typedTo = 0, queuedFrom = 0, queuedTo = 0, queuedTaken = 0;
  let queued: { at: string | null; desk: string | null } | null = null;
  const starts: string[] = [];
  const tui = new Terminal("claude");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); try { execFileSync("claude", ["daemon", "stop", "--any"], { stdio: "ignore", timeout: 15_000 }); } catch { /* none */ } });

  // Each feature is its own subtest, so an older Claude Code can pass some and fail others (src/versions.ts).
  let id = "";
  const sessions = () => readdirSync(join(config, "sessions")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(config, "sessions", f), "utf8")));
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);

  await t.test("read: a session open in its terminal is listed and read", async () => {
    tui.start("claude", cwd, env);
    await until("the terminal to be ready", () => tui.screen().includes("❯"));
    await tui.type("First words TUIONE");
    await until("its first reply", () => tui.screen().includes("ACK First words TUIONE"));
    await adapter.start();
    // Claude Code (2.1.321) registers the terminal under a startup id, then again under its transcript's, which is the
    // session's. On a busy machine the first was taken, and every test after waited on an id nothing lists (2 CPUs,
    // two files at once, 22 November): the session's id is the registry's once its transcript is there.
    // Any entry in the registry, not only the first file read: Claude Code may keep others there.
    await until("its registry entry", () => {
      const transcripts = new Set(readdirSync(join(config, "projects"), { recursive: true, encoding: "utf8" }).map((f) => basename(f)));
      id = sessions().find((s) => s.sessionId && transcripts.has(`${s.sessionId}.jsonl`))?.sessionId ?? "";
      return !!id;
    });
    await until("it to be listed", async () => (await adapter.list()).some((i) => i.id === id));
    // Claude Code shows the reply before it writes it to the session's file, which is what's read: on a busy machine
    // a read straight away found nothing yet (CI, 20 November).
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK First words TUIONE");
  });

  await t.test("follow up: an idle open session gets a new turn in its terminal", async () => {
    assert.equal(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }), null);
    assert.deepEqual(await follow("idle", "Idle words IDLEONE"), { ok: true });
    await until("the terminal to show the message", () => tui.screen().includes("Message from @10-2: Idle words IDLEONE"));
    await until("the model to get it", () => mock.saw("Idle words IDLEONE"));
  });

  await t.test("steer: a busy open session is steered mid-turn", async () => {
    await tui.type("Slow work SLOW8 BUSYONE");
    await until("the slow turn to start", () => mock.saw("SLOW8 BUSYONE"));
    assert.deepEqual(await follow("busy", "Steer words STEERONE"), { ok: true });
    // The user types too while it's busy (the Skeptic on 3.10): Claude Code writes that prompt once it takes it, as
    // "queued". Who wrote it is read for the "typed" subtest below, which says whether it counts.
    queuedFrom = Date.now();
    await tui.type("Queued words QUEUEDONE");
    queuedTo = Date.now();
    await until("the model to get the steer", () => mock.saw("Steer words STEERONE"), 60_000);
    await until("the model to get the prompt typed while busy", () => mock.saw("Queued words QUEUEDONE"), 60_000);
    queuedTaken = Date.now();
    const end = Date.now() + 10_000;
    while (Date.now() < end && !(Date.parse((await typed(id))?.desk ?? "") >= queuedFrom)) await new Promise((r) => setTimeout(r, 200));
    queued = (await typed(id)) ?? null;
  });

  await t.test("answer: Claude's question is held by the hook and answered", async () => {
    await tui.type("Please ASKQ now");
    await until("the question to be held", async () => /Which one\? Options: Alpha \/ Beta/.test((await adapter.report(id)).question ?? ""));
    assert.deepEqual(await follow("answer", "Beta, please"), { ok: true });
    await until("the answer to come back from the model", () => tui.screen().includes("ACK RESULT"), 60_000);
    assert.match(tui.screen(), /Allowed by PermissionRequest hook/);
  });

  await t.test("tap: a held question is input, its own options its choices; a stale questionId sends nothing, and an option's label answers it", async () => {
    await until("the last turn to end", async () => (await adapter.list()).find((i) => i.id === id)?.status !== "running" && tui.screen().includes("ACK RESULT"), 60_000);
    typedFrom = Date.now();
    await tui.type("Please ASKQ again");
    await until("the question to be held", async () => (await adapter.report(id)).choices?.length === 2, 60_000);
    typedTo = Date.now();
    assert.deepEqual((await adapter.report(id)).choices, ["Alpha", "Beta"]);
    // The listing catches up with the hook on its next scan (a quarter of a second later).
    await until("it to be listed as asking", async () => (await adapter.list()).find((i) => i.id === id)?.questionKind === "input");
    const item = (await adapter.list()).find((i) => i.id === id)!;
    assert.equal(item.pendingQuestion, true);
    const tap = (questionId: string): Action => ({ kind: "follow_up", itemId: id, message: "Alpha", questionId });
    assert.deepEqual(await local(adapter).execute(tap("an-earlier-question"), "tap-stale"), { ok: false, error: ANSWERED });
    assert.deepEqual(await local(adapter).execute(tap(item.questionId!), "tap"), { ok: true });
    await until("the tapped option to come back from the model", () => /ACK RESULT.*Alpha/.test(tui.screen()), 60_000);
  });

  await t.test("continue: a closed session is continued under its own id", async () => {
    tui.stop();
    await until("the terminal's registry entry to go", () => !sessions().some((s) => s.sessionId === id && s.kind === "interactive"));
    assert.deepEqual(await follow("closed", "Closed words CLOSEDONE"), { ok: true });
    await until("the model to get it", () => mock.saw("Closed words CLOSEDONE"), 60_000);
  });

  await t.test("start: new work in the checkout", async () => {
    const profile: LaunchProfile = { name: "Normal", runtimeMode: "auto", workspace: "root", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, title: "Harness start", message: "Start words STARTONE", profile }, "start");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get the new work", () => mock.saw("Start words STARTONE"), 60_000);
    if (started.ok && started.itemId) starts.push(started.itemId);
  });

  await t.test("start in a worktree: new work in a fresh worktree", async () => {
    const profile: LaunchProfile = { name: "Build", runtimeMode: "auto", workspace: "worktree", interactionMode: "default" };
    const place = adapter.places()[0]!.id;
    const started = await adapter.execute({ kind: "start_work", placeId: place, message: "Worktree words WTONE", profile }, "start-wt");
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get the worktree's work", () => mock.saw("Worktree words WTONE"), 60_000);
    if (started.ok && started.itemId) starts.push(started.itemId);
  });

  await t.test("typed: what's typed in its terminal is yours, at this computer, while it's busy too; 10 & 2's follow-ups, answers, continuing and new work aren't", async () => {
    // Dated when it was typed (Claude Code's enqueue), not when Claude Code took it at the slow turn's end (the Skeptic on
    // 3.9 and 3.10).
    assert.ok(queuedTaken - queuedTo > 2000, `it waited behind the slow turn (typed by ${queuedTo}, taken by ${queuedTaken})`);
    assert.ok(queued?.desk && Date.parse(queued.desk) >= queuedFrom - 1000 && Date.parse(queued.desk) <= queuedTo + 1000, `the prompt typed while it was busy, typed ${queuedFrom} to ${queuedTo} (${JSON.stringify(queued)})`);
    const mine = await typed(id);
    assert.ok(mine?.desk && Date.parse(mine.desk) >= typedFrom - 2000 && Date.parse(mine.desk) <= typedTo, `the last prompt typed (${JSON.stringify(mine)})`);
    assert.equal(mine.at, mine.desk);
    for (const s of starts) await until(`new work ${s} to be listed`, async () => (await adapter.list()).some((i) => i.id === s), 30_000);
    for (const s of starts) assert.deepEqual(await typed(s), { at: null, desk: null }, "new work 10 & 2 started");
  });

  await t.test("checks: a test run's pass and failure, from its Bash exit, are the run's (mid-run) and the reply's checks", async () => {
    const profile: LaunchProfile = { name: "Full", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };
    await checksByStart(adapter, adapter.places()[0]!.id, profile, cwd);
  });

  await t.test("checks after a follow-up: a typed run that tests, then 10 & 2's follow-up through the inbox, is a run of its own, with its own checks (none) and, mid-run, its own start", async () => {
    // The Skeptic on 3.9 and 3.10: before, the follow-up's run had the previous run's tests and start. A session open in
    // a terminal, which runs the test file without asking (a rule in the project's own settings; in the default mode,
    // since auto mode's classifier would ask the fake model and shows a notice first).
    checkFiles(cwd);
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(node --test:*)", "Bash(npm test)"] } }));
    const before = new Set(sessions().map((s) => s.sessionId));
    const term = new Terminal("claude-checks");
    term.start("claude --permission-mode default", cwd, env);
    await until("its terminal to be ready", () => term.screen().includes("❯"));
    await term.type("Check words RUNCMD[npm test] CHECKSIX");
    await until("its registry entry", () => sessions().some((s) => !before.has(s.sessionId) && s.kind === "interactive"));
    const run = sessions().find((s) => !before.has(s.sessionId) && s.kind === "interactive")!.sessionId;
    await until("it to be listed", async () => (await adapter.list()).some((i) => i.id === run));
    let last: unknown = null;
    const seen = (what: string, test: (r: Awaited<ReturnType<typeof adapter.report>>) => boolean) =>
      until(what, async () => { const r = await adapter.report(run); last = { text: r.text.slice(0, 120), checks: r.checks, running: r.running, runningSince: r.runningSince }; return test(r); }, 90_000)
        .catch((e) => { throw new Error(`${e.message}: its last report ${JSON.stringify(last)}; screen:\n${term.screen()}`); });
    await seen("the typed run's checks", (r) => same(r.checks, PASSING));
    await until("it to be idle", async () => (await adapter.list()).find((i) => i.id === run)?.status !== "running", 60_000);
    const send = (key: string, message: string) => adapter.execute({ kind: "follow_up", itemId: run, message } as Action, key);
    assert.deepEqual(await send("inbox-plain", "Plain words PLAINSIX"), { ok: true });
    await until("the follow-up to reach the model through the inbox", () => mock.requests().some((r) => r.texts.some((x: string) => x.includes("cross-session-message") && x.includes("Plain words PLAINSIX"))), 60_000);
    await seen("the follow-up's reply, with no checks of its own", (r) => /PLAINSIX/.test(r.text) && r.checks === undefined);
    await until("it to be idle again", async () => (await adapter.list()).find((i) => i.id === run)?.status !== "running", 60_000);
    const sentAt = Date.now();
    assert.deepEqual(await send("inbox-checks", "Again words RUNCMD[npm test] SLOW15 AGAINSIX"), { ok: true });
    await seen("the follow-up's run's checks so far, mid-run, since the follow-up", (r) => same(r.running, PASSING) && Date.parse(r.runningSince ?? "") >= sentAt - 1000);
    await seen("the follow-up's reply's checks", (r) => !r.running && same(r.checks, PASSING) && /ACK RESULT/.test(r.text));
    term.stop();
  });
  await t.test("schedule: a message set up for later goes at its time and not before, through the session's inbox, saying it was set up earlier (the engine's stage 4a)", async () => {
    const before = new Set(sessions().map((s) => s.sessionId));
    const term = new Terminal("claude-later");
    term.start("claude", cwd, env);
    await until("its terminal to be ready", () => term.screen().includes("❯"));
    await term.type("Later first words LATERZERO");
    await until("its first reply", () => term.screen().includes("ACK Later first words LATERZERO"), 60_000);
    await until("its registry entry", () => sessions().some((s) => !before.has(s.sessionId) && s.kind === "interactive"));
    const later = sessions().find((s) => !before.has(s.sessionId) && s.kind === "interactive")!.sessionId;
    // Its first run read, as the brain would have it at a yes: the thread as it is then is the schedule's guard.
    await until("its first run to be read", async () => { const i = (await adapter.list()).find((x) => x.id === later); return !!i?.lastRunAt && i.status !== "running"; }, 60_000);
    const held = await scheduled(adapter, later, "Later words LATERONE");
    assert.equal(held.state, "sent", JSON.stringify(held));
    await until("the terminal to show the message", () => term.screen().includes("Message from @10-2: Later words LATERONE"), 60_000);
    await until("the model to get it, saying it was set up earlier", () => mock.requests().some((r) => r.texts.some((x: string) => x.includes("Later words LATERONE") && x.includes("and confirmed it then."))), 60_000);
    term.stop();
  });
});
