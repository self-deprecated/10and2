import { openSync, closeSync, readSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { Checks, ItemStatus, PastReply } from "../contract.ts";
import { checksIn, fold, receipts, stepsOf, type OwnChecks, type Places, type Ran, type Step } from "../checks.ts";
import { iso, knownVersion } from "./registry.ts";
import { limited } from "../work.ts";
import { digestOf, newest, type Write } from "../typed.ts";

/** Claude Code's tools that change files: a check run before one of them is stale (stage 3.10). */
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Whether a folder is T3 Code's (under ~/.t3, or a T3 workspace's thread checkout); without regard to case on Windows. */
export function t3Cwd(cwd: string, platform: NodeJS.Platform = process.platform, home = homedir()): boolean {
  const path = platform === "win32" ? win32 : posix, key = (s: string) => platform === "win32" ? s.toLowerCase() : s;
  const p = key(path.resolve(cwd)), t3 = key(path.join(home, ".t3"));
  return p === t3 || p.startsWith(t3 + path.sep) || /[/\\]workspaces[/\\][^/\\]+[/\\]t3-[^/\\]+(?:[/\\]|$)/.test(p);
}

/**
 * The folder under projects/ where Claude Code keeps a working folder's transcripts: every character but a letter or a
 * digit made "-" (`/home/me/my_app` is `-home-me-my-app`, `C:\Users\me\proj` is `C--Users-me-proj`). Past 200
 * characters Claude Code cuts it and adds a hash of its own, so there it's null: find the session by its id instead.
 */
export function projectFolder(cwd: string): string | null {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length > 200 ? null : name;
}

export function typedUser(r: any): string | null {
  return r?.type === "user" && !r.isSidechain && !r.isMeta && !r.isCompactSummary && typeof r.message?.content === "string" ? r.message.content : null;
}
/**
 * Whether a person typed `r` (a `typedUser` record) in Claude Code's own terminal or app, which `typed` reports (the
 * engine's stage 3.9, ported from spike/away-watch: "yours at a computer"), by what the record says of itself, never its
 * words. Claude Code also writes as the user's what nobody typed: a background command's, Monitor's or agent's notice as
 * it finishes (`promptSource` "system", `origin.kind` "task-notification"), another session's message (`origin.kind`
 * "peer", as 10 & 2's own follow-ups reach a session through its inbox), a headless or SDK run's prompt (`promptSource`
 * "sdk": 10 & 2's own `claude -p`, a script's, T3 Code's), and a slash or shell command's output, which it marks by
 * wrapping it in its own tags. A record that says it came from anywhere but a person isn't counted; one from before
 * Claude Code said where its records came from counts unless it's one of those. A person's prompt is `promptSource`
 * "typed", "queued" (typed while Claude was busy, written once it takes it: the Skeptic on 3.10, Claude Code 2.1.321
 * in the harness) or "suggestion_accepted" (Claude Code's suggested prompt, sent by the person), as Claude Code itself
 * counts them. Each is counted as typed at this computer unless it says it was relayed from Slack or an email; a prompt
 * sent from Claude's app or claude.ai through Remote Control is written with the same marks as one typed (in 2.1.321's
 * binary, its bridge mark stays off the record), so it counts as at this computer too: a known limit (engine.md,
 * unmeasured: it needs the network).
 */
const PERSON_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);
export function personWrote(r: any): boolean {
  const content = typedUser(r);
  if (content === null) return false;
  if (r.promptSource !== undefined && !PERSON_SOURCES.has(r.promptSource)) return false;
  if ((r.origin?.kind ?? "human") !== "human" || (r.turnOrigin ?? "human") !== "human") return false;
  if (typeof r.entrypoint === "string" && /^(sdk|t3)/.test(r.entrypoint)) return false;
  return !/^\s*<(task-notification|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|cross-session-message)[\s>]/.test(content);
}
/**
 * Another session's message in this one, as 10 & 2's follow-ups reach an open session through its inbox (`origin.kind`
 * "peer", Claude Code 2.1.321 writing it `isMeta` with `promptSource` "system"; before it said where its records came
 * from, by its envelope): never a person's write (`personWrote`), but a run of its own for what it runs of its checks (the
 * Skeptic on 3.9 and 3.10: the follow-up's run had the previous run's tests and start).
 */
