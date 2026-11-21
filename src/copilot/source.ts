// GitHub Copilot CLI for the ACP adapter (acp/adapter.ts; measured on 1.0.112). Its sessions are folders under
// `<COPILOT_HOME or ~/.copilot>/session-state/` (copilot/session.ts); one a Copilot has open holds `inuse.<pid>.lock`.
// Its ACP session has a mode (agent, plan, autopilot: autopilot allows every tool by itself) and an `allow_all` option
// (off: it asks before any tool that changes something, which Driver refuses). Copilot has no mode that accepts edits
// without also running commands, so a launch below full access runs with `allow_all` off. A Copilot that runs 10 & 2's
// extension (copilot/extension.ts) can be sent to and have its question answered while it's open (copilot/bridge.ts).
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeMode } from "../policy.ts";
import type { Found, Reach, Source } from "../acp/adapter.ts";
import { readLive } from "./bridge.ts";
import { copilotExtensionStatus } from "./extension.ts";
import type { Settings } from "../acp/turn.ts";
import { CopilotSession } from "./session.ts";

export const copilotDir = (env: NodeJS.ProcessEnv = process.env) => env.COPILOT_HOME || join(homedir(), ".copilot");

const MODE = "https://agentclientprotocol.com/protocol/session-modes#";
export const AGENT = `${MODE}agent`, PLAN = `${MODE}plan`, AUTOPILOT = `${MODE}autopilot`;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CopilotSource implements Source {
  readonly agent = "copilot" as const;
  readonly name = "Copilot CLI";
  readonly command: string[];
  readonly worktrees = join(".copilot", "worktrees");
  readonly dir: string;
  private readonly readers = new Map<string, CopilotSession>();

  constructor(opts: { dir?: string; command?: string[] } = {}) {
    this.dir = resolve(opts.dir ?? copilotDir());
    this.command = opts.command ?? ["copilot", "--acp"];
  }
  env(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.dir !== resolve(copilotDir(process.env))) env.COPILOT_HOME = this.dir;
    return env;
  }
  private get state() { return join(this.dir, "session-state"); }
  dirs(): string[] { return [this.dir, this.state, ...[...this.readers.values()].map((r) => r.dir)]; }

  private read(id: string): (Found & { holders: number[] }) | null {
    const dir = join(this.state, id);
    let s = this.readers.get(id);
    if (!s) { s = new CopilotSession(dir); this.readers.set(id, s); }
    s.read();
    if (s.id !== id || !s.cwd) return null;
    const session = s;
    return { id, cwd: s.cwd, title: s.name, createdAt: s.createdAt, mtimeMs: s.mtimeMs, projection: s.projection, started: s.started,
      question: s.question, userCount: s.userCount, says: (w, after) => session.says(w, after), holders: s.holders() };
  }

  sessions(sinceMs: number, also: Set<string>): Found[] {
    let ids: string[];
    try { ids = readdirSync(this.state).filter((d) => uuid.test(d)); } catch { return []; }
    const out: Found[] = [];
    for (const id of ids) {
      let recent = also.has(id);
      // Open now, or written lately (its events, or its lock).
      try { recent ||= Math.max(statSync(join(this.state, id)).mtimeMs, statSync(join(this.state, id, "events.jsonl")).mtimeMs) >= sinceMs; } catch { /* no events yet */ }
      if (!recent && !this.readers.has(id)) { try { recent = readdirSync(join(this.state, id)).some((f) => /^inuse\.\d+\.lock$/.test(f)); } catch { continue; } }
      if (!recent) continue;
      const found = this.read(id);
      if (found) out.push(found);
    }
    for (const id of this.readers.keys()) if (!ids.includes(id)) this.readers.delete(id);
    return out;
  }
  find(id: string): Found | null { return uuid.test(id) ? this.read(id) : null; }

  open(found: Found[], own: Set<number>): Set<string> {
    const out = new Set<string>();
    for (const f of found) {
      const holders = (f as Found & { holders?: number[] }).holders ?? [];
      if (holders.some((pid) => !own.has(pid) && alive(pid))) out.add(f.id);
    }
    return out;
  }

  live(): Map<string, Reach> {
    return new Map([...readLive(this.dir)].map(([id, l]) => [id, { status: l.status, questions: l.questions, socket: l.socket }]));
  }
  reachHint(): string | null {
    let state;
    try { state = copilotExtensionStatus(this.dir).state; } catch { return null; }
    if (state === "installed" || state === "outdated") return "Restarting Copilot there lets 10 & 2 reach it.";
    if (state === "foreign") return null;
    return "Running 10and2 copilot install on this computer, then restarting Copilot, lets 10 & 2 reach it.";
  }

  launch(runtime: RuntimeMode, plan: boolean): Settings {
    return { mode: plan ? PLAN : AGENT, options: { allow_all: runtime === "full-access" ? "on" : "off" } };
  }
  allowed(ceiling: RuntimeMode): { modes: string[]; options: Record<string, string[]> } {
    return ceiling === "full-access" ? { modes: [AGENT, PLAN, AUTOPILOT], options: { allow_all: ["on", "off"] } } : { modes: [AGENT, PLAN], options: { allow_all: ["off"] } };
  }
}
