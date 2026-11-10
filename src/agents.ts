// Which coding agents are on this computer, for setup and `10and2 agents`: installed or not, their version, how many
// sessions they have from the last two weeks, and how many are open now. Read cheaply from their own files, without
// starting anything; a number that can't be told is left out rather than guessed.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./policy.ts";
import { openCodeCounts } from "./opencode/index.ts";
import { countSessions } from "./codex/adapter.ts";

export type Found = { agent: Agent; name: string; installed: boolean; version: string | null; sessions: number | null; open: number | null };

export const NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode", t3: "T3 Code" };
/** The order they're shown in. */
export const ORDER: readonly Agent[] = ["claude", "codex", "pi", "opencode", "t3"];
const RECENT_MS = 14 * 86_400_000;

function onPath(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 4000, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
      const v = /\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?/.exec(String(stdout ?? ""))?.[0];
      resolve(v ?? (err ? null : ""));
    });
  });
}

/** Files under `dir` (to `depth` levels) named like `match`, changed in the last two weeks. */
function recentFiles(dir: string, match: RegExp, depth: number, now = Date.now()): number {
  let n = 0;
  const walk = (d: string, left: number) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
      else if (e.isFile() && match.test(e.name)) { try { if (now - statSync(p).mtimeMs < RECENT_MS) n++; } catch { /* gone */ } }
    }
  };
  walk(dir, depth);
  return n;
}

const alive = (pid: unknown) => { try { return typeof pid === "number" && pid > 0 && (process.kill(pid, 0), true); } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/** Registry files (`<anything>.json` with a `pid`) under `dir` whose process is running. */
function liveRegistries(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).filter((f) => { try { return alive(JSON.parse(readFileSync(join(dir, f), "utf8")).pid); } catch { return false; } }).length;
  } catch { return 0; }
}

export async function detect(env: NodeJS.ProcessEnv = process.env): Promise<Found[]> {
  const home = homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const piDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const opencodeData = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
  const oc = (() => { try { return openCodeCounts(opencodeData); } catch { return null; } })();
  const [claude, codex, pi, opencode, t3] = await Promise.all(["claude", "codex", "pi", "opencode", env.T3_CLI ?? "t3"].map(onPath));
  const found: Found[] = [
    { agent: "claude", name: NAMES.claude, installed: claude !== null || existsSync(join(claudeDir, "projects")), version: claude || null,
      sessions: recentFiles(join(claudeDir, "projects"), /\.jsonl$/, 1), open: liveRegistries(join(claudeDir, "sessions")) },
    { agent: "codex", name: NAMES.codex, installed: codex !== null || existsSync(join(codexHome, "sessions")), version: codex || null,
      sessions: (() => { try { return countSessions(codexHome, 14); } catch { return null; } })(), open: null },
    { agent: "pi", name: NAMES.pi, installed: pi !== null || existsSync(join(piDir, "sessions")), version: pi || null,
      sessions: recentFiles(join(piDir, "sessions"), /\.jsonl$/, 1), open: liveRegistries(join(piDir, "10and2")) },
    { agent: "opencode", name: NAMES.opencode, installed: opencode !== null || existsSync(opencodeData), version: opencode || null, sessions: oc?.sessions ?? null, open: oc?.open ?? null },
    { agent: "t3", name: NAMES.t3, installed: t3 !== null, version: t3 || null, sessions: null, open: null },
  ];
  return ORDER.map((a) => found.find((f) => f.agent === a)!);
}

/** "2.1.321 · 14 sessions · 2 open now", or "not found". */
export function describeFound(f: Found): string {
  if (!f.installed) return "not found";
  const parts = [f.version, f.sessions === null ? null : `${f.sessions} session${f.sessions === 1 ? "" : "s"}`, f.open ? `${f.open} open now` : null];
  return parts.filter(Boolean).join(" · ") || "found";
}
