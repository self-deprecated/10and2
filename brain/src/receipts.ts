// Tests passed or failed (docs/launch/engine.md §11 stage 3.10; spike/run-receipts; Fable's decisions 3.10-A to 3.10-G,
// binding for words): what a run ran of its checks on the computer (its tests, a build, a lint) and how each ended, as
// the connector reads it from the work system's own record (exit codes, or a runner's summary read there), never from
// the agent's words. Here: what the brain (and the connector, before anything leaves the machine) accepts of it, what a
// pass is, and the fixed words it's said in. Pure.
import type { CheckRun, Checks, Report, WorkItem } from "./adapter.ts";

const KINDS = ["tests", "build", "lint"] as const;
const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10_000;

/**
 * Only what a receipt may carry, or undefined: an `ok`, two counts, a label of at most two short words (letters, digits
 * and `.-_:`, so no path or output fits), `stale` and `edited`. Anything else a machine sends is dropped.
 */
export function cleanChecks(v: unknown): Checks | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Checks = {};
  for (const k of KINDS) {
    const r = (v as Record<string, any>)[k];
    if (!r || typeof r !== "object" || typeof r.ok !== "boolean" || !count(r.runs) || !count(r.failed) || r.runs < 1 || r.failed > r.runs) continue;
    const label = typeof r.label === "string" ? r.label.trim().split(/\s+/).slice(0, 2).join(" ").slice(0, 32) : "";
    if (!/^[\w.:-]+(?: [\w.:-]+)?$/.test(label)) continue;
    out[k] = { ok: r.ok, runs: r.runs, failed: r.failed, label, ...(r.stale === true ? { stale: true as const } : {}), ...(r.edited === true ? { edited: true as const } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The run's last test run, or its last build with no failing test run, failed: what's never just "API replied". A lint alone never is. */
export function red(c: Checks | undefined): "tests" | "build" | null {
  return c?.tests?.ok === false ? "tests" : c?.build?.ok === false ? "build" : null;
}

/** Its last test run passed, with no file changed after it (3.10-A, rule 2: at the run's end). */
export const green = (c: Checks | undefined) => c?.tests?.ok === true && !c.tests.stale;

/**
 * Mid-run (3.10-A, rule 1): `green`, and a file was changed in this run before that test run, so it's a pass of the
 * agent's change, not a first run before it changed anything.
 */
export const greenAfterChange = (c: Checks | undefined) => green(c) && c?.tests?.edited === true;

/**
 * What a reply's tests say, decided once from its receipts (3.10-C to E): `pass` (the last test run passed with nothing
 * changed after it; `running`, mid-run), `failed` (its last test run failed; `stale`, it changed files after that),
 * `build` (no failing test run, its last build failed), and on a tests watch only, `untested` (its tests passed, then
 * it changed files without testing again), `none` (the connector reads its test runs and saw none in the run) and
 * `unknown` (they can't be read: its work system isn't covered, its connector is too old, the report couldn't be
 * read). `watch`: from a watch for its tests, so all of these are said.
 */
export type TestsFact = { state: "pass" | "failed" | "build" | "untested" | "none" | "unknown"; stale?: true; running?: true; watch?: true; run?: PassRun };

/**
 * A mid-run pass's run (the review of 45ec9eccdf6f, F6), kept with its fact (`TestsFact.run`): its id as the connector says it
 * (`Report.runningId`, the id its reply carries; none from a connector before it), and when its thread's last run had
 * ended as it passed (`after`, ms; 0 for none).
 */
export type PassRun = { id?: string; after: number };

/**
 * Whether a mid-run pass's run is over: its thread isn't running, or the run going now is another (`rep`'s
 * `runningId`, when both say), else a run of it has ended since (`lastRunAt` moved). Its thread's status alone isn't
 * it: another run may have begun. The run going now, when it's said, comes before `lastRunAt`, which can move while a
 * run goes on (OpenCode's is its last reply's time then; the skeptic on 7717d10f3219).
 */
export function passOver(run: PassRun | undefined, item: Pick<WorkItem, "status" | "lastRunAt">, rep?: Report | null): boolean {
  if (item.status !== "running") return true;
  if (!run) return false;
  if (run.id && rep?.runningId) return rep.runningId !== run.id;
  return (item.lastRunAt ? Date.parse(item.lastRunAt) : 0) > run.after;
}

/**
 * Whether report `rep`'s reply is the one that ended a mid-run pass's run: by its id; from a connector that doesn't say
 * it, the reply after the pass (a fact from before this change, any reply).
 */
export function passReplied(run: PassRun | undefined, rep: Report): boolean {
  if (!rep.reply) return false;
  if (run?.id) return rep.reply.runId === run.id;
  return !run || Date.parse(rep.reply.at) > run.after;
}

/**
 * A reply's tests fact. On a tests watch (`watch`), every case; `readable` false, `unknown`. Elsewhere (a plain
 * call-back, an only-trouble watch, following), only a failed last test run or build: anything else adds nothing, and
 * the reply is "API replied" as before (3.10-C, E).
 */
export function testsOf(c: Checks | undefined, o: { watch: boolean; readable: boolean; running?: boolean }): TestsFact | null {
  const bad = red(c);
  const stale = bad && c?.[bad]?.stale ? { stale: true as const } : {};
  if (!o.watch) return bad ? { state: bad === "tests" ? "failed" : "build", ...stale } : null;
  const w = { watch: true as const };
  if (!o.readable) return { state: "unknown", ...w };
  if (green(c)) return { state: "pass", ...(o.running ? { running: true as const } : {}), ...w };
  if (bad) return { state: bad === "tests" ? "failed" : "build", ...stale, ...w };
  return { state: c?.tests ? "untested" : "none", ...w };
}

/** "API's", or "Docs'" for a name ending in s (Fable, 3.10-B). */
export const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/**
 * The caller line (60 characters) and a notification's title, the same words (3.10-C), built from the fact: "API's
 * tests pass", "API replied, but its tests failed", "API replied, but its build failed", "API replied, untested since
 * its last change", "API replied, no test run seen", and "API replied" when they can't be read (the call says the rest).
 * Names hidden (`name` null): "A thread's tests pass", "A thread replied, but its tests failed", and so on.
 */
export function testsTitle(name: string | null, f: TestsFact): string {
  const who = name ?? "A thread";
  switch (f.state) {
    case "pass": return `${possessive(who)} tests pass`;
    case "failed": return `${who} replied, but its tests failed`;
    case "build": return `${who} replied, but its build failed`;
    case "untested": return `${who} replied, untested since its last change`;
    case "none": return `${who} replied, no test run seen`;
    case "unknown": return `${who} replied`;
  }
}

/** A mid-run pass's notification body (3.10-C): no reply yet, so none of its words. */
export const STILL_WORKING = "It's still working.";

/**
 * What a call-back about tests says first, word for word (3.10-D, A to H; unmeasured), then the voice carries on as
 * today. The same in a call and on hold. Never the runner's name, counts, lint, or anything from the reply.
 */
export function testsFirst(name: string, f: TestsFact): string {
  switch (f.state) {
    case "pass": return f.running ? `${possessive(name)} tests pass, and it's still working.` : `${possessive(name)} tests pass, and it has replied.`;
    case "failed": return f.stale ? `${name} replied. Its last test run failed, and it changed files after that without testing again.` : `${name} replied, but its last test run failed.`;
    case "untested": return `${name} replied. Its tests passed, but it changed files after that without testing again.`;
    case "none": return `${name} replied, but I didn't see it run any tests.`;
    case "unknown": return `${name} replied, but I can't see its test runs, so I can't tell if they pass.`;
    case "build": return `${name} replied, but its last build failed.`;
  }
}

const NOUNS: Record<(typeof KINDS)[number], string> = { tests: "test run", build: "build", lint: "lint run" };

/**
 * A run's checks as the voice is told them, one clause built in code (3.10-F): "its last test run failed (npm test, 2
 * of 3 runs failed); its last build passed (tsc), and it changed files after it". Null with none.
 */
export function checkFacts(c: Checks | undefined): string | null {
  const parts = KINDS.flatMap((k) => {
    const r: CheckRun | undefined = c?.[k];
    if (!r) return [];
    const tally = r.runs > 1 ? `, ${r.failed} of ${r.runs} runs failed` : "";
    return [`its last ${NOUNS[k]} ${r.ok ? "passed" : "failed"} (${r.label}${tally})${r.stale ? ", and it changed files after it" : ""}`];
  });
  return parts.length ? parts.join("; ") : null;
}

// --- Setting it up by voice (3.10-B): nothing is set up, and only this is said ---

/** Several threads named for one tests watch. */
export const ONE_THREAD_TESTS = "I can watch one thread's tests at a time. Which one?";

/** Its work system isn't covered: its test runs can't be read. */
export const cantSeeTests = (name: string) => `I can't see ${possessive(name)} test runs, so I can't watch for that. I can call you when it replies.`;

/** Its computer's 10 & 2 is too old to report them (an older connector says nothing either way). */
export const tooOldForTests = (computer: string, name: string) => `I can't see test runs on ${computer} until 10 & 2 is updated there. I can call you when ${name} replies.`;

/** Already true when asked: a pass after its change with nothing changed since, still working or not. */
export const passAlready = (name: string, working: boolean) => (working ? `${possessive(name)} tests pass already, and it's still working.` : `${possessive(name)} tests pass already.`);

/** A tests watch run out with the thread still working (3.10-C): its notification's body, before why. */
export const noPassAfter = (length: string) => `No passing test run after ${length}.`;
