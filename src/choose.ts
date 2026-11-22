// Choosing which coding agents to connect and what Driver may do with them: setup's two screens and `10and2 agents`
// (docs/launch/mockups/connector-setup). What's chosen becomes the policy's `actions`, `steer`, `answer`,
// `maxRuntimeMode` and `agents`; this file turns one into the other, and parses the flags for doing it without a terminal.
import type { ActionKind } from "./contract.ts";
import { AGENTS, DOCUMENT_MODES, GUARD_MAX, RULES, RUNTIME_MODES, type Agent, type DocumentAccess, type Rules, type RuntimeMode } from "./policy.ts";
import { describeFound, NAMES, ORDER, type Found } from "./agents.ts";
import { ask, checklist, cmd, type Row } from "./ui.ts";
import { versionAtLeast } from "./claude/registry.ts";

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
/** What sends and starts set up for later may do here (the policy's `rules`, docs/launch/engine.md §5), as read. */
export const RULES_LABEL: Record<Rules, string> = { off: "nothing", send: "send messages", start: "send messages and start threads" };
/** Whether linked prose documents may be read from this computer (`policy.documents`), as read. */
export const DOCUMENTS_LABEL: Record<DocumentAccess, string> = { off: "off", project: "project folders", all: "project and plan folders" };

export type Choice = {
  on: Record<Agent, boolean>;
  caps: Record<Cap, boolean>;
  ceiling: RuntimeMode;
  /** Per agent, the capabilities switched off for it alone. */
  off: Partial<Record<Agent, Cap[]>>;
  /** What a send or start set up for later may do when this computer runs it: `send` until its owner chooses. */
  rules: Rules;
};

const TIDY: ActionKind[] = ["settle", "snooze", "archive"];
const actionsOf = (caps: Record<Cap, boolean>): ActionKind[] =>
  [...(caps.follow_up ? ["follow_up" as const] : []), ...(caps.tidy ? TIDY : []), ...(caps.start_work ? ["start_work" as const] : [])];

/** The choice a policy file holds (raw JSON, as written; the older top-level booleans too). */
export function choiceOf(raw: any): Choice {
  const actions: string[] = Array.isArray(raw?.actions) ? raw.actions : [];
  const on: Record<Agent, boolean> = { t3: raw?.t3 ?? true, claude: !!raw?.claude, codex: !!raw?.codex, opencode: !!raw?.opencode, pi: !!raw?.pi, gemini: false, copilot: false, cursor: !!raw?.cursor };
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
    rules: RULES.includes(raw?.rules) ? raw.rules : "send",
  };
}

/**
 * Everything allowed, every agent found on: what setup offers first, and what applies off a terminal. Threads started
 * later are the one thing not offered on: messages for later are, and starting threads later is turned on here by hand.
 */
export function defaultChoice(found: Found[]): Choice {
  const on = Object.fromEntries(AGENTS.map((a) => [a, found.find((f) => f.agent === a)?.installed ?? false])) as Record<Agent, boolean>;
  return { on, off: {}, caps: { follow_up: true, steer: true, answer: true, start_work: true, tidy: true }, ceiling: "full-access", rules: "send" };
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

/**
 * The policy fields a choice writes; the older top-level agent booleans are dropped for `agents`. `rules` only when it
 * isn't `send`, what a file without it means, so a file stays as it was until its owner chooses otherwise.
 */
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
  return { actions: actionsOf(c.caps), steer: c.caps.steer, answer: c.caps.answer, maxRuntimeMode: c.ceiling, agents, ...(c.rules !== "send" ? { rules: c.rules } : {}) };
}

/** Writes a choice over an existing policy object (brain, projects, worktreeBase, documents stay). */
export function applyChoice(policy: Record<string, unknown>, c: Choice): Record<string, unknown> {
  const out = { ...policy };
  for (const a of AGENTS) delete out[a];
  delete out.rules;
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
  const lines = [`10 & 2 can reach ${list(reach)}${offFound.length ? ` (${list(offFound)} ${offFound.length === 1 ? "is" : "are"} off)` : ""}, and can ${all.length ? `${list(all)}: each only after you hear it read back and say yes.` : "only read."}`];
  for (const a of ORDER) {
    const off = (c.off[a] ?? []).filter((cap) => c.on[a] && c.caps[cap]);
    if (off.length) lines.push(`For ${NAMES[a]}: ${off.map((cap) => "no " + ({ follow_up: "follow-ups", steer: "steering", answer: "answering", start_work: "new work", tidy: "tidying" })[cap]).join(", ")}.`);
  }
  // Set up for later: said only where it can do something, follow-ups (and new work, for starting threads) being on.
  const starts = c.rules === "start" && c.caps.start_work;
  if (c.caps.follow_up && c.rules !== "off") lines.push(`What you set up for later in a call, it ${starts ? "sends or starts" : "sends"} at its time, from this computer.`);
  else if (starts) lines.push("New work you set up for later in a call, it starts at its time, from this computer.");
  return lines;
}

