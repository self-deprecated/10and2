// Choosing which coding agents to connect and what Driver may do with them: setup's two screens and `10and2 agents`
// (docs/launch/mockups/connector-setup). What's chosen becomes the policy's `actions`, `steer`, `answer`,
// `maxRuntimeMode` and `agents`; this file turns one into the other, and parses the flags for doing it without a terminal.
import type { ActionKind } from "./contract.ts";
import { AGENTS, RUNTIME_MODES, type Agent, type RuntimeMode } from "./policy.ts";
import { describeFound, NAMES, ORDER, type Found } from "./agents.ts";
import { checklist, type Row } from "./ui.ts";

/** What Driver may do, as the person reads it. `tidy` is settle, snooze and archive together. */
export const CAPS = ["follow_up", "steer", "answer", "start_work", "tidy"] as const;
export type Cap = (typeof CAPS)[number];
export const CAP_LABEL: Record<Cap, string> = {
  follow_up: "Follow up on a session",
  steer: "Steer a session that's open",
  answer: "Answer an agent's questions and plans",
  start_work: "Start new work",
  tidy: "Settle, snooze and archive",
};
const CAP_DETAIL: Partial<Record<Cap, string>> = { steer: "(in a terminal, or still running)" };
/** Short names for the summary and `status`. */
export const CAP_SHORT: Record<Cap, string> = { follow_up: "follow up", steer: "steer", answer: "answer", start_work: "start", tidy: "tidy" };
export const CEILING_LABEL: Record<RuntimeMode, string> = { "approval-required": "ask first", "auto-accept-edits": "accept edits", auto: "auto", "full-access": "full access" };

export type Choice = {
  on: Record<Agent, boolean>;
  caps: Record<Cap, boolean>;
  ceiling: RuntimeMode;
  /** Per agent, the capabilities switched off for it alone. */
  off: Partial<Record<Agent, Cap[]>>;
};

const TIDY: ActionKind[] = ["settle", "snooze", "archive"];
const actionsOf = (caps: Record<Cap, boolean>): ActionKind[] =>
  [...(caps.follow_up ? ["follow_up" as const] : []), ...(caps.tidy ? TIDY : []), ...(caps.start_work ? ["start_work" as const] : [])];

/** The choice a policy file holds (raw JSON, as written; the older top-level booleans too). */
export function choiceOf(raw: any): Choice {
  const actions: string[] = Array.isArray(raw?.actions) ? raw.actions : [];
  const on: Record<Agent, boolean> = { t3: raw?.t3 ?? true, claude: !!raw?.claude, codex: !!raw?.codex, opencode: !!raw?.opencode, pi: !!raw?.pi };
  const off: Partial<Record<Agent, Cap[]>> = {};
  if (raw?.agents && typeof raw.agents === "object") {
    for (const a of AGENTS) {
      const v = raw.agents[a];
      on[a] = v === undefined ? false : v === true || (typeof v === "object" && v !== null && v.on !== false);
      if (typeof v !== "object" || v === null) continue;
      const own: string[] | undefined = Array.isArray(v.actions) ? v.actions : undefined;
      const caps: Cap[] = [];
      if (v.steer === false) caps.push("steer");
      if (v.answer === false) caps.push("answer");
      if (own && !own.includes("follow_up")) caps.push("follow_up");
      if (own && !own.includes("start_work")) caps.push("start_work");
      if (own && !TIDY.some((t) => own.includes(t))) caps.push("tidy");
      if (caps.length) off[a] = caps;
    }
  }
  return {
    on, off,
    caps: { follow_up: actions.includes("follow_up"), steer: raw?.steer !== false, answer: raw?.answer !== false, start_work: actions.includes("start_work"), tidy: TIDY.some((t) => actions.includes(t)) },
    ceiling: RUNTIME_MODES.includes(raw?.maxRuntimeMode) ? raw.maxRuntimeMode : "approval-required",
  };
}

