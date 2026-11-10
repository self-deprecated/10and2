// OpenCode's permissions, as far as Driver needs them: what a session may do unasked, and what new work runs with.
// OpenCode decides a tool call by the last rule that matches it in the agent's ruleset followed by the session's own
// (measured on 1.19.5: a session's rules override its agent's, and OPENCODE_PERMISSION is merged into every agent's).
import { RUNTIME_MODES } from "../policy.ts";
import type { RuntimeMode } from "../policy.ts";

export type Rule = { permission: string; pattern: string; action: "allow" | "ask" | "deny" };

/** OpenCode's wildcard: `*` any run, `?` one character, and a trailing " *" also matches nothing ("ls *" matches "ls"). */
export function wildcard(value: string, pattern: string): boolean {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (re.endsWith(" .*")) re = re.slice(0, -3) + "( .*)?";
  return new RegExp(`^${re}$`, "s").test(value);
}

export function evaluate(rules: readonly Rule[], permission: string, pattern: string): Rule["action"] {
  return rules.findLast((r) => wildcard(permission, r.permission) && wildcard(pattern, r.pattern))?.action ?? "ask";
}

export const isRules = (v: unknown): v is Rule[] => Array.isArray(v) && v.every((r) =>
  r && typeof r.permission === "string" && typeof r.pattern === "string" && ["allow", "ask", "deny"].includes(r.action));

/**
 * The runtime mode a ruleset amounts to: files outside the project unasked is full access; any command unasked is
 * auto; edits unasked is auto-accept-edits; else approval required.
 */
export function reach(rules: readonly Rule[]): RuntimeMode {
  if (evaluate(rules, "external_directory", "/10and2-probe/outside/file") === "allow") return "full-access";
  if (evaluate(rules, "bash", "10and2-probe --any command") === "allow") return "auto";
  if (evaluate(rules, "edit", "10and2-probe.txt") === "allow") return "auto-accept-edits";
  return "approval-required";
}
export const atMost = (mode: RuntimeMode, ceiling: RuntimeMode) => RUNTIME_MODES.indexOf(mode) <= RUNTIME_MODES.indexOf(ceiling);

/** What each mode leaves to the user to allow. */
const ASKS: Record<Exclude<RuntimeMode, "full-access">, string[]> = {
  "approval-required": ["edit", "bash", "task", "webfetch", "websearch", "external_directory", "doom_loop"],
  "auto-accept-edits": ["bash", "task", "webfetch", "websearch", "external_directory", "doom_loop"],
  auto: ["external_directory", "doom_loop"],
};

/**
 * A new session's own rules for a mode. They only ever ask, never allow (full access aside), so an agent or a config
 * that's stricter stays so; OpenCode's own folders outside the project (its tool output, its plans) stay allowed as
 * the agent had them. A plan in full access keeps the plan agent's rules as they are.
 */
export function sessionRules(mode: RuntimeMode, agentRules: readonly Rule[], plan: boolean): Rule[] {
  if (mode === "full-access") return plan ? [] : [{ permission: "*", pattern: "*", action: "allow" }];
  const own = agentRules.filter((r) => r.permission === "external_directory" && r.action === "allow" && r.pattern !== "*");
  return [...ASKS[mode].map((permission): Rule => ({ permission, pattern: "*", action: "ask" })), ...own];
}

/**
 * OPENCODE_PERMISSION for Driver's own `opencode serve`: this machine's ceiling, merged into every agent's rules there,
 * so a session continued there runs within it. Null for full access.
 */
export function serveCeiling(ceiling: RuntimeMode): string | null {
  if (ceiling === "full-access") return null;
  return JSON.stringify(Object.fromEntries(ASKS[ceiling].map((p) => [p, "ask"])));
}
