// Moments the user flags for review by saying "debug" or "debug this" in a call: each becomes a file an agent can read
// to fix what went wrong, with the conversation around it and where its recordings and the phone's logs are.
import type { Files } from "./files.ts";
import type { Store } from "./store.ts";
import { Recordings } from "./voice/recording.ts";
import { describe } from "./util.ts";

/**
 * Filler before a command: "okay, debug this", and the sounds speech-to-text writes before one ("Hmm. Debug this",
 * "Tsk. Debug this": on 7 November neither flagged; "Also debug this", on 10 November, waited 6 s for the backend's flag).
 */
const LEAD = /^(?:(?:ok(?:ay)?|yeah|yes|yep|alright|all right|right|so|well|hey|driver|please|just|and|also|now|h+m+|m+h?m+|tsk|uh+|um+|er+|ah+|oh+)\b[\s,.!]*)*/i;
/** What may follow the keyword: "debug this", "flag that one", "mark it for review". */
const WHAT = String.raw`[\s,]+(?:(?:this|that|it)(?: one| moment| bit| part| conversation| call)?|for review)\b`;
/**
 * "Debug.", "debug this", "Driver, debug that: it didn't say the options", "flag this for review" yes; "debug the login
 * thread", "what's the debug flag" no. It must open a sentence of the turn (after any filler): "debug" alone or with
 * this/that/it/for review after it, "flag" and "mark" only with them, and with nothing more in the sentence: "Mark it
 * with a star" (answering a thread's question, 4 November) and "flag it as urgent" are about the thread. "Flag" alone
 * isn't one: on 2 November it was the end of "did you do a debug flag?", split into a turn of its own.
 */
const FLAG_COMMAND = new RegExp(String.raw`^(?:debug(?:[\s,.!:;-]*$|${WHAT})|(?:flag|mark)${WHAT}(?: for review)?[\s,.!:;-]*$)`, "i");
/**
 * How speech-to-text heard "debug" said on its own, on 2 November: "The bug", "De bug", "D bug". Only as the whole
 * turn: "the bug in the login thread" is about a bug.
 */
const MISHEARD = /^(?:the|de|d)[\s-]*bug[\s.!]*$/i;

/**
 * The user's words flag this moment for review: a sentence of the turn is the command ("Well, I'm waiting. Debug.",
 * 2 November), after any filler. Sentences end at . ! ? or ;, so "Hmm. Debug this" is two.
 */
export const asksToFlag = (said: string) => {
  const s = said.trim();
  return MISHEARD.test(s) || s.split(/(?<=[.!?;])\s*/).some((sentence) => FLAG_COMMAND.test(sentence.trim().replace(LEAD, "")));
};

/**
 * What the user said was wrong in the turn that flagged it, if anything: the words after the command, in its sentence
 * and the ones after ("Debug this, it said sent": "it said sent"), at least three of them. "Debug this again. Yeah,
 * debug this" and "Well, I'm waiting. Debug." say nothing, so Driver asks.
 */