/** Everything allowed, every agent found on: what setup offers first, and what applies off a terminal. */
export function defaultChoice(found: Found[]): Choice {
  const on = Object.fromEntries(AGENTS.map((a) => [a, found.find((f) => f.agent === a)?.installed ?? false])) as Record<Agent, boolean>;
  return { on, off: {}, caps: { follow_up: true, steer: true, answer: true, start_work: true, tidy: true }, ceiling: "full-access" };
}

/**
 * Where choosing starts: what the policy file holds, or, with none, everything found. An agent a file from before
 * `agents` doesn't mention (it predates that agent's support) starts as found, as it would in a new setup.
 */
export function startingChoice(raw: any | null, found: Found[]): Choice {
  if (!raw) return defaultChoice(found);
  const c = choiceOf(raw);
  if (!raw.agents) for (const f of found) if (f.agent !== "t3" && raw[f.agent] === undefined) c.on[f.agent] = f.installed;
  return c;
}

/** The policy fields a choice writes; the older top-level agent booleans are dropped for `agents`. */
export function policyFields(c: Choice): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  for (const a of ORDER) {
    const off = (c.off[a] ?? []).filter((cap) => c.caps[cap]);
    if (!c.on[a] || !off.length) { agents[a] = c.on[a]; continue; }
    const narrowed: Record<string, unknown> = {};
    if (off.includes("steer")) narrowed.steer = false;
    if (off.includes("answer")) narrowed.answer = false;
    if (off.some((cap) => cap === "follow_up" || cap === "start_work" || cap === "tidy")) {
      narrowed.actions = actionsOf({ ...c.caps, ...Object.fromEntries(off.map((cap) => [cap, false])) });
    }
    agents[a] = narrowed;
  }
  return { actions: actionsOf(c.caps), steer: c.caps.steer, answer: c.caps.answer, maxRuntimeMode: c.ceiling, agents };
}

/** Writes a choice over an existing policy object (brain, projects, worktreeBase stay). */
export function applyChoice(policy: Record<string, unknown>, c: Choice): Record<string, unknown> {
  const out = { ...policy };
  for (const a of AGENTS) delete out[a];
  return { ...out, ...policyFields(c) };
}

/** What each agent may do in the end, for the summary and `status`: its capabilities, after its own narrowing. */
export function capsFor(c: Choice, a: Agent): Cap[] {
  return CAPS.filter((cap) => c.caps[cap] && !(c.off[a] ?? []).includes(cap) && (cap !== "steer" && cap !== "answer" || c.caps.follow_up && !(c.off[a] ?? []).includes("follow_up")));
}

const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
/** Setup's closing words: who Driver can reach, what it may do, and what's narrower for one agent. */
export function summary(c: Choice, found: Found[]): string[] {
  const reach = ORDER.filter((a) => c.on[a]).map((a) => NAMES[a]);
  const offFound = ORDER.filter((a) => !c.on[a] && found.find((f) => f.agent === a)?.installed).map((a) => NAMES[a]);
  const all = CAPS.filter((cap) => c.caps[cap]).flatMap((cap) => ({ follow_up: ["follow up"], steer: ["steer an open session"], answer: ["answer questions"], start_work: ["start new work"], tidy: ["settle", "snooze", "archive"] })[cap]);
  const lines = [`10 & 2 can reach ${list(reach)}${offFound.length ? ` (${list(offFound)} ${offFound.length === 1 ? "is" : "are"} off)` : ""}, and can ${all.length ? list(all) : "only read"}: each only after you hear it read back and say yes.`];
  for (const a of ORDER) {
    const off = (c.off[a] ?? []).filter((cap) => c.on[a] && c.caps[cap]);
    if (off.length) lines.push(`For ${NAMES[a]}: ${off.map((cap) => "no " + ({ follow_up: "follow-ups", steer: "steering", answer: "answering", start_work: "new work", tidy: "tidying" })[cap]).join(", ")}.`);
  }
  return lines;
}

/**
 * The flags that choose without a terminal: `--agents=claude,pi` (only these), `--off=codex`, `--no-steer`,
 * `--no-answer`, `--no-start`, `--read-only`; `--no-steer=codex` and the like narrow one agent. Unknown names throw.
 */
