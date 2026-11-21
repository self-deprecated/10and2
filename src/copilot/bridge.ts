// Talking to open Copilots through 10 & 2's Copilot extension (extensions/copilot/10and2.mjs): its registry says which
// sessions are open and what they're doing; its socket takes the user's words and answers (the same protocol as Pi's:
// pi/bridge.ts `talk`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Question } from "../pi/bridge.ts";

export type Live = { sessionId: string; cwd: string; pid: number; status: "idle" | "busy" | "waiting"; questions: Question[]; socket: string; updatedAt: string | null };

/** The pipe the extension listens on in a Windows Copilot. Nothing else is taken: `\\server\pipe\…` would leave this machine. */
export const COPILOT_PIPE = /^\\\\\.\\pipe\\10and2-copilot-[0-9a-f-]{36}$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a pid runs, as this user (another account's, EPERM, isn't talked to). */
const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * The open Copilots that run the extension, by session: entries whose process runs and whose socket is there (on
 * Windows, a pipe of the extension's own form). Anything malformed is left out.
 */
export function readLive(copilotDir: string, platform: NodeJS.Platform = process.platform): Map<string, Live> {
  const dir = join(copilotDir, "10and2"), out = new Map<string, Live>();
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const file of files) {
    const pid = /^(\d+)\.json$/.exec(file)?.[1];
    if (!pid) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (r.pid !== Number(pid) || !running(r.pid) || typeof r.sessionId !== "string" || !uuid.test(r.sessionId) || typeof r.cwd !== "string" || !isAbsolute(r.cwd)) continue;
      const socket = platform === "win32" ? (typeof r.socket === "string" && COPILOT_PIPE.test(r.socket) ? r.socket : null) : join(dir, `${pid}.sock`);
      if (!socket || (platform !== "win32" && !existsSync(socket))) continue;
      const questions: Question[] = Array.isArray(r.questions) ? r.questions.flatMap((q: any) => typeof q?.questionId === "string" && typeof q.title === "string"
        ? [{ questionId: q.questionId, title: q.title.slice(0, 2000), options: Array.isArray(q.options) ? q.options.filter((o: unknown) => typeof o === "string").map((o: string) => o.slice(0, 500)) : [] }] : []) : [];
      const prior = out.get(r.sessionId);
      const entry: Live = { sessionId: r.sessionId, cwd: r.cwd, pid: r.pid, status: ["idle", "busy", "waiting"].includes(r.status) ? r.status : "idle", questions, socket,
        updatedAt: typeof r.updatedAt === "string" ? r.updatedAt.slice(0, 50) : null };
      if (!prior || (entry.updatedAt ?? "") > (prior.updatedAt ?? "")) out.set(r.sessionId, entry);
    } catch { /* being rewritten: the next scan reads it again */ }
  }
  return out;
}
