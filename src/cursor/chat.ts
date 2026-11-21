// One Cursor CLI chat, read from its own files without starting Cursor: `meta.json` beside its `store.db` (where it ran,
// its title, when it started and last changed) and its transcript, JSON lines Cursor writes as the chat goes:
//   {"role":"user"|"assistant","message":{"content":[{"type":"text","text":…},{"type":"tool_use","name":…,"input":…}]}}
//   {"type":"turn_ended","status":"success"|"error"|"aborted","error"?:…}
// The lines carry no ids, so a turn is known by its place in the file. The only times are the minute each message was
// sent, which Cursor puts before the words (`<timestamp>Saturday, Nov 21, 2026, 12:38 PM (UTC+1)</timestamp>`): the newest
// reply has the chat's own `updatedAtMs`, an older one the time its turn was asked. The conversation itself, in `store.db`, is Cursor's own protobuf and is never read.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ItemStatus, PastReply } from "../contract.ts";
import { limited } from "../work.ts";
import { transcriptPaths } from "./paths.ts";

export type Meta = { createdAtMs: number; updatedAtMs: number | null; hasConversation: boolean; isSubagent: boolean; title: string | null; cwd: string | null };

/** A chat's `meta.json`, as Cursor's own `ls` reads it; null when it's missing or not one. */
export function readMeta(chatDir: string): Meta | null {
  let m: any;
  try { m = JSON.parse(readFileSync(join(chatDir, "meta.json"), "utf8")); } catch { return null; }
  if (!m || typeof m !== "object" || typeof m.createdAtMs !== "number" || !Number.isFinite(m.createdAtMs)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    createdAtMs: Math.floor(m.createdAtMs), updatedAtMs: typeof m.updatedAtMs === "number" && Number.isFinite(m.updatedAtMs) ? Math.floor(m.updatedAtMs) : null,
    hasConversation: m.hasConversation === true, isSubagent: m.isSubagent === true, title: str(m.title)?.trim() || null, cwd: str(m.cwd),
  };
}

/** A message's text blocks, joined. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n") : "";
}
/** The user's own words: Cursor wraps what was typed in `<user_query>`, beside context it adds. */
export function asked(text: string): string {
  const q = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
  return (q ? q[1]! : text).trim();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The time in Cursor's `<timestamp>` tag, in ms; null when there's none it can read. */
export function sentAt(text: string): number | null {
  const m = /<timestamp>[^,<]*,\s*([A-Z][a-z]{2})[a-z]*\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC(?:([+-])(\d{1,2})(?::?(\d{2}))?)?\)\s*<\/timestamp>/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return null;
  const hour = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0), offset = (m[7] === "-" ? -1 : 1) * (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0));
  const ms = Date.UTC(Number(m[3]), month, Number(m[2]), hour, Number(m[5])) - offset * 60_000;
  return Number.isFinite(ms) ? ms : null;
}

/** Long prompts and progress notes are cut; a finished reply is kept whole (it's what 10 & 2 reads out). */
const PROMPT_CHARS = 20_000, NOTE_CHARS = 4000;

type Line = { k: "u"; text: string; at: number | null } | { k: "a"; text: string; tools: number } | { k: "end"; status: string };