/**
 * The flags that choose without a terminal: `--agents=claude,pi` (only these), `--off=codex`, `--no-steer`,
 * `--no-answer`, `--no-start`, `--read-only`; `--no-steer=codex` and the like narrow one agent. Names are split on
 * commas or spaces (PowerShell hands npm's script `--agents=claude,pi` as "--agents=claude pi"). Unknown names throw,
 * and so does `--agents` naming one that wasn't found.
 */
export function applyFlags(c: Choice, flags: Map<string, string>, found: Found[]): Choice {
  const names = (v: string) => v.split(/[\s,]+/).filter(Boolean).map((s) => {
    if (!AGENTS.includes(s as Agent)) throw new Error(`There's no agent called "${s}" (${AGENTS.join(", ")}).`);
    return s as Agent;
  });
  const out: Choice = { on: { ...c.on }, caps: { ...c.caps }, ceiling: c.ceiling, off: Object.fromEntries(Object.entries(c.off).map(([k, v]) => [k, [...v!]])), rules: c.rules };
  if (flags.has("agents")) {
    const only = names(flags.get("agents")!);
    const missing = only.filter((a) => !found.find((f) => f.agent === a)?.installed).map((a) => NAMES[a]);
    const [them, were] = missing.length === 1 ? ["it", "wasn't"] : ["them", "weren't"];
    if (missing.length) throw new Error(`${list(missing)} ${were} found on this computer, so 10 & 2 can't connect ${them}. Install ${them}, or leave ${them} out of ${cmd("--agents")}.`);
    for (const a of AGENTS) out.on[a] = only.includes(a);
  }
  if (flags.has("off")) for (const a of names(flags.get("off")!)) out.on[a] = false;
  if (flags.has("read-only")) for (const cap of CAPS) out.caps[cap] = false;
  if (flags.has("later")) {
    const v = flags.get("later")!;
    if (!RULES.includes(v as Rules)) throw new Error(`--later takes ${RULES.join(", ")}.`);
    out.rules = v as Rules;
  }
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
  const c: Choice = { ...start, on: { ...start.on }, caps: { ...start.caps }, off: { ...start.off }, rules: start.rules };
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
    { kind: "choice", label: "Set up for later, it may", options: RULES.map((r) => RULES_LABEL[r]), index: RULES.indexOf(c.rules) },
  ];
  const got = await checklist("What 10 & 2 may do (each only after you hear it read back and say yes)", rows, "space switch · ←→ change · enter continue · q quit");
  CAPS.forEach((cap, i) => { const r = got.rows[i]!; if (r.kind === "box") c.caps[cap] = r.on; });
  const ceiling = got.rows.at(-2)!, later = got.rows.at(-1)!;
  if (ceiling.kind === "choice") c.ceiling = RUNTIME_MODES[ceiling.index]!;
  if (later.kind === "choice") c.rules = RULES[later.index]!;
  return c;
}

/**
 * Commands that wait (docs/launch/engine.md §11 stage 4; Fable's 4-H1, for Jordan to see once before it ships): the
 * groups `10and2 agents` and setup offer, each a few patterns over the commands a Bash call runs (guard.ts `guarded`,
 * which reads a `git push` for where it pushes), and whether it's ticked when the list is first chosen at a computer.
 * Nothing is on until its owner chooses there: no group is ever added by an update.
 */
export const WAIT_GROUPS: { label: string; detail: string; patterns: string[]; ticked: boolean }[] = [
  { label: "Force pushes", detail: "git push --force, -f or +branch, and deleting a branch there", patterns: ["git push*--force*", "git push* -f*"], ticked: true },
  { label: "Terraform", detail: "terraform or tofu apply, destroy", patterns: ["terraform apply*", "terraform destroy*", "tofu apply*", "tofu destroy*"], ticked: true },
  { label: "Database resets", detail: "prisma migrate reset, prisma db push --force-reset, dropdb, db:drop, db:reset",
    patterns: ["prisma migrate reset*", "prisma db push*--force-reset*", "dropdb *", "* db:drop*", "* db:reset*"], ticked: true },
  { label: "Publishing a package", detail: "npm, pnpm, yarn or bun publish, cargo publish, gem push",
    patterns: ["npm publish*", "pnpm publish*", "yarn npm publish*", "yarn publish*", "bun publish*", "cargo publish*", "gem push *"], ticked: true },
  // Not ticked: people who land on main all day would stall every agent (Fable's 4-H1). A `jj git push` that names no
  // bookmark (its default revisions, `--all`) isn't seen, nor is one of a bookmark jj rewrote, which jj pushes as a
  // force push (with a lease): the command doesn't say either (engine.md, "Stage 4's final review").
  { label: "Pushes to main or master", detail: "git push, named or not, and jj git push to main",
    patterns: ["git push* main", "git push* main *", "git push* master", "git push* master *", "git push*--all*", "git push*--mirror*", "jj git push* main", "jj git push* main *", "jj git push*-b main*", "jj git push*--bookmark main*",
      "jj git push*--bookmark=main", "jj git push*--bookmark=main *", "jj git push*-b=main", "jj git push*-b=main *"], ticked: false },
];

