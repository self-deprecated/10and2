// What an ACP agent's session says, once its own file format (gemini/session.ts, copilot/session.ts) is read into a list
// of messages: how its latest turn ended, every finished turn's reply with the words that started it, and its first ask.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ItemStatus, PastReply } from "../contract.ts";
import { limited } from "../work.ts";

/**
 * One message, as the projection needs it. `u`: the user's words. `a`: the agent's text; `final` when nothing else
 * follows in that turn (no tool call pending), which ends it. `t`: a tool call or its result, mid-turn. `e`: the turn
 * failed (`cancelled`: stopped by the user).
 */
export type Msg = { id: string; at: string | null } & ({ k: "u"; text: string } | { k: "a"; text: string; final: boolean } | { k: "t" } | { k: "e"; cancelled?: boolean });

export type Projection = {
  /** How the latest turn ended; "idle" while it hasn't (the caller says "running" when something has it open). */
  status: ItemStatus;
  /** The last message waits on the agent: the user's words or a tool's, with no final reply yet. */
  unanswered: boolean;
  updatedAt: string | null;
  lastRunAt: string | null;
  wroteAt: string | null;
  progress: string | null;
  replies: PastReply[];
  first: { text: string; at: string } | null;
};

const NOTE_CHARS = 4000;

export function project(messages: Msg[]): Projection {
  let status: ItemStatus = "idle", unanswered = false, updatedAt: string | null = null, lastRunAt: string | null = null, wroteAt: string | null = null;
  let progress: string | null = null, prompt: { id: string; text: string } | null = null, first: Projection["first"] = null;
  const replies = new Map<string, PastReply>();
  for (const m of messages) {
    updatedAt = m.at ?? updatedAt;
    if (m.k === "u") {
      prompt = { id: m.id, text: m.text }; wroteAt = m.at; status = "idle"; unanswered = true; progress = null;
      if (!first && m.text.trim() && m.at) first = { text: limited(m.text.trim()), at: m.at };
    } else if (m.k === "t") unanswered = true;
    else if (m.k === "e") { status = m.cancelled ? "cancelled" : "failed"; unanswered = false; lastRunAt = m.at ?? lastRunAt; progress = null; }
    else if (!m.final) { if (m.text.trim()) progress = m.text.slice(0, NOTE_CHARS); unanswered = true; }
    else {
      status = "completed"; unanswered = false; lastRunAt = m.at ?? lastRunAt; progress = null;
      if (m.text.trim() && m.at) {
        const runId = prompt?.id ?? null;
        replies.set(runId ?? m.id, { runId, messageId: m.id, at: m.at, text: m.text, prompt: prompt?.text ?? null });
      }
    }
  }
  return { status, unanswered, updatedAt, lastRunAt, wroteAt, progress, first, replies: [...replies.values()].sort((a, b) => b.at.localeCompare(a.at)) };
}

export const iso = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/**
 * A JSON-lines file read from where it was last read to, a whole line at a time: an agent appends to its session file
 * as it goes. A file that got shorter was rewritten, so it's read again from its start (`reset` says so).
 */
export class JsonLines {
  readonly path: string;
  offset = 0;
  private tail = Buffer.alloc(0);
  constructor(path: string) { this.path = path; }
  /** New records since the last read; `reset`: the file was rewritten, so these are all of it. */
  read(): { records: any[]; reset: boolean } {
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { return { records: [], reset: false }; }
    try {
      let reset = false;
      if (fstatSync(fd).size < this.offset) { this.offset = 0; this.tail = Buffer.alloc(0); reset = true; }
      const buffer = Buffer.alloc(256 * 1024), records: any[] = [];
      let n: number;
      while ((n = readSync(fd, buffer, 0, buffer.length, this.offset)) > 0) {
        this.offset += n;
        const bytes = Buffer.concat([this.tail, buffer.subarray(0, n)]);
        let pos = 0, end: number;
        while ((end = bytes.indexOf(10, pos)) !== -1) {
          try { records.push(JSON.parse(bytes.subarray(pos, end).toString("utf8"))); } catch { /* partial or not JSON */ }
          pos = end + 1;
        }
        this.tail = Buffer.from(bytes.subarray(pos));
        if (this.tail.length > 64 * 1024 * 1024) this.tail = Buffer.alloc(0);
      }
      return { records, reset };
    } finally { closeSync(fd); }
  }
}
