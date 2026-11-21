// Where Cursor's CLI agent (`cursor-agent`, also installed as `agent`) keeps its chats, as its own code finds them
// (measured on 2026.11.19): its config folder holds `chats/<md5 of the working folder>/<chat id>/` (`store.db`, and
// `meta.json` with the folder, title and times), and its data folder `projects/<the folder as a slug>/agent-transcripts/
// <chat id>/<chat id>.jsonl`, the chat as text. Both are ~/.cursor unless moved.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else ~/.cursor: where its chats are. */
export function cursorConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CURSOR_CONFIG_DIR?.trim()) return env.CURSOR_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME, "cursor");
  return join(homedir(), ".cursor");
}
/** `CURSOR_DATA_DIR`, else ~/.cursor: where its transcripts are. */
export function cursorDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CURSOR_DATA_DIR?.trim() ? env.CURSOR_DATA_DIR : join(homedir(), ".cursor");
}
/** A working folder's chats folder name: the MD5 of its resolved path. */
export const bucketOf = (cwd: string) => createHash("md5").update(resolve(cwd)).digest("hex");
/** A working folder as Cursor names its project folder: every run of other characters is one "-", none at the ends. */
export const slugOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
/** Where a chat's transcript is, newest layout first (`<id>/<id>.jsonl`, then the older `<id>.jsonl`). */
export function transcriptPaths(dataDir: string, cwd: string, id: string): string[] {
  const dir = join(dataDir, "projects", slugOf(cwd), "agent-transcripts");
  return [join(dir, id, `${id}.jsonl`), join(dir, `${id}.jsonl`)];
}
