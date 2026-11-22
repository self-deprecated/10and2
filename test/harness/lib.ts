// Shared pieces of the harness tests (test/harness/*.harness.ts): real coding-agent CLIs in a container, a deterministic
// fake model (test/fixtures/mock-model.mjs) instead of a real one, tmux for their terminal UIs, scratch git projects.
// They run only inside the harness container (run.sh); `inContainer` says whether this is it.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { Action, Adapter, LaunchProfile } from "../../src/contract.ts";
import { Ledger } from "../../src/ledger.ts";
import { which } from "../../src/command.ts";
import { Local } from "../../src/local.ts";
import { Schedules, type Held } from "../../src/schedules.ts";
import { parsePolicy } from "../../src/policy.ts";
import { digestOf, type Sent, type Write } from "../../src/typed.ts";

export const inContainer = process.env.TENANDTWO_HARNESS === "1";
// The agents' own shells run `node --test` in the "checks" subtests (the engine's stage 3.10); this test runner's marker,
// inherited, would have it report to this file instead of exiting as it does for a person.
delete process.env.NODE_TEST_CONTEXT;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One work system's adapter behind the connector's Local, as the link calls it, so an answer to one question (a tap)
 * goes through its guard: refused once the thread no longer asks that question.
 */
export const local = (adapter: Adapter & { readonly isLoaded?: boolean }) =>
  new Local([{ prefix: "", adapter }], parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] })));

/**
 * What a person typed in each thread (`WorkItem.typed`, the engine's stage 3.9), as the brain is told it: the adapter's
 * own writes, less 10 & 2's sends, recorded as the connector's Ledger records them, as each goes (`adapter.execute` is
 * wrapped, so every follow-up, answer and new work a harness sends is one), and dropped as the Ledger drops them: a
 * refused one, and one the adapter says went a way never among its person's writes (`sendLeftOut`), which then has to stay
 * out of `typed` by itself.
 */
export function typedOf(adapter: Adapter & { personWrites(id: string): Write[]; sendLeftOut?(a: Action, key: string): boolean }) {
  const sends: Sent[] = [];
  // How a send goes (a schedule's, `Local.dispatch`'s third argument) passes through as it is.
  const execute = adapter.execute.bind(adapter) as (a: Action, key: string, ...how: unknown[]) => ReturnType<Adapter["execute"]>;
  adapter.execute = async (a: Action, key: string, ...how: unknown[]) => {
    const sent = a.kind === "follow_up" || a.kind === "start_work" ? { key, item: a.kind === "follow_up" ? a.itemId : null, digest: digestOf(a.message), at: Date.now() } : null;
    if (sent) sends.push(sent);
    const receipt = await execute(a, key, ...how);
    if (sent && ((!receipt.ok && !receipt.unknown) || adapter.sendLeftOut?.(a, key))) sends.splice(sends.indexOf(sent), 1);
    return receipt;
  };
  const view = new Local([{ prefix: "", adapter }], parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] })), () => sends);
  return async (id: string) => (await view.list()).find((i) => i.id === id)?.typed;
}

/**
 * A message set up for later (the engine's stage 4a, src/schedules.ts), as the connector runs it: handed over 5 s before
 * its time with the thread as it is now as its guard, kept in a Ledger's own table, and sent by the runner at its time
 * through the Ledger and `Local` (the link taken as synced: the harness has no brain). Nothing goes before its time;
 * returns the row once it's no longer waiting.
 */
