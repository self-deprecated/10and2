import { openSync, closeSync, readSync, fstatSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { ItemStatus, PastReply } from "../contract.ts";
import { iso, knownVersion } from "./registry.ts";
import { limited } from "../work.ts";

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
  lastRunAt: string | null = null;
  outcome: ItemStatus = "idle";
  progress: string | null = null;
  tool: { id: string | null; name: string } | null = null;
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
  private past = new Map<string, PastReply>();
  private readonly log: ((s: string) => void) | undefined;
  constructor(path: string, log?: (s: string) => void) { this.path = path; this.log = log; }

  /** Reads what's new since the last read; with `limit`, stops once that many bytes of the file have been read. */
  read(limit = Infinity): void {
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return; }
    try {
      const st = fstatSync(fd);
      if ((this.inode !== null && this.inode !== st.ino) || st.size < this.offset) {
        // Rotation and truncation must discard old replies, titles and ownership evidence together.
        const fresh = new Transcript(this.path, this.log);
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
    const prompt = typedUser(r);
    if (prompt !== null) {
      this.updatedAt = later(this.updatedAt, at); this.wroteAt = at;
      this.prompt = prompt; this.runId = r.promptId ?? r.uuid ?? null;
      this.progress = null; this.tool = null; this.asking = null; this.outcome = "idle";
    }
    if (r.type === "assistant") {
      this.updatedAt = later(this.updatedAt, at);
      const text = textOf(r);
      if (text) this.progress = text;
      const tool = Array.isArray(r.message?.content) ? r.message.content.findLast((b: any) => b?.type === "tool_use" && typeof b.name === "string") : null;
      if (tool) { this.tool = { id: typeof tool.id === "string" ? tool.id : null, name: tool.name }; this.asking = asked(tool); }
      if (r.isApiErrorMessage || r.is_api_error_message || r.error) this.end("failed", at);
      else if (r.isAbortedMidStream) this.end("cancelled", at);
      else if (["end_turn", "stop_sequence", "refusal"].includes(r.message?.stop_reason)) {
        this.end("completed", at);
        if (text && at && typeof r.uuid === "string") this.past.set(this.runId ?? r.uuid, { runId: this.runId, messageId: r.uuid, at, text, prompt: this.prompt });
      } else this.outcome = "idle";
    }
    if (r.type === "user" && (r.interruptedMessageId || r.interruptedByShutdown)) this.end("cancelled", at);
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
  private end(status: ItemStatus, at: string | null) {
    this.outcome = status; this.lastRunAt = later(this.lastRunAt, at); this.updatedAt = later(this.updatedAt, at);
    this.progress = null; this.tool = null; this.asking = null;
  }
  replies(): PastReply[] { return [...this.past.values()].sort((a, b) => b.at.localeCompare(a.at)); }
  get reply(): PastReply | null { return this.replies()[0] ?? null; }
}
