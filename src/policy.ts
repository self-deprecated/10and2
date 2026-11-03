// The connector's local policy: which folders Driver may see on this machine, which actions it may take, and the most
// a launch may run with. It lives here and is enforced here, so a brain that asks for more (or a compromised one)
// gets refused. Nothing in it ever leaves the machine.
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep, dirname, basename } from "node:path";
import type { ActionKind, LaunchProfile } from "./contract.ts";
import { configDirectory } from "./paths.ts";

export type RuntimeMode = LaunchProfile["runtimeMode"];

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
  /** Whether this machine's T3 Code is read. On by default; off for a machine with Claude Code only. */
  t3: boolean;
};

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
  if (raw.t3 === false && !raw.claude) throw bad("t3 and claude are both off, so there's nothing to connect");
  return { brain: raw.brain, projects, actions: [...new Set(actions as ActionKind[])], maxRuntimeMode, claude: raw.claude ?? false, t3: raw.t3 ?? true };
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

export function allows(policy: Policy, kind: ActionKind): boolean {
  return policy.actions.includes(kind);
}

/** Whether a launch profile stays within the policy's ceiling. */
export function withinCeiling(policy: Policy, profile: Pick<LaunchProfile, "runtimeMode">): boolean {
  const requested = RUNTIME_MODES.indexOf(profile.runtimeMode);
  return requested >= 0 && requested <= RUNTIME_MODES.indexOf(policy.maxRuntimeMode);
}