export async function scheduled(adapter: Adapter & { readonly isLoaded?: boolean }, itemId: string, message: string, ms = 90_000): Promise<Held> {
  const dir = mkdtempSync(join(tmpdir(), "schedules-"));
  const ledger = new Ledger(dir);
  const policy = parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] }));
  const via = new Local([{ prefix: "", adapter }], policy);
  const schedules = new Schedules({ ledger, local: via, policy, device: "harness", gate: () => true });
  try {
    const item = (await via.list()).find((i) => i.id === itemId);
    if (!item) throw new Error(`${itemId} isn't listed`);
    const at = Date.now() + 5000;
    const answer = schedules.set(1, [{
      v: 1, id: `R-harness-1:${itemId}`, action: { kind: "follow_up", itemId, message }, when: { at: new Date(at).toISOString() }, until: new Date(at + 7_200_000).toISOString(),
      guard: { agreedAt: new Date().toISOString(), running: item.status === "running", lastRunAt: item.lastRunAt ?? null, questionId: item.pendingQuestion ? item.questionId ?? null : null },
      said: `Send "${message}" in 5 seconds`, zone: "UTC",
    }], Date.now());
    if (!("held" in answer) || answer.held[0]?.state !== "waiting") throw new Error(`not held: ${JSON.stringify(answer)}`);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const before = Date.now();
      await schedules.tick();
      const h = schedules.view()[0]!;
      if (before < at && h.state !== "waiting") throw new Error(`gone before its time: ${JSON.stringify(h)}`);
      if (h.state === "not_sent") {
        const now = (await via.list()).find((i) => i.id === itemId);
        const pick = (i: typeof item | undefined) => i && { status: i.status, lastRunAt: i.lastRunAt, pendingQuestion: i.pendingQuestion, typed: i.typed, wroteAt: i.wroteAt };
        throw new Error(`not sent: ${JSON.stringify(h)}; at the hand-over ${JSON.stringify(pick(item))}, now ${JSON.stringify(pick(now))}`);
      }
      if (h.state !== "waiting" && h.state !== "firing") return h;
      await sleep(250);
    }
    throw new Error(`still held after ${ms} ms: ${JSON.stringify(schedules.view())}`);
  } finally {
    await ledger.close();
  }
}

/** Waits for `test` to hold, checking every 100 ms; throws with `what` after `ms`. */
export async function until(what: string, test: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await test()) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * `until` for what's seen only while a run is going (stage 3.10's checks mid-run), bounded by the run's progress rather
 * than a fixed time: it waits while the run is yet to start or still going (`over` false), up to `cap`, and fails at once
 * once the run is over without it, with what `over` said of it.
 */