export function peerUser(r: any): boolean {
  if (r?.type !== "user" || r.isSidechain || r.isCompactSummary) return false;
  const content = r.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) return false;
  return r.origin?.kind === "peer" || (typeof content === "string" && /^(?:Another Claude session sent a message:\s*)?<cross-session-message[\s>]/.test(content));
}
/**
 * A top-level user record's words, as a first ask reads them: typed (`typedUser`), or the text blocks of one whose
 * content is a list (a message with a pasted image), never one carrying a tool's result.
 */
function userWords(r: any): string | null {
  const typed = typedUser(r), content = r?.message?.content;
  const words = typed ?? (r?.type === "user" && !r.isSidechain && !r.isMeta && !r.isCompactSummary && Array.isArray(content)
    && !content.some((b: any) => b?.type === "tool_result") ? textOf(r) : null);
  // The IDE's context (the file open in VS Code, a selection) that Claude Code adds beside the user's words, and drops
  // itself when it reads a prompt back.
  return words === null ? null : words.replace(IDE_CONTEXT, "").trim();
}
const IDE_CONTEXT = /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g;
/**
 * Whether a user record's words are the user's own ask: not a note Claude Code wrote itself (a background task's
 * notification: `origin` other than "human", `promptSource` "system"; its "[Request interrupted by user…]" marker), nor
 * a slash or shell command or its output.
 */
