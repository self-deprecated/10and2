// Shared pieces of the harness tests (test/harness/*.harness.ts): real coding-agent CLIs in a container, a deterministic
// fake model (test/fixtures/mock-model.mjs) instead of a real one, tmux for their terminal UIs, scratch git projects.
// They run only inside the harness container (run.sh); `inContainer` says whether this is it.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export const inContainer = process.env.TENANDTWO_HARNESS === "1";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits for `test` to hold, checking every 100 ms; throws with `what` after `ms`. */
export async function until(what: string, test: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await test()) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export type Mock = { url: string; port: number; requests: () => { path: string; texts: string[] }[]; saw: (text: string) => boolean; close: () => void };

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

/** Whether a CLI is on PATH here. */
export function has(command: string): boolean {
  try { execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }); return true; } catch { return false; }
}

/** A fresh, private home for one harness's configuration and sessions. */
export function home(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), `home-${name}-`)));
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const exists = existsSync;
