// Which coding agents are on this computer, for setup and `10and2 agents`: installed or not, their version, how many
// sessions they have from the last two weeks, and how many are open now. Read cheaply from their own files, without
// starting anything; a number that can't be told is left out rather than guessed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileCommand, which } from "./command.ts";
import type { Agent } from "./policy.ts";
import { openCodeCounts } from "./opencode/index.ts";
import { countSessions } from "./codex/adapter.ts";
import { piAgentDir } from "./pi/extension.ts";
import { t3Home } from "./t3/adapter.ts";
import { geminiDir, isGemini } from "./gemini/source.ts";
import { copilotDir } from "./copilot/source.ts";
import { processes } from "./acp/processes.ts";

export type Found = { agent: Agent; name: string; installed: boolean; version: string | null; sessions: number | null; open: number | null };

export const NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode", gemini: "Gemini CLI", copilot: "Copilot CLI", t3: "T3 Code" };
/** The order they're shown in. */
export const ORDER: readonly Agent[] = ["claude", "codex", "pi", "opencode", "gemini", "copilot", "t3"];
const RECENT_MS = 14 * 86_400_000;

/**
 * The version a command on PATH says it is: "" when it answers without one, null when it isn't there. Found first, so a
 * program of that name in the current folder is never run (Windows would look there before PATH). Windows starts a
 * Node-based command (`codex.cmd`) several times slower, and scans it, so it has longer to answer there.
 */
function onPath(bin: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!which(bin, env)) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Windows refuses some programs at once, with a throw rather than an error (an .exe whose install step didn't run,
    // left as a stub, is EFTYPE): one that won't start is as good as none.
    try {
      execFileCommand(bin, ["--version"], { timeout: process.platform === "win32" ? 10_000 : 4000, maxBuffer: 256 * 1024, env }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(null);
        const v = /\d+\.\d+(?:\.\d+)?(?:[-+.][\w.]+)?/.exec(String(stdout ?? ""))?.[0];
        resolve(v ?? (err ? null : ""));
      });
    } catch { resolve(null); }
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

/** Copilot sessions some Copilot holds open now (`inuse.<pid>.lock` with that pid running). */
function openCopilots(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).filter((d) => {
      try { return readdirSync(join(dir, d.name)).some((f) => { const pid = /^inuse\.(\d+)\.lock$/.exec(f)?.[1]; return !!pid && alive(Number(pid)); }); } catch { return false; }
    }).length;
  } catch { return 0; }
}

export async function detect(env: NodeJS.ProcessEnv = process.env): Promise<Found[]> {
  const home = homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const piDir = piAgentDir(env);
  const opencodeData = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
  const oc = (() => { try { return openCodeCounts(opencodeData); } catch { return null; } })();
  const t3Cli = env.T3_CLI ?? "t3";
  const gemini = geminiDir(env), copilot = copilotDir(env);
  const [claude, codex, pi, opencode, t3, geminiV, copilotV] = await Promise.all(["claude", "codex", "pi", "opencode", t3Cli, "gemini", "copilot"].map((bin) => onPath(bin, env)));
  const found: Found[] = [
    { agent: "claude", name: NAMES.claude, installed: claude !== null || existsSync(join(claudeDir, "projects")), version: claude || null,
      sessions: recentFiles(join(claudeDir, "projects"), /\.jsonl$/, 1), open: liveRegistries(join(claudeDir, "sessions")) },
    { agent: "codex", name: NAMES.codex, installed: codex !== null || existsSync(join(codexHome, "sessions")), version: codex || null,
      sessions: (() => { try { return countSessions(codexHome, 14); } catch { return null; } })(), open: null },
    { agent: "pi", name: NAMES.pi, installed: pi !== null || existsSync(join(piDir, "sessions")), version: pi || null,
      sessions: recentFiles(join(piDir, "sessions"), /\.jsonl$/, 1), open: liveRegistries(join(piDir, "10and2")) },
    { agent: "opencode", name: NAMES.opencode, installed: opencode !== null || existsSync(opencodeData), version: opencode || null, sessions: oc?.sessions ?? null, open: oc?.open ?? null },
    // Gemini CLI keeps no record of what's open: its running processes are counted instead.
    { agent: "gemini", name: NAMES.gemini, installed: geminiV !== null || existsSync(join(gemini, "tmp")), version: geminiV || null,
      sessions: recentFiles(join(gemini, "tmp"), /^session-.*\.jsonl?$/, 2), open: geminiV === null && !existsSync(join(gemini, "tmp")) ? null : processes(isGemini).length },
    { agent: "copilot", name: NAMES.copilot, installed: copilotV !== null || existsSync(join(copilot, "session-state")), version: copilotV || null,
      sessions: recentFiles(join(copilot, "session-state"), /^events\.jsonl$/, 1), open: openCopilots(join(copilot, "session-state")) },
    // A `t3` that didn't answer in time (T3's desktop app starts its own as Node, slowly on Windows) still counts where
    // T3 has run. Never without one: the connector reaches T3 through it, and stops when it can't.
    { agent: "t3", name: NAMES.t3, installed: t3 !== null || (existsSync(join(t3Home(env), "userdata")) && which(t3Cli, env) !== null), version: t3 || null, sessions: null, open: null },
  ];
  return ORDER.map((a) => found.find((f) => f.agent === a)!);
}

/** "2.1.321 · 14 sessions · 2 open now", or "not found". */
export function describeFound(f: Found): string {
  if (!f.installed) return "not found";
  const parts = [f.version, f.sessions === null ? null : `${f.sessions} session${f.sessions === 1 ? "" : "s"}`, f.open ? `${f.open} open now` : null];
  return parts.filter(Boolean).join(" · ") || "found";
}