export async function whileRunning(what: string, test: () => boolean | Promise<boolean>, over: () => false | string | Promise<false | string>, cap = 300_000): Promise<void> {
  const end = Date.now() + cap;
  while (Date.now() < end) {
    try { if (await test()) return; } catch { /* not yet */ }
    let ended: false | string = false;
    try { ended = await over(); } catch { /* not yet */ }
    if (ended !== false) {
      try { if (await test()) return; } catch { /* over */ }
      throw new Error(`the run was over before ${what} could be read: ${ended}`);
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export type Mock = { url: string; port: number; requests: () => { path: string; model: string | null; texts: string[] }[]; saw: (text: string) => boolean; close: () => void };

/** The fake model, on a free port, logging every request it answers. */
export async function mockModel(t: TestContext): Promise<Mock> {
  const dir = mkdtempSync(join(tmpdir(), "mock-model-")), log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const child: ChildProcess = spawn(process.execPath, [join(import.meta.dirname, "..", "fixtures", "mock-model.mjs"), "0"], { env: { ...process.env, MOCK_MODEL_LOG: log }, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout!.once("data", (b) => resolve(Number(b.toString().trim())));
    child.once("exit", () => reject(new Error("mock model exited")));
  });
  t.after(() => child.kill());
  const requests = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { url: `http://127.0.0.1:${port}`, port, requests, saw: (text) => requests().some((r) => r.texts.some((x: string) => x.includes(text))), close: () => child.kill() };
}

/**
 * Two test files in a scratch project, one passing and one failing, for the "checks" subtests (the engine's stage 3.10):
 * the fake model runs one with the agent's own shell tool (RUNCMD[…]): the passing one as the project's `npm test`, a
 * whole run (only a whole run's pass is told: engine.md, "One rule for a pass"), the failing one with `node --test`.
 */
export function checkFiles(cwd: string) {
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --test pass.test.mjs" } }));
  writeFileSync(join(cwd, "pass.test.mjs"), 'import test from "node:test";\ntest("adds", () => {});\n');
  writeFileSync(join(cwd, "fail.test.mjs"), 'import test from "node:test";\nimport assert from "node:assert";\ntest("subtracts", () => assert.equal(1, 2));\n');
}
/** What a run of each leaves the computer as (`Report.checks`): its kind, result, count and the table's label. */
export const PASSING = { tests: { ok: true, runs: 1, failed: 0, label: "npm test" } };
export const FAILING = { tests: { ok: false, runs: 1, failed: 1, label: "node --test" } };
/** Whether two receipts are the same. */
export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The "checks" subtest for a work system 10 & 2 starts work on with full access (the engine's stage 3.10): new work runs
 * a passing test file with its own shell tool, its reply streamed slowly, so the run still going reports the pass so far
 * (`running`), then the reply's run (`checks`); more new work runs a failing one. Both say their test runs are read.
 */
export async function checksByStart(adapter: Adapter, place: string, profile: LaunchProfile, cwd: string, ms = 90_000) {
  checkFiles(cwd);
  const start = async (message: string, key: string) => {
    const started = await adapter.execute({ kind: "start_work", placeId: place, message, profile }, key);
    if (!started.ok || !started.itemId) throw new Error(`couldn't start: ${JSON.stringify(started)}`);
    return started.itemId;
  };
  const pass = await start("Check words RUNCMD[npm test] SLOW15 CHECKONE", "start-checks-pass");
  // Bounded by the run's progress, not a fixed time: while it's yet to start or going, however slow the machine; once
  // it's over without them, at once, with its last report (stage 4's final review).
  await whileRunning("the run's checks so far, mid-run", async () => same((await adapter.report(pass)).running, PASSING), async () => {
    const r = await adapter.report(pass), i = (await adapter.list()).find((x) => x.id === pass);
    return !r.running && !!r.text && i?.status !== "running" ? JSON.stringify({ status: i?.status, text: r.text.slice(0, 120), checks: r.checks ?? null }) : false;
  });
  await until("the reply's checks, once the run is over", async () => { const r = await adapter.report(pass); return !r.running && same(r.checks, PASSING); }, ms);
  const fail = await start("Check words RUNCMD[node --test fail.test.mjs] CHECKTWO", "start-checks-fail");
  let last: unknown = null;
  await until("the failing run's checks", async () => { const r = await adapter.report(fail); last = { text: r.text.slice(0, 80), checks: r.checks, running: r.running }; return same(r.checks, FAILING); }, ms)
    .catch((e) => { throw new Error(`${e.message}: its last report ${JSON.stringify(last)}`); });
  const items = await local(adapter).list();
  for (const id of [pass, fail]) if (items.find((i) => i.id === id)?.testRuns !== true) throw new Error(`${id} doesn't say its test runs are read`);
}

/** A scratch git project with one commit, under its own temp folder. */
export function project(name = "lap-timer"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "harness-")), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Lap timer\n\nA tiny lap timer.\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main"); git("config", "user.email", "harness@example.invalid"); git("config", "user.name", "Harness");
  git("add", "-A"); git("commit", "-qm", "Start");
  return dir;
}

/** A terminal UI in its own tmux server (one per test file), so nothing outside the test sees it. */
export class Terminal {
  private static socket = `harness-${process.pid}`;
  readonly name: string;
  constructor(name: string) { this.name = name; }
  private tmux(...args: string[]): string { return execFileSync("tmux", ["-L", Terminal.socket, ...args], { encoding: "utf8" }); }
  /** Starts `command` in `cwd` with `env` added, 200 columns wide so nothing wraps. */
  start(command: string, cwd: string, env: Record<string, string> = {}) {
    const exports = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
    this.tmux("new-session", "-d", "-s", this.name, "-x", "200", "-y", "50", `cd ${shellQuote(cwd)} && exec env ${exports} ${command}`);
  }
  /** Types `text` (literally), then Enter as its own key, as a person would. */
  async type(text: string) { this.tmux("send-keys", "-t", this.name, "-l", text); await sleep(700); this.tmux("send-keys", "-t", this.name, "Enter"); }
  key(...keys: string[]) { this.tmux("send-keys", "-t", this.name, ...keys); }
  screen(): string { try { return this.tmux("capture-pane", "-p", "-t", this.name); } catch { return ""; } }
  stop() { try { this.tmux("kill-session", "-t", this.name); } catch { /* already gone */ } }
  static stopAll() { try { execFileSync("tmux", ["-L", Terminal.socket, "kill-server"], { stdio: "ignore" }); } catch { /* none */ } }
}
export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether a CLI is on PATH here (found as the connector finds one: PATHEXT on Windows, where there's no `sh`). */
export const has = (command: string): boolean => which(command) !== null;

/** A fresh, private home for one harness's configuration and sessions. */
export function home(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), `home-${name}-`)));
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const exists = existsSync;
