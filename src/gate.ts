// Commands that wait (docs/launch/engine.md §11 stage 4, "Then"; spike/two-key-hold; Fable's 4-H1 to 4-H3): a Bash
// command on this computer's list (policy.ts `guard`), held by Claude Code's PreToolUse hook (claude/hooks.ts) until a
// tap on the phone lets it run, or it's stopped. The hook waits on its socket; the adapter that owns the session holds
// it (the Claude adapter for a terminal or IDE session, the T3 adapter for a T3 Code thread run by Claude) and reports
// the thread as holding "<command>", with `gate` and its own `questionId`.
//
// Letting it run is its own path (`answer_hold`, `Gates.answer`): never a follow-up. A follow-up's words that would let
// it run (from an answer button, a quick reply, a typed line, a schedule or a spoken yes) are refused and it stays held;
// any other words stop it, and the agent is told them. 10 & 2 never allows anything: a release only hands the command
// back to the agent's own permission mode, so in ask-first it still asks at the computer.
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { Action, Receipt, Report } from "./contract.ts";
import { maskedSpans, redactText } from "./redact.ts";
import { ANSWERED } from "./util.ts";

/** How long a hold waits for the phone before the agent is told no: a minute short of Claude Code's 6-hour hook limit. */
export const GATE_MS = (21_600 - 60) * 1000;

/**
 * A held command: the hook's connection, its own question (`id`, new each hold), what it would run (the whole Bash call,
 * and the command on the list it matched), and since when.
 */
export type Gate = { socket: Socket; id: string; command: string; matched: string; since: string; thread: string; timer: NodeJS.Timeout };

// What the agent is told (the hook's deny reason; Fable's 4-H3, the spike's words kept where they exist).
export const GATE_STOPPED = "Not run: the user said no from their phone (10 & 2). Don't run it another way; tell them what you needed it for.";
export const gateSaid = (words: string) => `Not run: the user answered from 10 & 2, in their words: "${words.trim().slice(0, 500)}". Only a tap on their phone lets it run. Don't run it another way; tell them what you needed it for.`;
export const GATE_UNANSWERED = "Not run: the user didn't answer on their phone within 6 hours (10 & 2). Don't run it another way; tell them what you needed it for.";
export const GATE_NOT_SHOWN = "Not run: this command is on the user's list of commands 10 & 2 holds for their OK on their phone, and 10 & 2 doesn't show this session there. Don't run it another way; ask the user to run it themselves.";
export const GATE_NOT_ALLOWED = "Not run: this command is on the user's list of commands 10 & 2 holds for their OK on their phone, and this computer doesn't let 10 & 2 answer from there. Don't run it another way; ask the user to run it themselves.";
export const GATE_ONE_AT_A_TIME = "Not run: another command of this session is already held for the user's OK on their phone. Run this one once that's answered.";
export const GATE_GONE = "Not run: 10 & 2 stopped holding this command for the user's OK (it closed or restarted). Don't run it another way; ask the user, or try it once more later.";
/** A follow-up whose words would let it run: refused, and it stays held (the phone shows it after the tap, 4-H3). */
export const TAP_TO_RUN = "Nothing was sent. To let it run, tap Let it run in 10 & 2.";
/** Let it run, where this computer doesn't let 10 & 2 answer that work system (a hold there is stopped at once anyway). */
export const NOT_ANSWERING = "This computer doesn't let 10 & 2 answer from your phone, so nothing was let run.";
/** An answer to a hold that has ended (answered, stopped at the computer, the session gone). */
export const NO_LONGER = "No longer waiting, so nothing was sent.";

/**
 * Words that would let a held command run, which only the release path may: refused, and it stays held. The brain
 * refuses the same words before any readback (brain/src/held-lines.ts `letsRun`, the same words; test/gate.test.ts holds
 * them equal): only a yes or a "let it run", with nothing after it but more of the same or a word that adds nothing;
 * any other words stop it, with them.
 */
export const letsRun = (words: string) => LETS_RUN.test(words.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim());
/**
 * What opens words that would let it run: a yes, or asking for it to run ("i approve", "please let it run", "you can
 * let it run", "let that run", "that's fine": Fable's should on fix4, as people agree out loud; "alright", "just do it",
 * "it's okay": Fable's nit on fix5). Never "let it go", which drops it: words for the thread.
 */
const LET_OPENS = "yes|yeah|yep|yup|sure|ok|okay|alright|all right|fine|go|go ahead|go on|go for it|let's go|do it|just do it|do that|start|approve|approved|approve it|i approve|proceed|sounds good|looks good|ship it|that works|let it(?! go(?! ahead| on))|let it run|let that run|run it|run that|allow|allow it|carry on|release|release it|please|you can|that's fine|it's fine|it's ok|it's okay|that's ok|that's okay|for sure|all good|of course|definitely|absolutely";
/**
 * What may follow it and still only agree: another of those, or a word that adds nothing ("no worries", "for sure", "i'm
 * sure", "cool"). Never "never mind" alone, which calls it off (the skeptic's nit on fix4): "okay never mind" is words for
 * the thread, read back as stopping it.
 */
