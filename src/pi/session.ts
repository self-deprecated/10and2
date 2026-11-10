// A Pi session file, read incrementally into the little Driver needs. Format v3 (docs/session-format.md in Pi): the
// first line is a header `{type:"session",id,cwd,timestamp}`; every other line is an entry `{type,id,parentId,timestamp}`
// and the entries form a tree. The active branch is the parent chain up from the file's last entry, which is where Pi
// puts its leaf when it opens the session. Messages: `{type:"message",message:{role,content,stopReason?}}`.
import { openSync, closeSync, readSync, fstatSync } from "node:fs";
import type { ItemStatus, PastReply } from "../contract.ts";

/** A message's text: a string, or its text blocks joined. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("") : "";
}

const iso = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/** Long prompts and progress notes are cut; a finished reply is kept whole (it's what Driver reads out). */
const PROMPT_CHARS = 20_000, NOTE_CHARS = 4000;

/**
 * Every entry keeps only its parent, so the branch can be walked; messages keep what the briefing and reports read.
 * `u`: a user message (its words). `a`: an assistant message (how it stopped, its text). `t`: a tool result.
 */
type Node = { id: string; p: string | null; at: string | null } & ({ k: "u"; text: string } | { k: "a"; stop: string | null; text: string } | { k: "t" } | { k: "o" });

export type Projection = {
  status: ItemStatus;
  /** The last message waits on Pi (the user's words or a tool's result, with no reply yet). */
  unanswered: boolean;
  updatedAt: string | null;
  lastRunAt: string | null;
  wroteAt: string | null;
  progress: string | null;
  replies: PastReply[];
};

export class PiSession {
  readonly path: string;
  offset = 0;
  id: string | null = null;
  cwd: string | null = null;
  createdAt: string | null = null;
  version: number | null = null;
  name: string | null = null;
  firstPrompt: string | null = null;
  mtime = new Date(0).toISOString();
  /** The header was read and isn't a Pi session's. */
  invalid = false;
  private nodes = new Map<string, Node>();
  private last: string | null = null;
  private lines = 0;
  private tail = Buffer.alloc(0);
  private dropping = false;
  private inode: number | bigint | null = null;
  private cached: Projection | null = null;
  constructor(path: string) { this.path = path; }

  /** Reads what's new since the last read; with `limit`, stops once that many bytes of the file have been read. */
  read(limit = Infinity): void {
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return; }
    try {
      const st = fstatSync(fd);
      if ((this.inode !== null && this.inode !== st.ino) || st.size < this.offset) Object.assign(this, new PiSession(this.path));
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
            let entry: unknown;
            try { entry = JSON.parse(chunk.subarray(pos, end).toString("utf8")); } catch { entry = null; }
            this.apply(entry);
          }
          this.dropping = false;
          pos = end + 1;
        }
        this.tail = Buffer.from(chunk.subarray(pos));
        // Images and big tool output make long lines. An unfinished one is never kept without bound.
        if (this.tail.length > 16 * 1024 * 1024) { this.tail = Buffer.alloc(0); this.dropping = true; }
        this.cached = null;
      }
    } finally { closeSync(fd); }
  }

  apply(e: any): void {
    this.lines++;
    if (!e || typeof e !== "object") return;
    if (this.lines === 1) {
      if (e.type !== "session" || typeof e.id !== "string") { this.invalid = true; return; }
      this.id = e.id; this.cwd = typeof e.cwd === "string" ? e.cwd : null; this.createdAt = iso(e.timestamp);
      this.version = typeof e.version === "number" ? e.version : 1;
      return;
    }
    if (this.invalid) return;
    // Version 1 files have no ids: each entry follows the one before.
    const id = typeof e.id === "string" ? e.id : `#${this.lines}`;
    const parent = "parentId" in e ? (typeof e.parentId === "string" ? e.parentId : null) : this.last;
    const at = iso(e.timestamp);
    if (e.type === "session_info" && typeof e.name === "string") this.name = e.name.trim() || null;
    let node: Node = { id, p: parent, at, k: "o" };
    if (e.type === "message" && e.message && typeof e.message === "object") {
      const m = e.message;
      if (m.role === "user") {
        const text = textOf(m.content);
        node = { id, p: parent, at, k: "u", text: text.slice(0, PROMPT_CHARS) };
        if (this.firstPrompt === null && text.trim()) this.firstPrompt = text.slice(0, 500);
      } else if (m.role === "assistant") {
        const stop = typeof m.stopReason === "string" ? m.stopReason : null, text = textOf(m.content);
        node = { id, p: parent, at, k: "a", stop, text: stop === "stop" || stop === "length" ? text : text.slice(0, NOTE_CHARS) };
      } else if (m.role === "toolResult") node = { id, p: parent, at, k: "t" };
    }
    this.nodes.set(id, node);
    this.last = id;
  }

  /** The active branch, oldest first: the parent chain up from the last entry. */
  private branch(): Node[] {
    const out: Node[] = [], seen = new Set<string>();
    for (let id = this.last; id !== null && !seen.has(id);) {
      seen.add(id);
      const node = this.nodes.get(id);
      if (!node) break;
      out.push(node); id = node.p;
    }
    return out.reverse();
  }

  /** What the active branch says: how its latest run ended, and every finished run's reply with the words that started it. */
  get projection(): Projection {
    if (this.cached) return this.cached;
    let status: ItemStatus = "idle", unanswered = false, updatedAt: string | null = null, lastRunAt: string | null = null, wroteAt: string | null = null;
    let progress: string | null = null;
    let prompt: { id: string; text: string } | null = null;
    const replies = new Map<string, PastReply>();
    for (const node of this.branch()) {
      if (node.k === "o") continue;
      updatedAt = node.at ?? updatedAt;
      if (node.k === "u") {
        prompt = { id: node.id, text: node.text }; wroteAt = node.at;
        status = "idle"; unanswered = true; progress = null;
      } else if (node.k === "t") unanswered = true;
      else {
        unanswered = false;
        if (node.text.trim()) progress = node.text.slice(0, NOTE_CHARS);
        const outcome: ItemStatus | null = node.stop === "stop" || node.stop === "length" ? "completed" : node.stop === "error" ? "failed" : node.stop === "aborted" ? "cancelled" : null;
        if (outcome) {
          status = outcome; lastRunAt = node.at ?? lastRunAt; progress = null;
          if (outcome === "completed" && node.text.trim() && node.at) {
            const runId = prompt?.id ?? null;
            replies.set(runId ?? node.id, { runId, messageId: node.id, at: node.at, text: node.text, prompt: prompt?.text ?? null });
          }
        } else status = "idle";
      }
    }
    this.cached = { status, unanswered, updatedAt, lastRunAt, wroteAt, progress, replies: [...replies.values()].sort((a, b) => b.at.localeCompare(a.at)) };
    return this.cached;
  }
}
