// Gemini CLI for the ACP adapter (acp/adapter.ts; measured on 0.68.0 and 0.70.0). Its sessions are files under
// `<GEMINI_CLI_HOME or ~>/.gemini/tmp/<project>/chats/` (gemini/session.ts), one folder per project: named by Gemini
// (`projects.json` maps each root to it, and `.project_root` in it says the root), or, before that, by the root's
// SHA-256. It keeps no record of which session is open, so one is open while a `gemini` running in its project started
// before the session was last written, or names it (`--resume <id>`). Its ACP modes: default (asks for every tool that
// changes anything, which Driver refuses), autoEdit, yolo, plan.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeMode } from "../policy.ts";
import type { Found, Source } from "../acp/adapter.ts";
import type { Settings } from "../acp/turn.ts";
import { processes, type Proc } from "../acp/processes.ts";
import { GeminiSession } from "./session.ts";

/** Gemini's own folder: `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`. */
export const geminiDir = (env: NodeJS.ProcessEnv = process.env) => join(env.GEMINI_CLI_HOME || homedir(), ".gemini");

/** A process that's Gemini CLI: `gemini …`, or Node running its bundle (`…/gemini-cli/bundle/gemini.js`, `.gemini-wrapped`). */
export const isGemini = (args: string[]) => args.slice(0, 3).some((a) => /(?:^|[/\\])(?:\.?gemini(?:-wrapped)?|gemini\.js)$/.test(a) || /gemini-cli[/\\].*gemini\.js$/.test(a));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export class GeminiSource implements Source {
  readonly agent = "gemini" as const;
  readonly name = "Gemini CLI";
  readonly command: string[];
  readonly worktrees = join(".gemini", "worktrees");
  readonly dir: string;
  private readonly readers = new Map<string, GeminiSession>();
  private readonly roots = new Map<string, string>();
  private readonly procs: (match: (args: string[]) => boolean) => Proc[];

  constructor(opts: { dir?: string; command?: string[]; processes?: (match: (args: string[]) => boolean) => Proc[] } = {}) {
    this.dir = resolve(opts.dir ?? geminiDir());
    this.command = opts.command ?? ["gemini", "--acp"];
    this.procs = opts.processes ?? ((m) => processes(m));
  }

  env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.dir !== resolve(geminiDir(process.env))) env.GEMINI_CLI_HOME = resolve(this.dir, "..");
    return env;
  }
  private get tmp() { return join(this.dir, "tmp"); }
  dirs(): string[] {
    const out = [this.dir, this.tmp];
    try { for (const d of readdirSync(this.tmp)) out.push(join(this.tmp, d), join(this.tmp, d, "chats")); } catch { /* none yet */ }
    return out;
  }

  /** Each project folder's root: from `.project_root`, else `projects.json`, else a known root whose hash names it. */
  private rootOf(folder: string): string | null {
    const own = (() => { try { return readFileSync(join(this.tmp, folder, ".project_root"), "utf8").trim(); } catch { return ""; } })();
    if (own) return own;
    if (this.roots.has(folder)) return this.roots.get(folder)!;
    const projects = readJson(join(this.dir, "projects.json"))?.projects ?? {};
    const trusted = readJson(join(this.dir, "trustedFolders.json")) ?? {};
    for (const root of [...Object.keys(projects), ...Object.keys(trusted)]) {
      if (projects[root] === folder || sha(root) === folder) { this.roots.set(folder, root); return root; }
    }
    return null;
  }

  private read(path: string, cwd: string): Found | null {
    let s = this.readers.get(path);
    if (!s) { s = new GeminiSession(path); this.readers.set(path, s); }
    s.read();
    if (!s.id || s.kind !== "main") return null;
    const session = s;
    return { id: s.id, cwd, title: s.summary, createdAt: s.startTime, mtimeMs: Date.parse(s.mtime) || 0, projection: s.projection,
      started: s.started, question: null, userCount: s.userCount, says: (w, after) => session.says(w, after) };
  }

  sessions(sinceMs: number, also: Set<string>): Found[] {
    const out = new Map<string, Found>(), seen = new Set<string>();
    let folders: string[] = [];
    try { folders = readdirSync(this.tmp); } catch { return []; }
    for (const folder of folders) {
      let files: string[];
      try { files = readdirSync(join(this.tmp, folder, "chats")).filter((f) => /^session-.*\.jsonl?$/.test(f)); } catch { continue; }
      const root = this.rootOf(folder);
      if (!root) continue;
      for (const f of files) {
        const path = join(this.tmp, folder, "chats", f);
        seen.add(path);
        // `session-<time>-<first 8 of the id>.jsonl`: one Driver runs is read whatever its age.
        const prefix = /-([0-9a-f]{8})\.jsonl?$/.exec(f)?.[1];
        try { if (statSync(path).mtimeMs < sinceMs && ![...also].some((id) => id.startsWith(prefix ?? "-"))) continue; } catch { continue; }
        const found = this.read(path, root);
        if (found && (!out.has(found.id) || out.get(found.id)!.mtimeMs < found.mtimeMs)) out.set(found.id, found);
      }
    }
    for (const path of this.readers.keys()) if (!seen.has(path)) this.readers.delete(path);
    return [...out.values()];
  }

  find(id: string): Found | null {
    try {
      for (const folder of readdirSync(this.tmp)) {
        const root = this.rootOf(folder);
        let files: string[];
        try { files = readdirSync(join(this.tmp, folder, "chats")); } catch { continue; }
        for (const f of files.filter((f) => f.endsWith(`-${id.slice(0, 8)}.jsonl`) || f.endsWith(`-${id.slice(0, 8)}.json`))) {
          const found = root ? this.read(join(this.tmp, folder, "chats", f), root) : null;
          if (found?.id === id) return found;
        }
      }
    } catch { /* none yet */ }
    return null;
  }

  open(found: Found[], own: Set<number>): Set<string> {
    const running = this.procs(isGemini).filter((p) => !own.has(p.pid));
    const out = new Set<string>();
    for (const f of found) {
      for (const p of running) {
        // Started before the session was last written, in its folder (or anywhere, where the folder can't be read).
        const here = p.cwd === null || samePath(p.cwd, f.cwd);
        const named = p.args.some((a) => a === f.id || (a.length >= 8 && f.id.startsWith(a) && /^[0-9a-f-]+$/.test(a)));
        if (named || (here && p.startMs <= f.mtimeMs + 2000)) { out.add(f.id); break; }
      }
    }
    return out;
  }

  launch(runtime: RuntimeMode, plan: boolean): Settings {
    if (plan) return { mode: "plan" };
    return { mode: runtime === "full-access" ? "yolo" : runtime === "approval-required" ? "default" : "autoEdit" };
  }
  allowed(ceiling: RuntimeMode): { modes: string[]; options: Record<string, string[]> } {
    const modes = ["default", "plan"];
    if (ceiling !== "approval-required") modes.push("autoEdit");
    if (ceiling === "full-access") modes.push("yolo");
    return { modes, options: {} };
  }
}