/** The words the screen says (Fable's 4-H1), never "can't". */
export const WAIT_WORDS = {
  heading: "Commands that wait",
  intro: "An agent that runs one of these waits until you let it run from your phone. Everything else runs as before.",
  /** With a work system on that doesn't hold them (stage 4's review): which one does. */
  claude: "Claude Code waits when it runs one of these, until you let it run from your phone. Everything else runs as before.",
  misses: "Seen as written, in the forms agents use. A command run through an alias, a script or another program isn't seen.",
  phone: "Your phone shows each one on its thread. Road Trip and Long Haul also send a notification.",
  own: "Add your own",
  ownHint: "like npm run deploy:prd",
} as const;

/**
 * The screen's first line: with only Claude Code on, as Fable wrote it; with Codex, OpenCode, Pi, Gemini CLI, Copilot
 * CLI, Cursor or T3 Code on too, it says Claude Code is the one that waits, and which run them without waiting (T3
 * Code's Claude threads wait; its others don't): the hold is Claude Code's PreToolUse hook (claude/hooks.ts).
 */
export function waitIntro(on: Readonly<Record<Agent, boolean>>): string {
  const others = [
    ...(on.codex ? ["Codex"] : []), ...(on.opencode ? ["OpenCode"] : []), ...(on.pi ? ["Pi"] : []), ...(on.gemini ? ["Gemini CLI"] : []), ...(on.copilot ? ["Copilot CLI"] : []),
    ...(on.cursor ? ["Cursor"] : []), ...(on.t3 ? ["T3 Code's other threads"] : []),
  ];
  if (!others.length) return WAIT_WORDS.intro;
  const named = others.length === 1 ? others[0] : `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
  const [waits, rest] = WAIT_WORDS.claude.split(". ");
  return `${waits}${on.t3 ? ", in T3 Code too" : ""}. ${named} ${others.length === 1 && !on.t3 ? "runs" : "run"} them without waiting. ${rest}`;
}

/**
 * The oldest Claude Code whose sessions already open when the list is added pick it up (measured in the harness:
 * docs/launch/agent-versions.md, "Commands that wait"); an older one's open sessions hold commands only once they're
 * started again.
 */
export const HOLDS_OPEN_FROM = "2.1.319";

/** Said once the list is chosen, for a Claude Code older than `HOLDS_OPEN_FROM`; null otherwise. */
export function openSessionsNote(version: string | null): string | null {
  return version && !versionAtLeast(version, HOLDS_OPEN_FROM) ? "Claude Code sessions open now hold these once they're started again." : null;
}

/** Each group's tick as `current` has it: on when every pattern of it is there; with nothing chosen yet (`null`), as offered. */
export function waitTicks(current: readonly string[] | null): boolean[] {
  return WAIT_GROUPS.map((g) => (current === null ? g.ticked : g.patterns.every((p) => current.includes(p))));
}

/** The patterns of the user's own: everything not in a group. */
export function ownPatterns(current: readonly string[]): string[] {
  const grouped = new Set(WAIT_GROUPS.flatMap((g) => g.patterns));
  return current.filter((p) => !grouped.has(p));
}

/**
 * The list with the groups ticked in `on` (by index), the user's own kept as they were and `added` after. Never cut: one
 * over 50 isn't saved (`tooManyWaiting` says so on the screen), so nothing ticked is quietly left out.
 */
export function guardWith(current: readonly string[], on: readonly boolean[], added: readonly string[] = []): string[] {
  return [...new Set([...ownPatterns(current), ...added.map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean),
    ...WAIT_GROUPS.flatMap((g, i) => (on[i] ? g.patterns : []))])];
}

/**
 * What the screen says when the list chosen is longer than a computer keeps (policy.ts `GUARD_MAX`); null when it fits.
 * It says what's counted: patterns, not the boxes ticked (Fable's nit on stage 4's fix4).
 */
export const tooManyWaiting = (list: readonly string[]) =>
  list.length > GUARD_MAX ? `That's ${list.length} patterns, and a computer keeps at most ${GUARD_MAX}. Untick a group, or add fewer of your own.` : null;

/** How many kinds are on, as `10and2 status` counts them: each group whole, and each pattern of the user's own. */
export function waitKinds(current: readonly string[]): number {
  return waitTicks(current).filter(Boolean).length + ownPatterns(current).length;
}

/**
 * The screen, at a terminal: the groups as boxes (ticked as `waitTicks`), and Add your own, which asks for one command
 * at a time. `current` null: the computer has never chosen. Returns the list to save. `io`: the terminal's own unless a
 * test gives one.
 */
export async function chooseWaiting(current: readonly string[] | null, agents: Readonly<Record<Agent, boolean>>,
  io: { checklist: typeof checklist; ask: typeof ask; say: (s: string) => void } = { checklist, ask, say: (s) => console.log(s) }): Promise<string[]> {
  const own = ownPatterns(current ?? []);
  let ticks = waitTicks(current);
  // Those typed in, kept when the list was too long and it asks again (the code review's nit on fix4): Add your own
  // comes back ticked with them counted, to add more; unticked, they're dropped.
  let added: string[] = [];
  for (;;) {
    const mine = own.length + added.length;
    const rows: Row[] = [
      ...WAIT_GROUPS.map((g, i): Row => ({ kind: "box", label: g.label, detail: g.detail, on: ticks[i]! })),
      { kind: "box", label: WAIT_WORDS.own, detail: mine ? `${mine} of your own · ${WAIT_WORDS.ownHint}` : WAIT_WORDS.ownHint, on: added.length > 0 },
    ];
    io.say(`\n  ${WAIT_WORDS.heading}`);
    const got = await io.checklist(waitIntro(agents), rows, `space switch · enter continue · q quit · ${WAIT_WORDS.misses}`);
    ticks = WAIT_GROUPS.map((_, i) => got.rows[i]!.kind === "box" && (got.rows[i] as { on: boolean }).on);
    if (!(got.rows.at(-1) as { on: boolean }).on) added = [];
    else {
      for (;;) {
        const p = await io.ask(`A command that waits, as an agent would run it, * for any text (${WAIT_WORDS.ownHint}); Enter when done`, "");
        if (!p.trim()) break;
        added.push(p);
      }
    }
    const list = guardWith(current ?? [], ticks, added);
    const tooMany = tooManyWaiting(list);
    if (!tooMany) return list;
    // Too many to keep: said, and asked again, with nothing saved meanwhile.
    io.say(`  ${tooMany}`);
  }
}

/** The words the Linked documents screen shows in `10and2 setup`, `10and2 agents`, and `10and2 features`. */
export const DOCS_WORDS = {
  heading: "Linked documents",
  intro: 'Coding agents often finish with "I wrote the plan to plan.md" or link a design doc.',
  pitch: 'Turn this on so 10 & 2 can offer to read those docs aloud and answer questions while you drive — e.g. "Read the plan" or "What does the rollout section say?".',
  privacy: "Only markdown and text files linked by a reply are read, redacted before leaving this computer; code and .env files are never sent.",
  prompt: "Choose what 10 & 2 may read",
  project: { label: "Read linked documents", detail: "markdown & text files inside visible projects and worktrees" },
  plans: { label: "Include plan folders", detail: "~/.claude/plans, T3 artifacts, Copilot session plans" },
} as const;

/**
 * The Linked documents screen, at a terminal (`10and2 setup`, `10and2 agents`, `10and2 features`): prints the
 * explanation, spoken example and privacy note once above the checklist, then offers two toggles. `current` null
 * (never chosen yet): both start ticked so pressing Enter opts in, while unticking the first turns it off (`"off"`).
 * Headless / `--yes` never runs this and stays `"off"`.
 */
export async function chooseDocuments(
  current: DocumentAccess | null,
  io: { checklist: typeof checklist; say: (s: string) => void } = { checklist, say: (s) => console.log(s) },
): Promise<DocumentAccess> {
  const rows: Row[] = [
    { kind: "box", label: DOCS_WORDS.project.label, detail: DOCS_WORDS.project.detail, on: current === null ? true : current !== "off" },
    { kind: "box", label: DOCS_WORDS.plans.label, detail: DOCS_WORDS.plans.detail, on: current === null ? true : current === "all" },
  ];
  io.say(`\n  ${DOCS_WORDS.heading}`);
  io.say(`  ${DOCS_WORDS.intro}`);
  io.say(`  ${DOCS_WORDS.pitch}`);
  io.say(`  ${DOCS_WORDS.privacy}\n`);
  const got = await io.checklist(DOCS_WORDS.prompt, rows, "space switch · enter continue · q quit");
  const project = got.rows[0]!.kind === "box" && got.rows[0]!.on;
  const plans = got.rows[1]!.kind === "box" && got.rows[1]!.on;
  return !project ? "off" : plans ? "all" : "project";
}
