// The connector's local policy: which folders Driver may see on this machine, which actions it may take, and the most
// a launch may run with. It lives here and is enforced here, so a brain that asks for more (or a compromised one)
// gets refused. Nothing in it ever leaves the machine.
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep, dirname, basename } from "node:path";
import type { ActionKind, LaunchProfile } from "./contract.ts";
import { configDirectory } from "./paths.ts";

export type RuntimeMode = LaunchProfile["runtimeMode"];

/** The coding agents a connector can read, each with its own adapter. */
export const AGENTS = ["t3", "claude", "codex", "opencode", "pi"] as const;
export type Agent = (typeof AGENTS)[number];
/**
 * What one agent may do, narrower than the machine's own: an agent's entry in `agents` may switch off steering or
 * answering, keep fewer actions, or lower the ceiling. It never grants more than the top level.
 */
export type Limit = { steer?: boolean; answer?: boolean; actions?: ActionKind[]; maxRuntimeMode?: RuntimeMode };

export type Policy = {
  /** The brain's connector endpoint: `wss://…/connector`. */
  brain: string;
  /** Folders whose work Driver may see, or "*" for everything. A project or session is visible when its folder is one of these or inside one. */
  projects: string[] | "*";
  /** What Driver may do. Empty: read only. */
  actions: ActionKind[];
  /** The most any launch may run with, whatever profile the brain names. */
  maxRuntimeMode: RuntimeMode;
  /** Whether Claude Code sessions are read here. */
  claude: boolean;
  /** Whether this machine's T3 Code is read. On by default; off for a machine without it. */
  t3: boolean;
  /** Whether Codex CLI sessions are read here (outside T3 Code, which reads its own). */
  codex: boolean;
  /** Whether OpenCode sessions are read here. */
  opencode: boolean;
  /** Whether Pi sessions are read here. */
  pi: boolean;
  /** Whether a follow-up may reach a session that's open (in a terminal, a background session, still running). On by default. */
  steer: boolean;
  /** Whether Driver may answer an agent's questions and plans. On by default. */
  answer: boolean;
  /** Per agent, what's narrower than the above. */
  limits: Partial<Record<Agent, Limit>>;
  /**
   * Where a new T3 Code worktree starts: a branch, fetched from origin first so it's the latest there (the branch as it
   * is here when origin hasn't got it), or "HEAD", whatever the project's checkout is on now.
   */
  worktreeBase: string;
};

/** A branch name or "HEAD": no option, revset or range syntax, since T3 hands it to git and jj. */
export const validBase = (b: unknown): b is string =>
  typeof b === "string" && /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/.test(b) && !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock");

const ACTIONS: readonly ActionKind[] = ["follow_up", "settle", "snooze", "archive", "start_work"];
/** Narrowest first. */
export const RUNTIME_MODES: readonly RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

export function defaultPolicyPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), "connector.json");
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/** Resolve missing tails through the nearest existing ancestor, without hiding symlinks or access errors. */
function real(p: string): string | null {
  let ancestor = resolve(expand(p));
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(ancestor), ...tail); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
      // A dangling symlink exists but cannot be resolved; walking past it would grant its lexical path.
      try { lstatSync(ancestor); return null; }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") return null; }
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      tail.unshift(basename(ancestor)); ancestor = parent;
    }
  }
}

