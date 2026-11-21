// Gemini CLI, for real, against the fake model (its API at GOOGLE_GEMINI_BASE_URL): a session open in its terminal UI is
// listed and read, and isn't sent to while it's open; once the terminal is closed it's continued through Gemini's ACP
// mode, where a permission it asks for is refused; new work starts in the checkout (YOLO, which runs its tool), in a
// worktree, and on a model Gemini lists. Runs in the harness container only (run.sh).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AcpAdapter } from "../../src/acp/adapter.ts";
import { GeminiSource } from "../../src/gemini/source.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { has, home, inContainer, mockModel, project, sleep, Terminal, until } from "./lib.ts";

const skip = (!inContainer && process.env.TENANDTWO_HARNESS_HERE !== "1") || !has("gemini") ? "runs in the harness container (test/harness/run.sh)" : false;

test("Gemini CLI: list, read, refuse an open session, continue a closed one, refuse its permission, start work", { skip, timeout: 300_000 }, async (t) => {
  // The real path: macOS's temp folder is a link (/var → /private/var), and the agents record where they really ran.
  const mock = await mockModel(t), cwd = realpathSync(project()), root = home("gemini"), gemini = join(root, ".gemini"), state = join(root, "connector");
  mkdirSync(gemini, { recursive: true }); mkdirSync(state, { recursive: true });
  // Signed in with an API key (any key: the fake model takes it), no updates, the project trusted (YOLO needs that).
  writeFileSync(join(gemini, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false }, privacy: { usageStatisticsEnabled: false } }));
  writeFileSync(join(gemini, "trustedFolders.json"), JSON.stringify({ [cwd]: "TRUST_FOLDER" }));
  // The runner the adapter starts (and the Gemini it runs) inherit this; the terminal gets it explicitly.
  const env = { GEMINI_CLI_HOME: root, GEMINI_API_KEY: "mock", GOOGLE_GEMINI_BASE_URL: mock.url };
  Object.assign(process.env, env);

  const adapter = new AcpAdapter({ source: new GeminiSource({ dir: gemini }), db: join(state, "gemini.db"), stateDir: state, log: (m) => t.diagnostic(m),
    entryScript: resolve(import.meta.dirname, "..", "fixtures", "acp", "turn.ts"), acceptanceTimeoutMs: 60_000,
    policy: { brain: "wss://unused.invalid/connector", projects: [cwd], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
      claude: false, t3: false, codex: false, opencode: false, pi: false, gemini: true, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  const tui = new Terminal("gemini");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); });

  let id = "";
  const follow = (key: string, message: string): Promise<any> => adapter.execute({ kind: "follow_up", itemId: id, message } as Action, key);
  const start = (key: string, message: string, profile: Partial<LaunchProfile> = {}, model?: string) => adapter.execute({ kind: "start_work", placeId: adapter.places()[0]!.id,
    title: `Harness ${key}`, message, profile: { name: "Build", runtimeMode: "full-access", workspace: "root", interactionMode: "default", ...profile }, ...(model ? { model } : {}) }, key);

  await t.test("read: a session open in its terminal is listed and read, and isn't sent to while it's open", async () => {
    tui.start("gemini", cwd, env);
    await until("the terminal to be ready", () => /Type your message/.test(tui.screen()), 60_000);
    await tui.type("First words GEMONE");
    await until("its first reply", () => tui.screen().includes("ACK First words GEMONE"), 60_000);
    await adapter.start();
    await until("it to be listed", async () => { const items = await adapter.list(); id = items[0]?.id ?? ""; return items.length === 1 && items[0]!.status === "completed"; });
    assert.equal((await adapter.report(id)).text, "ACK First words GEMONE");
    assert.equal((await adapter.list())[0]!.title, "First words GEMONE");
    assert.match(await adapter.check({ kind: "follow_up", itemId: id, message: "x" }) ?? "", /open in Gemini CLI/);
  });

  await t.test("continue: once the terminal is closed, the session is continued through ACP", async () => {
    tui.stop();
    await until("the session to be closed", async () => (await adapter.check({ kind: "follow_up", itemId: id, message: "x" })) === null, 30_000);
    assert.deepEqual(await follow("closed", "Closed words GEMCLOSED"), { ok: true });
    await until("the model to get it", () => mock.saw("Closed words GEMCLOSED"), 60_000);
    await until("its reply to be read", async () => (await adapter.report(id)).text === "ACK Closed words GEMCLOSED", 60_000);
  });

  await t.test("refused: a tool Gemini asks permission for, in its own default mode, never runs", async () => {
    await until("the last run to end", async () => (await adapter.check({ kind: "follow_up", itemId: id, message: "x" })) === null, 60_000);
    assert.deepEqual(await follow("refuse", "Please TOUCH=refused-by-driver"), { ok: true });
    await until("the turn to end", async () => (await adapter.report(id)).text.startsWith("ACK RESULT"), 60_000);
    assert.ok(!existsSync(join(cwd, "refused-by-driver")), "the tool didn't run");
  });

  await t.test("start: new work in the checkout, in YOLO mode, runs its tool", async () => {
    const started = await start("root", "Root words TOUCH=made-by-yolo");
    assert.equal(started.ok, true, JSON.stringify(started));
    const itemId = started.ok ? started.itemId! : "";
    await until("its tool to run", () => existsSync(join(cwd, "made-by-yolo")), 60_000);
    await until("the new work to be listed and read", async () => (await adapter.list()).some((i) => i.id === itemId && i.title === "Harness root")
      && (await adapter.report(itemId)).text.startsWith("ACK RESULT"), 60_000);
  });

  await t.test("start in a worktree: new work in a fresh worktree inside the project", async () => {
    const started = await start("worktree", "Worktree words GEMTREE", { workspace: "worktree" });
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get it", () => mock.saw("Worktree words GEMTREE"), 60_000);
    assert.ok(readdirSync(join(cwd, ".gemini", "worktrees")).some((d) => d.startsWith("10and2-")), "it ran in a worktree");
    assert.equal(adapter.places().length, 1, "the worktree isn't a project of its own");
  });

  await t.test("model: new work on a model Gemini lists", async () => {
    await until("Gemini's models to be read", () => (adapter.places()[0]?.models ?? []).length > 1, 60_000);
    const models = adapter.places()[0]!.models!;
    const chosen = models.find((m) => m.id !== "auto" && m.id !== models[0]!.id) ?? models[1]!;
    const started = await start("model", "Model words GEMMODEL", {}, chosen.id);
    assert.equal(started.ok, true, JSON.stringify(started));
    await until("the model to get it", () => mock.saw("Model words GEMMODEL"), 60_000);
    await sleep(500);
    assert.ok(mock.requests().some((r) => r.texts.some((x) => x.includes("GEMMODEL")) && r.path.includes(`/models/${chosen.id}:`)), `it ran on ${chosen.id}`);
  });
});