const LET_ADDS = `${LET_OPENS}|it|then|now|just|and|right away|thanks|thank you|no worries|no problem|no problems|never mind the warnings?|stop worrying|don't worry|don't worry about it|for sure|i'm sure|thing|cool|great|do|that|it's ok|it's okay|that's ok|that's okay`;
const LETS_RUN = new RegExp(`^(?:${LET_OPENS})(?: (?:${LET_ADDS}))*$`);

/** The most of a held command the phone shows (its card, its sheet from the notification): no more is ever held. */
export const SHOWN_MAX = 120;

/** The command as the phone shows it: credentials masked (redact.ts), its spaces collapsed, at most `SHOWN_MAX` characters. */
export function shownCommand(command: string): string {
  const s = redactText(command).replace(/\s+/g, " ").trim();
  return s.length > SHOWN_MAX ? `${s.slice(0, SHOWN_MAX - 1).trimEnd()}…` : s;
}

/**
 * Whether the phone shows all of a Bash call (`shownCommand` doesn't cut it): Let it run lets the whole call go, so one
 * longer than that is never held (claude/hooks.ts stops it at once), and the user sees everything they let run.
 */
export const shownWhole = (command: string) => redactText(command).replace(/\s+/g, " ").trim().length <= SHOWN_MAX;

/**
 * What a masked piece may not hold and still be one plain value: a space or a new line (another word: `token= -destroy`,
 * a private key's header and all after it), a quote or a backslash (the shell's own quoting, which the mask may not
 * follow: `"token='abc" -destroy "'"` is three words), shell code (`$(…)`, `;`, a pipe, a redirection), or what the shell
 * expands into more words: braces (`-{,var=token=-}{destroy,auto-approve}` runs `-destroy -auto-approve`, Fable's
 * blocker on fix4), and a wildcard or brackets (`-[,var=token=-]destroy` is `--destroy` where such a file is).
 */
