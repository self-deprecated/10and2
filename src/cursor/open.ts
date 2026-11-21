// Which Cursor CLI chats a process has open now. Cursor hides its open files from other processes (its /proc fd and
// cwd can't be read, measured on 2026.11.19), but while it has a chat open, in a terminal or a `-p` run, SQLite keeps
// `store.db-wal` beside the chat's `store.db`, and removes it when Cursor closes the chat. A crash can leave one
// behind, so it only counts while some `cursor-agent` of this user's is running.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

let last: { at: number; running: boolean } | null = null;
/** Whether any process of this user's is Cursor's CLI agent; asked again at most every 2 s (a busy chat rescans often). */
export function cursorRunning(platform: NodeJS.Platform = process.platform): boolean {
  if (last && Date.now() - last.at < 2000) return last.running;
  last = { at: Date.now(), running: lookRunning(platform) };
  return last.running;
}
function lookRunning(platform: NodeJS.Platform): boolean {
  if (platform === "linux") {
    let pids: string[] = [];
    try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return true; }
    return pids.some((pid) => { try { return isCursor(readFileSync(join("/proc", pid, "cmdline"), "utf8").replaceAll("\0", " ")); } catch { return false; } });
  }
  try { return execFileSync("ps", ["-x", "-o", "command="], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024 }).split("\n").some(isCursor); }
  catch { return true; } // can't tell: a chat with its WAL counts as open
}
/** A command line that's Cursor's agent (its launcher, or the Node it runs, both under a `cursor-agent` folder or named so). */
export const isCursor = (command: string) => /(?:^|[/\\\s])cursor-agent(?:[/\\\s]|$)/.test(command);

/** Chat ids under `chatsDir` (`<bucket>/<id>/store.db-wal`) that Cursor has open. */
export function openChats(chatsDir: string, running: () => boolean = cursorRunning): Set<string> {
  const out = new Set<string>();
  let buckets: string[];
  try { buckets = readdirSync(chatsDir); } catch { return out; }
  for (const b of buckets) {
    let ids: string[];
    try { ids = readdirSync(join(chatsDir, b)); } catch { continue; }
    for (const id of ids) if (existsSync(join(chatsDir, b, id, "store.db-wal"))) out.add(id);
  }
  return out.size && running() ? out : new Set();
}