const ownAsk = (r: any, words: string) => (r.origin?.kind ?? "human") === "human" && r.promptSource !== "system"
  && !/^\s*(?:<(?:command-name|command-message|local-command-[a-z]+|bash-[a-z]+)>|\[Request interrupted by user)/.test(words);
const textOf = (r: any): string => Array.isArray(r.message?.content) ? r.message.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n") : "";
const later = (a: string | null, b: string | null) => !a ? b : !b ? a : a > b ? a : b;

export type Asked = { question: string; options: string[]; multiSelect: boolean };
/** An AskUserQuestion call's questions and option labels (descriptions and anything else dropped), or null. */
export function asked(tool: any): Asked[] | null {
  if (tool?.name !== "AskUserQuestion" || !Array.isArray(tool.input?.questions)) return null;
  const out = tool.input.questions.flatMap((q: any) => typeof q?.question !== "string" ? [] : [{
    question: q.question.slice(0, 2000), multiSelect: q.multiSelect === true,
    options: Array.isArray(q.options) ? q.options.map((o: any) => o?.label).filter((l: unknown): l is string => typeof l === "string").map((l: string) => l.slice(0, 500)) : [] }]);
  return out.length ? out : null;
}

/** Keeps only the projection Driver needs. Raw records and tool inputs never survive a parsing step. */
export class Transcript {
  readonly path: string;
  offset = 0;
  private tail = Buffer.alloc(0);
  private inode: number | bigint | null = null;
  private dropping = false;
  private topLevel = false;
  cwd: string | null = null;
  title: string | null = null;
  named = false;
  t3 = false;
  /** When the session started: its first record's time. */
  createdAt: string | null = null;
  /** The user's first own message (`ownAsk`), cut to its start and end (`limited`), and its time. */
  first: { text: string; at: string } | null = null;
  /** How the session was started, from its first record that says. */
  entrypoint: string | null = null;
  sidechain = false;
  unknown = false;
  updatedAt: string | null = null;
  mtime = new Date(0).toISOString();
  wroteAt: string | null = null;
  /** What a person typed in it (`personWrote`), newest last: `WorkItem.typed` (typed.ts). */
  writes: Write[] = [];
  /**
   * Prompts Claude Code queued as they were typed while it was busy (its `queue-operation` enqueue records: the words and
   * the time), until each is written: a queued prompt is written once Claude Code takes it, with that later time, so it's
   * dated by its enqueue (the Skeptic on 3.9 and 3.10).
   */
  private enqueued: { content: string; at: string }[] = [];
  /** A typed user record was seen: the next isn't the session's first. */
  private prompted = false;
  lastRunAt: string | null = null;
  outcome: ItemStatus = "idle";
  progress: string | null = null;
  /** The last tool Claude called in this turn; `done` once its result is in, so it isn't what the session waits on. */
  tool: { id: string | null; name: string; done?: true } | null = null;
  /**
   * What Claude asks with its AskUserQuestion tool while that's the last tool it called: each question and its options'
   * labels, the only tool input kept, since it's Claude asking the user something.
   */
  asking: Asked[] | null = null;
  /** When an AskUserQuestion was last answered (Claude Code writes the call and its result only once it is). */
  answeredAt: string | null = null;
  prompt: string | null = null;
  runId: string | null = null;
  /** The permission mode the session last ran with (a mode switch, or the user's latest message), if it says. */
  permissionMode: string | null = null;
  /** Prose document paths written via Write/Edit tools during the latest turn (for linked-doc discovery). */
  writtenDocs: string[] = [];
  private past = new Map<string, PastReply>();
  /**
   * Tests passed or failed (docs/launch/engine.md §11 stage 3.10): the current run's checks and edits in order (from its
   * Bash commands' exit codes, `checks.ts`), the Bash and edit calls still waiting for their results (only what they
   * are, never their input), and each reply's run's checks, by the same key as `past`.
   */
  private steps: Step[] = [];
  /**
   * Where the session's test runs stood when the current run started (`fold`), from every run before it: the transcript
   * is read from its start, so this is rebuilt from it each time, and goes with it.
   */
  private tested: Places = {};
  private calls = new Map<string, Ran | "edit">();
  private ran = new Map<string, Checks>();
  private readonly log: ((s: string) => void) | undefined;
  private readonly own: OwnChecks;
  constructor(path: string, log?: (s: string) => void, own: OwnChecks = {}) { this.path = path; this.log = log; this.own = own; }

  /** Reads what's new since the last read; with `limit`, stops once that many bytes of the file have been read. */
  read(limit = Infinity): void {
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return; }
    try {
      const st = fstatSync(fd);
      if ((this.inode !== null && this.inode !== st.ino) || st.size < this.offset) {
        // Rotation and truncation must discard old replies, titles and ownership evidence together.
        const fresh = new Transcript(this.path, this.log, this.own);
        Object.assign(this, fresh);
      }
      this.inode = st.ino;
      this.mtime = st.mtime.toISOString();
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < Math.min(st.size, limit)) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, st.size - this.offset), this.offset);
        if (!n) break;
        this.offset += n;
        const chunk = Buffer.concat([this.tail, buffer.subarray(0, n)]);
        let pos = 0, end: number;
        while ((end = chunk.indexOf(10, pos)) !== -1) {
          if (!this.dropping) {
            try { this.apply(JSON.parse(chunk.subarray(pos, end).toString("utf8"))); } catch { /* Unknown or malformed complete record. */ }
          }
          this.dropping = false;
          pos = end + 1;
        }
        this.tail = Buffer.from(chunk.subarray(pos));
        // API request blobs can be enormous. Do not retain an unbounded unfinished line.
        if (this.tail.length > 16 * 1024 * 1024) { this.tail = Buffer.alloc(0); this.dropping = true; }
      }
    } finally { closeSync(fd); }
  }

  apply(r: any): void {
    if (!r || typeof r !== "object") return;
    // Claude Code's shell's folder before this record: where a command whose result this is ran (each record has the
    // folder as it was when written, so a result's has the folder its command's `cd` left).
    const cwd = this.cwd;
    this.createdAt ??= iso(r.timestamp);
    if (r.isSidechain) { if (!this.topLevel) this.sidechain = true; return; }
    if (["user", "assistant"].includes(r.type)) { this.topLevel = true; this.sidechain = false; }
    if (typeof r.cwd === "string") { this.cwd = r.cwd; this.t3 ||= t3Cwd(r.cwd); }
    if (typeof r.entrypoint === "string" && this.entrypoint === null) this.entrypoint = r.entrypoint;
    // These are T3's injected system-instruction markers, not SDK entrypoint heuristics.
    if (["system", "user", "api-request", "api-request-blob"].includes(r.type)) {
      const encoded = JSON.stringify(r);
      this.t3 ||= /<t3_code_orchestration(?:_\d+)?[>\s]|## T3 Code orchestration/.test(encoded);
    }
    if (["user", "assistant", "system"].includes(r.type)) {
      if (r.version && !knownVersion(r.version, this.log)) { this.unknown = true; return; }
      this.unknown = false;
    }
    if (typeof r.permissionMode === "string" && (r.type === "permission-mode" || typedUser(r) !== null)) this.permissionMode = r.permissionMode;
    if (r.type === "agent-name" && typeof r.agentName === "string") { this.title = r.agentName; this.named = true; }
    if (r.type === "custom-title" && typeof r.customTitle === "string") { this.title = r.customTitle; this.named = true; }
    if (r.type === "ai-title" && !this.named && typeof r.aiTitle === "string") this.title = r.aiTitle;
    const at = iso(r.timestamp);
    if (!this.first) {
      const words = userWords(r), when = at ?? this.createdAt;
      if (words?.trim() && when && ownAsk(r, words)) this.first = { text: limited(words.trim()), at: when };
    }
    if (r.type === "queue-operation" && typeof r.content === "string" && at) {
      if (r.operation === "enqueue") this.enqueued = [...this.enqueued, { content: r.content, at }].slice(-20);
      else if (r.operation === "remove") this.enqueued = this.enqueued.filter((q) => q.content !== r.content);
    }
    const prompt = typedUser(r);
    if (prompt !== null) {
      const before = this.wroteAt;
      this.updatedAt = later(this.updatedAt, at); this.wroteAt = at;
      // Typed in its terminal or app at this computer, unless the record says it was relayed from Slack or an email
      // (`verifiedSlackHumanTurn`, `emailSenderTurn`: a person's, away from it). Remote Control, from Claude's app or
      // claude.ai, writes the same record as the terminal, as far as its binary shows: engine.md's known limits. A prompt
      // typed while it was busy, by when it was typed, not taken.
      const relayed = r.verifiedSlackHumanTurn === true || r.emailSenderTurn !== undefined;
      const enqueued = this.dequeue((q) => q === prompt, at);
      if (at && personWrote(r)) this.writes = newest([...this.writes, { at: r.promptSource === "queued" ? enqueued ?? (before && before < at ? before : at) : at, digest: digestOf(prompt), desk: !relayed, ...(!this.prompted ? { first: true } : {}) }]);
      this.prompted = true;
      this.prompt = prompt; this.runId = r.promptId ?? r.uuid ?? null;
      this.progress = null; this.tool = null; this.asking = null; this.outcome = "idle";
      this.nextRun();
      this.writtenDocs = [];
    } else if (peerUser(r)) {
      // 10 & 2's follow-up through the inbox starts a run: its checks, its start (`runningSince`) and its reply are its own.
      this.wroteAt = at ?? this.wroteAt; this.runId = r.promptId ?? r.uuid ?? this.runId;
      this.nextRun();
      this.writtenDocs = [];
      const content = r.message?.content;
      if (typeof content === "string") this.dequeue((q) => content.endsWith(q), at);
    }
    this.receipt(r, cwd);
    if (r.type === "assistant") {
      this.updatedAt = later(this.updatedAt, at);
      const text = textOf(r);
      if (text) this.progress = text;
      const content = Array.isArray(r.message?.content) ? r.message.content : [];
      for (const b of content) {
        if (b?.type === "tool_use" && (b.name === "Write" || b.name === "Edit") && typeof b.input?.file_path === "string"
          && /\.(?:md|markdown|mdx|txt|rst|adoc|org)$/i.test(b.input.file_path) && !this.writtenDocs.includes(b.input.file_path) && this.writtenDocs.length < 10) {
          this.writtenDocs.push(b.input.file_path);
        }
      }
      const tool = content.findLast((b: any) => b?.type === "tool_use" && typeof b.name === "string") ?? null;
      if (tool) { this.tool = { id: typeof tool.id === "string" ? tool.id : null, name: tool.name }; this.asking = asked(tool); }
      if (r.isApiErrorMessage || r.is_api_error_message || r.error) this.end("failed", at);
      else if (r.isAbortedMidStream) this.end("cancelled", at);
      else if (["end_turn", "stop_sequence", "refusal"].includes(r.message?.stop_reason)) {
        this.end("completed", at);
        if (text && at && typeof r.uuid === "string") {
          this.past.set(this.runId ?? r.uuid, { runId: this.runId, messageId: r.uuid, at, text, prompt: this.prompt });
          const checks = receipts(this.steps, this.tested);
          if (checks) this.ran.set(this.runId ?? r.uuid, checks); else this.ran.delete(this.runId ?? r.uuid);
        }
      } else this.outcome = "idle";
    }
    if (r.type === "user" && (r.interruptedMessageId || r.interruptedByShutdown)) this.end("cancelled", at);
    if (this.tool && r.type === "user" && Array.isArray(r.message?.content) && r.message.content.some((b: any) => b?.type === "tool_result" && b.tool_use_id === this.tool?.id)) this.tool.done = true;
    // A question's (or a plan's) answer, from the terminal or a hook, arrives as its tool result.
    if (["AskUserQuestion", "ExitPlanMode"].includes(this.tool?.name ?? "") && r.type === "user" && Array.isArray(r.message?.content)
      && r.message.content.some((b: any) => b?.type === "tool_result" && b.tool_use_id === this.tool?.id)) { this.asking = null; this.answeredAt = later(this.answeredAt, at ?? new Date().toISOString()); }
    if (r.type === "system" && ["turn_duration", "api_error", "stop_hook_summary"].includes(r.subtype)) {
      this.updatedAt = later(this.updatedAt, at);
      if (r.subtype === "api_error") this.end("failed", at);
    }
    if (["queue-operation", "pr-link"].includes(r.type)) this.updatedAt = later(this.updatedAt, at);
    if (r.type === "result") {
      if (typeof r.terminal_reason === "string" && r.terminal_reason.startsWith("aborted_")) this.end("cancelled", at);
      else if (r.is_error) this.end("failed", at);
    }
  }
  /**
   * The enqueue of a message Claude Code has now written (the oldest not yet taken whose words `match`), taken off the
   * list: its time is when a prompt queued (`promptSource` "queued") was typed. A queued prompt with none is dated no
   * later than the start of the run it waited behind (the previous prompt's time), never when Claude Code took it, which
   * can be the end of a 30-minute run.
   */
  private dequeue(match: (content: string) => boolean, at: string | null): string | null {
    const i = this.enqueued.findIndex((q) => match(q.content) && (!at || q.at <= at));
    return i >= 0 ? this.enqueued.splice(i, 1)[0].at : null;
  }
  private end(status: ItemStatus, at: string | null) {
    this.outcome = status; this.lastRunAt = later(this.lastRunAt, at); this.updatedAt = later(this.updatedAt, at);
    this.progress = null; this.tool = null; this.asking = null;
  }
  /**
   * Stage 3.10: a Bash call that's a check (`checksIn`, kept as what it runs, not its command) or an edit, and once its
   * result comes, its exit: `is_error` false is a clean exit; true with "Exit code N" (as Claude Code writes every
   * non-zero exit) a failure; anything else (a hook's refusal, a timeout, a command left in the background) says nothing.
   * Its output is read here for a failure (`verdictOf`) and dropped, and the folder it ran in is Claude Code's shell's
   * as its result came (`cwd`: where an earlier `cd` left it). Sidechains (subagents) never get here.
   */
  private receipt(r: any, cwd: string | null) {
    const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
    if (r.type === "assistant") {
      for (const b of blocks) {
        if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
        if (EDITS.has(b.name)) this.calls.set(b.id, "edit");
        else if (b.name === "Bash" && typeof b.input?.command === "string" && b.input.run_in_background !== true) {
          const ran = checksIn(b.input.command, this.own);
          if (ran) this.calls.set(b.id, ran);
        }
      }
    }
    if (r.type !== "user") return;
    for (const b of blocks) {
      const call = b?.type === "tool_result" ? this.calls.get(b.tool_use_id) : undefined;
      if (!call) continue;
      this.calls.delete(b.tool_use_id);
      if (call === "edit") { if (b.is_error !== true) this.steps.push("edit"); continue; }
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("\n") : "";
      const background = r.toolUseResult && typeof r.toolUseResult === "object" && (r.toolUseResult.backgroundTaskId || r.toolUseResult.interrupted || r.toolUseResult.timedOutAfterMs);
      const ok = background ? null : b.is_error === false ? true : b.is_error === true && /^Exit code [1-9]\d*/.test(text.slice(0, 40)) ? false : null;
      // Claude Code's own first line ("Exit code 1") isn't the command's: with nothing after it, the command printed nothing.
      this.steps.push(...stepsOf(call, ok, text.replace(/^Exit code \d+\n?/, ""), cwd));
    }
  }
  /** A new run: the one before it is where the session's test runs stand from now (`tested`). */
  private nextRun() {
    this.tested = fold(this.steps, this.tested).after;
    this.steps = []; this.calls.clear();
  }
  /** The current run's checks so far: while it's going, what "call me when API's tests pass" looks at. */
  get soFar(): Checks | undefined { return receipts(this.steps, this.tested); }
  /** The checks of the run `reply` ended, if it ran any. */
  checksOf(reply: Pick<PastReply, "runId" | "messageId">): Checks | undefined { return this.ran.get(reply.runId ?? reply.messageId); }
  replies(): PastReply[] { return [...this.past.values()].sort((a, b) => b.at.localeCompare(a.at)); }
  get reply(): PastReply | null { return this.replies()[0] ?? null; }
}