const NOT_A_VALUE = /[\s"'\\$`;|&<>(){}[\]*?]/;
/** A `token=`, `password=` or `PGPASSWORD=` piece with its value in one pair of quotes: the quotes are the value's own. */
const QUOTED = /^(\w+=)(["'])(.*)\2$/;

/**
 * Whether the phone's masking hides more than a value (stage 4's reviews: a private key's BEGIN with no END masks the
 * rest of the call, `token="$(…)"` a command, `token= -destroy` or a quote the shell reads otherwise whole words): a
 * call with a masked piece that isn't one plain value is never held (claude/hooks.ts stops it at once), so what's shown
 * as [REDACTED] is only ever part of one word, and the user sees every word they let run.
 */
export const hidesCode = (command: string) => maskedSpans(command).some((span) => {
  const quoted = QUOTED.exec(span);
  return NOT_A_VALUE.test(quoted ? quoted[1]! + quoted[3]! : span);
});

/** What a held thread's item and report carry of it (brain/src/adapter.ts `Gate`): shown as the phone shows it. */
export const gateOf = (gate: Gate) => ({ command: shownCommand(gate.command), matched: shownCommand(gate.matched), since: gate.since });

/**
 * A held thread's report: what it would run, since when, and which hold it is (`questionId`, on its item). No `choices`:
 * a held command never gets answer buttons (Fable, 4-H2); an older brain sees a question with none, and its words can
 * only stop it.
 */
export const gateReport = (gate: Gate, rest: Omit<Report, "question" | "choices" | "gate">): Report =>
  ({ ...rest, question: `wants to run ${shownCommand(gate.command)}`, choices: null, gate: gateOf(gate) });

/** Why a follow-up can't go to a held command: words that would let it run, or a tap on an earlier one. Null: it stops it. */
export function gateRefusal(gate: Gate, action: Extract<Action, { kind: "follow_up" }>): string | null {
  if (letsRun(action.message)) return TAP_TO_RUN;
  if (action.questionId !== undefined && action.questionId !== gate.id) return ANSWERED;
  return null;
}

/** Ends a hold at once with `reply` (`{ release: true }`, or `{ stop }` with what the agent is told). True once the hook has it. */
function answerSocket(socket: Socket, reply: object): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    socket.once("close", () => { clearTimeout(timer); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
    if (socket.destroyed || !socket.writable) { clearTimeout(timer); resolve(false); return; }
    socket.end(JSON.stringify(reply) + "\n");
  });
}

/** Stops a command at once, with why, without holding it (a session nobody shows, one already held). */
export const stopGate = (socket: Socket, why: string) => { socket.end(JSON.stringify({ stop: why }) + "\n"); };

/** What `10and2 status` says of a hold (status.json, main.ts). */
export type HeldSummary = { command: string; thread: string; since: string };

/**
 * One adapter's held commands, by its own thread id, one at a time each. `changed`: the thread's view changed (held,
 * ended), so the adapter tells its watchers. Answers already given are kept by hold (bounded), so the brain sending the
 * same answer again (a retry) gets the same receipt and nothing is sent twice.
 */
export class Gates {
  private readonly held = new Map<string, Gate>();
  private readonly answered = new Map<string, { run: boolean; receipt: Receipt }>();
  private readonly opts: { log: (s: string) => void; changed: (id: string) => void; now?: () => number; timeoutMs?: number };

  constructor(opts: Gates["opts"]) { this.opts = opts; }

  get(id: string): Gate | undefined { return this.held.get(id); }
  has(id: string): boolean { return this.held.has(id); }
  ids(): string[] { return [...this.held.keys()]; }
  summary(): HeldSummary[] { return [...this.held.values()].map((g) => ({ command: shownCommand(g.matched), thread: g.thread, since: g.since })); }

  /**
   * Holds `command` (the command on the list it ran: `matched`) for thread `id` (titled `thread`), or null: one is held
   * there already (stopped by the caller).
   */
  hold(id: string, socket: Socket, command: string, matched: string, thread: string): Gate | null {
    if (this.held.has(id)) return null;
    socket.setTimeout(0);
    const gate: Gate = {
      socket, id: `g-${randomUUID()}`, command, matched: matched || command, thread, since: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
      // Claude Code kills a hook at its timeout, and a killed hook decides nothing (the command would run): told no first.
      timer: setTimeout(() => { if (this.end(id, gate)) { stopGate(socket, GATE_UNANSWERED); this.opts.log(`a held command of ${id} wasn't answered in time`); } }, this.opts.timeoutMs ?? GATE_MS),
    };
    gate.timer.unref?.();
    this.held.set(id, gate);
    // Esc in the terminal, an interrupt in T3, the session gone or the hook's own end: no longer held.
    socket.once("close", () => { if (this.end(id, gate)) this.opts.log(`a held command of ${id} ended at the computer`); });
    this.opts.log(`held a command of ${id} for the user's OK`);
    this.opts.changed(id);
    return gate;
  }

  private end(id: string, gate: Gate): boolean {
    if (this.held.get(id) !== gate) return false;
    this.held.delete(id);
    clearTimeout(gate.timer);
    this.opts.changed(id);
    return true;
  }

  /**
   * The release path's answer (`answer_hold`): Let it run hands it back to the agent's own permission mode (the hook
   * prints nothing); Stop it tells the agent no. Only for this hold's own id while it's held; the same answer again gets
   * the first one's receipt.
   */
  async answer(id: string, questionId: string, run: boolean): Promise<Receipt> {
    const earlier = this.answered.get(questionId);
    if (earlier) return earlier.run === run ? earlier.receipt : { ok: false, error: NO_LONGER };
    const gate = this.held.get(id);
    if (!gate || gate.id !== questionId) return { ok: false, error: NO_LONGER };
    this.end(id, gate);
    const passed = await answerSocket(gate.socket, run ? { release: true } : { stop: GATE_STOPPED });
    this.opts.log(`a held command of ${id} ${run ? "let run" : "stopped"} from the phone`);
    const receipt: Receipt = passed ? { ok: true } : { ok: false, unknown: true, error: "That command may have been answered at the computer already. 10 & 2 won't send it again." };
    this.answered.set(questionId, { run, receipt });
    if (this.answered.size > 100) this.answered.delete(this.answered.keys().next().value!);
    return receipt;
  }

  /** A follow-up's words to a held command (`gateRefusal` passed): it's stopped, and the agent is told them. */
  async stopWith(id: string, words: string): Promise<boolean> {
    const gate = this.held.get(id);
    if (!gate) return false;
    this.end(id, gate);
    const passed = await answerSocket(gate.socket, { stop: gateSaid(words) });
    this.opts.log(`a held command of ${id} stopped by the user's words`);
    return passed;
  }

  /** Stops thread `id`'s hold with `why` (nobody can answer it any more: archived, hidden). */
  drop(id: string, why: string) {
    const gate = this.held.get(id);
    if (gate && this.end(id, gate)) stopGate(gate.socket, why);
  }

  /** Closing: every hold is told no (the hook's own reason says 10 & 2 stopped holding it). */
  close() {
    for (const [id, gate] of [...this.held]) if (this.end(id, gate)) stopGate(gate.socket, GATE_GONE);
  }
}

/**
 * Where a held command of a session the Claude adapter doesn't list may be held instead: T3 Code's Claude threads
 * (t3/adapter.ts `claimGate`). It takes the socket and holds it (true), or says it isn't one of its threads (false).
 */
export type GateClaim = (session: string, socket: Socket, command: string, matched: string) => Promise<boolean>;