/** Reads and checks the policy. Anything missing is the narrowest choice: no projects, read only, approval required. */
export function parsePolicy(text: string): Policy {
  const bad = (why: string) => new Error(`connector policy: ${why}`);
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad("isn't JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad("must be an object");
  let endpoint: URL;
  try { endpoint = new URL(raw.brain); }
  catch { throw bad("brain must be a ws:// or wss:// URL"); }
  if (typeof raw.brain !== "string" || !["ws:", "wss:"].includes(endpoint.protocol)) throw bad("brain must be a ws:// or wss:// URL");
  if (endpoint.username || endpoint.password) throw bad("brain must not contain user-info");
  // Plain ws only to this machine: anything else would send the token and every thread in the clear.
  if (endpoint.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw bad("brain must use wss:// unless it's on this machine");
  let projects: Policy["projects"] = [];
  if (raw.projects === "*") projects = "*";
  else if (raw.projects !== undefined) {
    if (!Array.isArray(raw.projects) || raw.projects.some((p: unknown) => typeof p !== "string" || !p.trim())) throw bad('projects must be "*" or a list of folders');
    projects = raw.projects.map((p: string) => {
      if (!isAbsolute(expand(p))) throw bad(`project folder "${p}" must be absolute (or start with ~/)`);
      const root = real(p);
      if (root === null) throw bad(`project folder "${p}" cannot be resolved`);
      return root;
    });
  }
  const actions = raw.actions ?? [];
  if (!Array.isArray(actions) || actions.some((a: unknown) => !ACTIONS.includes(a as ActionKind))) throw bad(`actions must be a list of ${ACTIONS.join(", ")}`);
  const maxRuntimeMode = raw.maxRuntimeMode ?? "approval-required";
  if (!RUNTIME_MODES.includes(maxRuntimeMode)) throw bad(`maxRuntimeMode must be one of ${RUNTIME_MODES.join(", ")}`);
  if (raw.claude !== undefined && typeof raw.claude !== "boolean") throw bad("claude must be true or false");
  if (raw.t3 !== undefined && typeof raw.t3 !== "boolean") throw bad("t3 must be true or false");
  // Which agents are on: `agents` (true, false, or an object narrowing that agent), or the older top-level booleans.
  const on: Record<Agent, boolean> = { t3: true, claude: false, codex: false, opencode: false, pi: false };
  const limits: Partial<Record<Agent, Limit>> = {};
  if (raw.agents !== undefined) {
    if (typeof raw.agents !== "object" || raw.agents === null || Array.isArray(raw.agents)) throw bad("agents must be an object");
    for (const [k, v] of Object.entries(raw.agents) as [string, any][]) {
      if (!AGENTS.includes(k as Agent)) throw bad(`agents has no agent called "${k}" (${AGENTS.join(", ")})`);
      if (typeof v === "boolean") { on[k as Agent] = v; continue; }
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw bad(`agents.${k} must be true, false or an object`);
      const limit: Limit = {};
      for (const f of Object.keys(v)) if (!["on", "steer", "answer", "actions", "maxRuntimeMode"].includes(f)) throw bad(`agents.${k} has no setting "${f}"`);
      for (const f of ["on", "steer", "answer"] as const) if (v[f] !== undefined && typeof v[f] !== "boolean") throw bad(`agents.${k}.${f} must be true or false`);
      if (v.steer !== undefined) limit.steer = v.steer;
      if (v.answer !== undefined) limit.answer = v.answer;
      if (v.actions !== undefined) {
        if (!Array.isArray(v.actions) || v.actions.some((a: unknown) => !ACTIONS.includes(a as ActionKind))) throw bad(`agents.${k}.actions must be a list of ${ACTIONS.join(", ")}`);
        limit.actions = [...new Set(v.actions as ActionKind[])];
      }
      if (v.maxRuntimeMode !== undefined) {
        if (!RUNTIME_MODES.includes(v.maxRuntimeMode)) throw bad(`agents.${k}.maxRuntimeMode must be one of ${RUNTIME_MODES.join(", ")}`);
        limit.maxRuntimeMode = v.maxRuntimeMode;
      }
      on[k as Agent] = v.on !== false;
      limits[k as Agent] = limit;
    }
  } else {
    for (const k of AGENTS) if (raw[k] !== undefined && typeof raw[k] !== "boolean") throw bad(`${k} must be true or false`);
    on.t3 = raw.t3 ?? true;
    for (const k of ["claude", "codex", "opencode", "pi"] as const) on[k] = raw[k] ?? false;
  }
  if (!AGENTS.some((k) => on[k])) throw bad("every coding agent is off, so there's nothing to connect");
  for (const k of ["steer", "answer"]) if (raw[k] !== undefined && typeof raw[k] !== "boolean") throw bad(`${k} must be true or false`);
  const worktreeBase = raw.worktreeBase ?? "HEAD";
  if (!validBase(worktreeBase)) throw bad('worktreeBase must be a branch name, such as "main", or "HEAD"');
  return { brain: raw.brain, projects, actions: [...new Set(actions as ActionKind[])], maxRuntimeMode, ...on,
    steer: raw.steer ?? true, answer: raw.answer ?? true, limits, worktreeBase };
}

export function loadPolicy(path = defaultPolicyPath()): Policy {
  return parsePolicy(readFileSync(path, "utf8"));
}

/** Whether work in this folder may be seen (and so acted on). Resolution errors never grant visibility. */
export function visible(policy: Policy, folder: string | null | undefined): boolean {
  if (!folder) return false;
  const p = real(folder);
  if (p === null) return false;
  if (policy.projects === "*") return true;
  return policy.projects.some((root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** Undoing a snooze or a settle is allowed wherever doing it is: a policy names only the five actions. */
const UNDOES: Partial<Record<ActionKind, ActionKind>> = { unsnooze: "snooze", unsettle: "settle" };

/** Whether an action is allowed: on this machine, and for `agent` when given (whose own list can only narrow it). */
export function allows(policy: Policy, kind: ActionKind, agent?: Agent): boolean {
  const k = UNDOES[kind] ?? kind;
  const own = agent ? policy.limits?.[agent]?.actions : undefined;
  return policy.actions.includes(k) && (!own || own.includes(k));
}

/** Whether a follow-up may reach an open session of `agent` (a terminal, a background session, one still running). */
export const steers = (policy: Policy, agent: Agent): boolean =>
  policy.steer !== false && policy.limits?.[agent]?.steer !== false && allows(policy, "follow_up", agent);

/** Whether Driver may answer `agent`'s questions and plans. */
export const answers = (policy: Policy, agent: Agent): boolean =>
  policy.answer !== false && policy.limits?.[agent]?.answer !== false && allows(policy, "follow_up", agent);

/** The most `agent`'s work may run with: the machine's ceiling, or that agent's lower one. */
export function ceilingFor(policy: Policy, agent?: Agent): RuntimeMode {
  const own = agent ? policy.limits?.[agent]?.maxRuntimeMode : undefined;
  return own && RUNTIME_MODES.indexOf(own) < RUNTIME_MODES.indexOf(policy.maxRuntimeMode) ? own : policy.maxRuntimeMode;
}

/** Whether a launch profile stays within the ceiling (for `agent`, when given). */
export function withinCeiling(policy: Policy, profile: Pick<LaunchProfile, "runtimeMode">, agent?: Agent): boolean {
  const requested = RUNTIME_MODES.indexOf(profile.runtimeMode);
  return requested >= 0 && requested <= RUNTIME_MODES.indexOf(ceilingFor(policy, agent));
}