export function applyFlags(c: Choice, flags: Map<string, string>): Choice {
  const names = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!AGENTS.includes(s as Agent)) throw new Error(`There's no agent called "${s}" (${AGENTS.join(", ")}).`);
    return s as Agent;
  });
  const out: Choice = { on: { ...c.on }, caps: { ...c.caps }, ceiling: c.ceiling, off: Object.fromEntries(Object.entries(c.off).map(([k, v]) => [k, [...v!]])) };
  if (flags.has("agents")) { const only = names(flags.get("agents")!); for (const a of AGENTS) out.on[a] = only.includes(a); }
  if (flags.has("off")) for (const a of names(flags.get("off")!)) out.on[a] = false;
  if (flags.has("read-only")) for (const cap of CAPS) out.caps[cap] = false;
  for (const [flag, cap] of [["no-steer", "steer"], ["no-answer", "answer"], ["no-start", "start_work"], ["no-follow-up", "follow_up"], ["no-tidy", "tidy"]] as const) {
    if (!flags.has(flag)) continue;
    const v = flags.get(flag)!;
    if (v === "true") out.caps[cap] = false;
    else for (const a of names(v)) out.off[a] = [...new Set([...(out.off[a] ?? []), cap])];
  }
  return out;
}

/** The two screens (agents, then what Driver may do), with → on an agent for its own narrowing. */
export async function chooseInteractively(found: Found[], start: Choice): Promise<Choice> {
  const c: Choice = { ...start, on: { ...start.on }, caps: { ...start.caps }, off: { ...start.off } };
  for (;;) {
    const rows: Row[] = ORDER.map((a) => {
      const f = found.find((x) => x.agent === a)!;
      const narrowed = (c.off[a] ?? []).filter((cap) => c.caps[cap]).length;
      return { kind: "box", label: NAMES[a], detail: describeFound(f) + (narrowed ? ` · ${narrowed} switched off` : ""), on: c.on[a] && f.installed, disabled: !f.installed && !c.on[a], open: true };
    });
    const picked = await checklist("Coding agents on this computer", rows, "↑↓ move · space switch on/off · → what 10 & 2 may do with it · enter continue · q quit");
    picked.rows.forEach((r, i) => { if (r.kind === "box") c.on[ORDER[i]!] = r.on; });
    if (picked.open === undefined) break;
    const a = ORDER[picked.open]!;
    const own = await checklist(`${NAMES[a]}: what 10 & 2 may do`, CAPS.map((cap) => ({
      kind: "box", label: CAP_LABEL[cap], on: c.caps[cap] && !(c.off[a] ?? []).includes(cap), disabled: !c.caps[cap],
      detail: !c.caps[cap] ? "off for every agent" : (c.off[a] ?? []).includes(cap) ? `off for ${NAMES[a]}` : CAP_DETAIL[cap] ?? "" })),
      "space switch · ← or enter back · q quit · only narrows: what's off for every agent stays off", { back: true });
    c.off[a] = CAPS.filter((cap, i) => c.caps[cap] && own.rows[i]!.kind === "box" && !(own.rows[i] as { on: boolean }).on);
  }
  const rows: Row[] = [
    ...CAPS.map((cap): Row => ({ kind: "box", label: CAP_LABEL[cap], detail: CAP_DETAIL[cap] ?? "", on: c.caps[cap] })),
    { kind: "choice", label: "New work may run with", options: RUNTIME_MODES.map((m) => CEILING_LABEL[m]), index: RUNTIME_MODES.indexOf(c.ceiling) },
  ];
  const got = await checklist("What 10 & 2 may do (each only after you hear it read back and say yes)", rows, "space switch · ←→ change · enter continue · q quit");
  CAPS.forEach((cap, i) => { const r = got.rows[i]!; if (r.kind === "box") c.caps[cap] = r.on; });
  const last = got.rows.at(-1)!;
  if (last.kind === "choice") c.ceiling = RUNTIME_MODES[last.index]!;
  return c;
}