export const issueIn = (said: string): string | null => {
  const sentences = said.trim().split(/(?<=[.!?;])\s*/).map((s) => s.trim().replace(LEAD, ""));
  const at = sentences.findIndex((s) => FLAG_COMMAND.test(s));
  if (at === -1) return null;
  const rest = [sentences[at].replace(FLAG_COMMAND, ""), ...sentences.slice(at + 1).filter((s) => !FLAG_COMMAND.test(s))]
    .join(" ")
    .replace(/^[\s,.:;!-]+/, "")
    .trim();
  return (rest.match(/[\w'’]+/g) ?? []).length >= 3 ? rest : null;
};

/**
 * `brainRev`, `phoneBuild`: what was running (unknown for a flag made after the fact: the recording's header says).
 * `issue`: what the user said went wrong, in their next turn, when Driver asked.
 */
export type Flag = { conversationId: string; sessionId: string; at: number; said: string; issue?: string; brainRev?: string; phoneBuild?: string | null; configVersion?: number | null };

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "–");
/** A file name that sorts by when the moment was: `20261102-071754-live_u0_Efgadp3o.md` (UTC). */
const fileName = (f: Flag) => `${new Date(f.at).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${f.sessionId.replace(/[^\w-]/g, "_").slice(0, 16)}.md`;

/**
 * Writes each flag to `files`' `flags/` (or `dir`) as Markdown when it's made, and again when its session ends (with the rest of the
 * conversation), pointing to the session recordings (`sessions/`) and phone logs (`phone-logs/`) that matter. Agents read
 * the folder; one done with a flag moves its file to `reviewed/`.
 */
export class Flags {
  private readonly files: Files;
  private readonly store: Store;
  private readonly log: (m: string) => void;
  private readonly dir: string;
  private readonly journal: boolean;
  private readonly open = new Map<string, Flag[]>();

  /**
   * `dir` is where among `files` the flags go: `flags` (demo mode's go in `demo-flags`). `journal: false` where the
   * brain keeps no journal (a Durable Object): the flag says its log lines are in the recordings instead.
   */
  constructor(files: Files, opts: { store: Store; log: (m: string) => void; dir?: string; journal?: boolean }) {
    this.files = files;
    this.dir = opts.dir ?? "flags";
    this.journal = opts.journal ?? true;
    this.store = opts.store;
    this.log = opts.log;
  }

  /** Flags a moment; the file is written at once. Never rejects: a flag that can't be written is logged, and null. */
  flag(f: Flag): Promise<string | null> {
    const list = this.open.get(f.sessionId) ?? [];
    list.push(f);
    this.open.set(f.sessionId, list);
    return this.write(f);
  }

  /**
   * What the user said went wrong, asked after the session's latest flag: added to that flag, which is written again.
   * Null when the session has no flag open, or the file can't be written.
   */
  explain(sessionId: string, issue: string): Promise<string | null> {
    const f = this.open.get(sessionId)?.at(-1);
    if (!f) return Promise.resolve(null);
    f.issue = issue;
    return this.write(f);
  }

  /** The session ended: its flags are written again with everything said in it. */
  finish(sessionId: string): Promise<unknown> {
    const written = Promise.all((this.open.get(sessionId) ?? []).map((f) => this.write(f)));
    this.open.delete(sessionId);
    return written;
  }

  /** Writes one flag's file; returns where it is. */
  async write(f: Flag): Promise<string | null> {
    try {
      const path = `${this.dir}/${fileName(f)}`;
      await this.files.write(path, await this.render(f));
      return this.files.where(path);
    } catch (e) {
      this.log(`flags: couldn't write the flag at ${iso(f.at)} (${describe(e)})`);
      return null;
    }
  }

  async render(f: Flag): Promise<string> {
    const sessions = this.store.sessionsOf(f.conversationId);
    const turns = this.store.turnsOf(f.conversationId);
    const from = sessions[0]?.startedAt ?? f.at;
    const until = Math.max(...sessions.map((s) => s.endedAt ?? Date.now()), f.at);
    const recorded = new Map((await this.files.list("sessions").catch(() => [])).map((r) => [r.path, r.size]));
    const recording = (id: string) => {
      const path = Recordings.path(id);
      const size = recorded.get(path);
      return `\`${this.files.where(path)}\` (${size === undefined ? "missing" : `${Math.round(size / 1024)} KB`})`;
    };
    // The phone's logs written to during the conversation (from 10 minutes before, to an hour after: they go every 30 s).
    const logs = (await this.files.list("phone-logs").catch(() => []))
      .filter((l) => l.at >= from - 600_000 && l.at <= until + 3600_000)
      .map((l) => this.files.where(l.path));
    // Before the user's turn that flagged it: the last thing they said by then.
    // A whole conversation flagged afterwards (from its start) is marked at the top.
    const last = turns.findLastIndex((t) => t.role === "user" && t.at <= f.at);
    const marked = last !== -1 ? last : turns.length && f.at <= turns[0].at ? 0 : turns.length;
    const lines = turns.map((t, i) => `${i === marked ? "\n**>>> FLAGGED HERE <<<**\n\n" : ""}- ${iso(t.at).slice(11, 19)} **${t.role === "user" ? "User" : "Voice"}:** ${t.text.replace(/\s+/g, " ")}`);
    if (marked === turns.length) lines.push("\n**>>> FLAGGED HERE <<<**");
    return [
      `# 10 & 2 flag: ${iso(f.at)}`,
      "",
      "The user flagged this moment for review (by saying \"debug\" in a call, or afterwards): something the voice did around here was wrong. Find out what, from the conversation below, the session recordings (every event, tool call and brain log line) and the phone's log, then fix it in this repository (`brain/` or `ios/`). Replay a recording as a test (`brain/README.md`, Session recordings). When done, move this file to `reviewed/` next to it, with a line at the end on what was found and changed.",
      "",
      "## What the user said",
      "",
      `> ${f.said.trim().replace(/\s+/g, " ")}`,
      "",
      ...(f.issue ? ["## What went wrong, in the user's words", "", "The voice asked what went wrong; this is the user's answer.", "", `> ${f.issue.trim().replace(/\s+/g, " ")}`, ""] : []),
      "## Where to look",
      "",
      `- Conversation \`${f.conversationId}\`; flagged in session \`${f.sessionId}\`.`,
      `- Running: brain \`${f.brainRev ?? "unknown"}\`, phone build \`${f.phoneBuild ?? "unknown"}\`${f.configVersion ? `, Ops settings version ${f.configVersion}` : ""}${f.brainRev ? "" : " (flagged after the fact: each recording's header has `brainRev` and `phoneBuild`)"}.`,
      `- Sessions in this conversation (UTC), with their recordings:`,
      ...sessions.map((s) => `  - \`${s.id}\`${s.id === f.sessionId ? " (flagged here)" : ""}: ${iso(s.startedAt).slice(11, 19)}–${iso(s.endedAt).slice(11, 19)}, ${s.endReason ?? "still open"}; ${recording(s.id)}`),
      `- The phone's logs from then: ${logs.length ? logs.map((p) => `\`${p}\``).join(", ") : "none found"}.`,
      this.journal
        ? `- The brain's journal: \`journalctl --user -u driver-brain --since "${iso(from - 60_000)}" --until "${iso(until + 60_000)}"\`.`
        : "- The brain's log lines: in each recording (`brain` events of type `log`). This brain runs in the cloud: `scripts/flags` downloads its flags with the recordings and phone logs they name.",
      "",
      "## The conversation",
      "",
      ...lines,
      "",
    ].join("\n");
  }
}

/**
 * `node src/flags.ts <driver.db> <conversation id> "<what was wrong>"`: flags a whole conversation after the fact, into
 * `$DRIVER_STATE/flags` (default: next to the database). Give it a copy of a live database: opening one migrates it.
 */
if (import.meta.main) {
  const [db, conversationId, ...words] = process.argv.slice(2);
  if (!db || !conversationId) {
    console.error('usage: node src/flags.ts <driver.db> <conversation id> "<what was wrong>"');
    process.exit(2);
  }
  const { Store } = await import("./store.ts");
  const { dirname } = await import("node:path");
  const store = new Store(db);
  const sessions = store.sessionsOf(conversationId);
  if (!sessions.length) {
    console.error(`no sessions in conversation ${conversationId}`);
    process.exit(1);
  }
  const { dirFiles } = await import("./files.ts");
  const flags = new Flags(dirFiles(process.env.DRIVER_STATE ?? dirname(db)), { store, log: console.error });
  const path = await flags.write({ conversationId, sessionId: sessions[0].id, at: sessions[0].startedAt, said: words.join(" ") || "Flagged after the fact." });
  console.log(path ?? "not written");
  process.exitCode = path ? 0 : 1;
}
