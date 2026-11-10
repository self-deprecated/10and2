// The oldest release of each coding agent that each of Driver's features works with, and what to say to someone whose
// agent is older. Measured on 10 November 2026 with the harness tests: each agent's real CLI in a container with no
// network, against the fake model, at each candidate release (`CODEX=0.156.0 test/harness/run.sh codex`; each subtest
// is one feature). The runs, and why each floor is where it is: docs/launch/agent-versions.md.
import type { Agent } from "./policy.ts";

export type Feature = "read" | "follow_up" | "steer" | "answer" | "continue" | "start" | "start_worktree" | "tidy";

/** As a list after "too old for Driver to …". */
const WORDS: Record<Feature, string> = {
  read: "see its sessions",
  follow_up: "follow up",
  steer: "steer",
  answer: "answer its questions",
  continue: "continue its closed sessions",
  start: "start new work",
  start_worktree: "start new work in a worktree",
  tidy: "settle and snooze",
};

export const MINIMUM: Record<Agent, Partial<Record<Feature, string>>> = {
  // 2.1.280 is the adapter's own floor for reading Claude Code's files (registry.ts). Answering needs 2.1.314: before it
  // the hook's answer never reaches Claude. Worktrees are used from 2.1.310 (adapter.ts); background sessions from
  // 2.1.321, and older ones run headless instead, which the harness passes on 2.1.316 and 2.1.319.
  claude: { read: "2.1.280", follow_up: "2.1.280", steer: "2.1.280", answer: "2.1.314", continue: "2.1.280", start: "2.1.280", start_worktree: "2.1.310" },
  // An npm-installed Codex starts its shared daemon from 0.156.0 (only the standalone installer's could before), and its
  // terminal runs on that daemon by default from 0.157.0; before that an open session is out of Driver's reach.
  codex: { read: "0.156.0", follow_up: "0.157.0", steer: "0.157.0", answer: "0.157.0", continue: "0.157.0", start: "0.156.0", start_worktree: "0.156.0" },
  // agent_settled (0.80.4, never published; 0.80.5 is the next) tells Driver when a run is over. 0.79.1 is the oldest
  // the harness runs on (it needs defaultProjectTrust).
  pi: { read: "0.80.5", follow_up: "0.79.1", steer: "0.79.1", answer: "0.80.5", continue: "0.80.5", start: "0.79.1", start_worktree: "0.79.1" },
  // The session table's `agent` column, which Driver reads, is there from 1.14.34. Words to a session open in a terminal
  // (through 10and2's plugin) show there from 1.14.49; before it they reach the model but never the terminal.
  opencode: { read: "1.14.34", follow_up: "1.14.49", steer: "1.14.49", answer: "1.14.49", continue: "1.14.34", start: "1.14.34", start_worktree: "1.14.34" },
  // Orchestration protocol 2, scoped sessions and thread launches all came with 0.1.0; 0.0.45 refuses the connection.
  t3: { read: "0.1.0", follow_up: "0.1.0", steer: "0.1.0", answer: "0.1.0", start: "0.1.0", start_worktree: "0.1.0", tidy: "0.1.0" },
};

/** Each agent's own update command, which works however it was installed (all exist well before each floor). */
export const UPDATE: Record<Agent, string> = { claude: "claude update", codex: "codex update", pi: "pi update self", opencode: "opencode upgrade", t3: "t3 update" };

/** The leading x.y.z of a version as numbers ("0.1.6-dev.2d3b" → [0, 1, 6]); null when there isn't one. */
function parts(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function older(v: number[], than: string): boolean {
  const t = parts(than)!;
  for (let i = 0; i < 3; i++) if (v[i] !== t[i]) return v[i]! < t[i]!;
  return false;
}

/** The features an installed version is too old for, and the release that has them all; null when it's new enough or unknown. */
export function shortfall(agent: Agent, version: string | null): { features: Feature[]; needs: string } | null {
  const v = version ? parts(version) : null;
  if (!v) return null;
  const missing = (Object.entries(MINIMUM[agent]) as [Feature, string][]).filter(([, min]) => older(v, min));
  if (!missing.length) return null;
  const needs = missing.map(([, min]) => min).reduce((a, b) => (older(parts(a)!, b) ? b : a));
  return { features: missing.map(([f]) => f), needs };
}

const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/**
 * What to tell someone whose agent is too old, and how to update it; null when it's new enough or its version is unknown.
 * "Codex 0.156.0 is too old for Driver to follow up, steer, answer its questions or continue its closed sessions. Update
 * to 0.157.0 or newer: codex update"
 */
export function versionWarning(agent: Agent, name: string, version: string | null): string | null {
  const s = shortfall(agent, version);
  if (!s) return null;
  // Without seeing its sessions, nothing else is of use.
  const what = s.features.includes("read") ? "use" : list(s.features.map((f) => WORDS[f]));
  return `${name} ${version} is too old for Driver to ${what}. Update to ${s.needs} or newer: ${UPDATE[agent]}`;
}