export type Projection = {
  status: ItemStatus;
  /** The last turn started and hasn't ended in the transcript. */
  open: boolean;
  /** The user's messages so far: a turn is named by which one started it. */
  asks: number;
  progress: string | null;
  replies: PastReply[];
  /** The newest user words. */
  prompt: string | null;
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export class CursorChat {
  readonly id: string;
  readonly dir: string;
  meta: Meta | null = null;
  /** The transcript being read, once found. */
  path: string | null = null;
  first: string | null = null;
  private offset = 0;
  private tail = Buffer.alloc(0);
  private inode: bigint | null = null;
  /** The last bytes read, to tell a file rewritten in place from one that only grew. */
  private edge = Buffer.alloc(0);
  private lines: Line[] = [];
  private cached: Projection | null = null;
  constructor(id: string, dir: string) { this.id = id; this.dir = dir; }

  /** Reads `meta.json` again and what's new in the transcript. */
  read(dataDir: string): void {
    this.meta = readMeta(this.dir);
    const cwd = this.meta?.cwd;
    if (!cwd) return;
    if (!this.path) {
      for (const p of transcriptPaths(dataDir, cwd, this.id)) { try { closeSync(openSync(p, "r")); this.path = p; break; } catch { /* not there */ } }
      if (!this.path) return;
    }
    let fd: number;
    try { fd = openSync(this.path, "r"); } catch { this.path = null; return; }
    try {
      const st = fstatSync(fd, { bigint: true }), size = Number(st.size);
      // Cursor rewrites the whole file in place when a chat is resumed (dropping older turns' `turn_ended`), and at times
      // after a failed append: then it's read again from the start.
      let rewritten = (this.inode !== null && this.inode !== st.ino) || size < this.offset;
      if (!rewritten && this.edge.length) {
        const now = Buffer.alloc(this.edge.length);
        rewritten = readSync(fd, now, 0, now.length, this.offset - now.length) !== now.length || !now.equals(this.edge);
      }
      if (rewritten) { this.offset = 0; this.tail = Buffer.alloc(0); this.edge = Buffer.alloc(0); this.lines = []; this.first = null; this.cached = null; }
      this.inode = st.ino;
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < size) {
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - this.offset), this.offset);
        if (!n) break;
        this.offset += n;
        this.edge = Buffer.from(Buffer.concat([this.edge, buffer.subarray(0, n)]).subarray(-64));
        const chunk = Buffer.concat([this.tail, buffer.subarray(0, n)]);
        let pos = 0, end: number;
        while ((end = chunk.indexOf(10, pos)) !== -1) {
          let entry: unknown;
          try { entry = JSON.parse(chunk.subarray(pos, end).toString("utf8")); } catch { entry = null; }
          this.apply(entry);
          pos = end + 1;
        }
        this.tail = Buffer.from(chunk.subarray(pos));
        if (this.tail.length > 16 * 1024 * 1024) this.tail = Buffer.alloc(0);
        this.cached = null;
      }
    } finally { closeSync(fd); }
  }

  apply(e: any): void {
    if (!e || typeof e !== "object") return;
    if (e.type === "turn_ended") { this.lines.push({ k: "end", status: typeof e.status === "string" ? e.status : "success" }); return; }
    const content = e.message?.content;
    if (e.role === "user") {
      const raw = textOf(content), text = asked(raw);
      if (!text) return;
      this.lines.push({ k: "u", text: text.slice(0, PROMPT_CHARS), at: sentAt(raw) });
      this.first ??= limited(text);
    } else if (e.role === "assistant") {
      const uses = Array.isArray(content) ? content.filter((b: any) => b?.type === "tool_use") : [];
      // In plan mode the plan is a CreatePlan call, not text: it's what the turn has to say.
      const plan = uses.findLast((b: any) => b?.name === "CreatePlan" && typeof b.input?.plan === "string")?.input.plan as string | undefined;
      this.lines.push({ k: "a", text: (plan ?? textOf(content)).trim(), tools: uses.length });
    }
  }

  /** The user's words in their messages after the first `from`. */
  asksSince(from: number): string[] { return this.lines.flatMap((l) => (l.k === "u" ? [l.text.trim()] : [])).slice(from); }

  /** How the newest turn stands, and each finished turn's reply with the words that started it, newest first. */
  get projection(): Projection {
    if (this.cached) return this.cached;
    const updated = new Date(this.meta?.updatedAtMs ?? this.meta?.createdAtMs ?? 0).toISOString();
    const created = this.meta?.createdAtMs ?? 0;
    type Ask = { n: number; text: string; sent: number | null };
    let status: ItemStatus = "idle", open = false, progress: string | null = null, prompt: Ask | null = null, asks = 0;
    let reply: string | null = null;
    const done: { ask: Ask | null; text: string }[] = [];
    // Only the newest turn keeps its `turn_ended` once a chat is resumed: an older turn ended when the next was asked.
    const end = (outcome: ItemStatus) => {
      open = false; progress = null; status = outcome;
      if (outcome === "completed" && reply) done.push({ ask: prompt, text: reply });
      reply = null;
    };
    for (const l of this.lines) {
      if (l.k === "u") { if (open) end(reply ? "completed" : "idle"); prompt = { n: asks++, text: l.text, sent: l.at }; open = true; status = "idle"; progress = null; }
      else if (l.k === "a") { if (l.text) { reply = l.text; progress = l.text.slice(0, NOTE_CHARS); } }
      else if (open) end(l.status === "success" ? "completed" : l.status === "aborted" ? "cancelled" : "failed");
    }
    // Named by which of the user's messages started the turn, which a rewrite keeps, never by a line's place.
    const replies: PastReply[] = done.reverse().map((d, n) => ({
      runId: `${this.id}:${d.ask?.n ?? "-"}`, messageId: hash(`${this.id}:${d.ask?.n ?? "-"}:${d.text}`).slice(0, 24),
      // The newest ended when the chat last changed; an older one at least when it was asked (else in order before it).
      at: n === 0 ? updated : new Date(Math.min(d.ask?.sent ?? created, Date.parse(updated) - n * 1000)).toISOString(),
      text: d.text, prompt: d.ask?.text ?? null,
    }));
    const pr = prompt as Ask | null;
    this.cached = { status, open, asks, progress: open ? progress : null, replies, prompt: pr?.text ?? null };
    return this.cached;
  }
}
