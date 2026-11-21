// Where the connector keeps its files: configuration (the policy, which device this is) and state (ledgers, logs).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

export const APP = "10and2";
export const configDirectory = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP);
export const stateDirectory = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), APP);
/**
 * A database's path as SQLite can open it. On Windows SQLite passes the path on as it is, and Windows refuses one of
 * 260 characters or more (unless long paths are turned on), the files SQLite keeps beside it (`-journal`) included, where
 * Node's own files work: a long one is given as `\\?\C:\…`, which has no such limit.
 */
export function databasePath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32" || path === ":memory:") return path;
  const full = win32.resolve(path);
  return /^[A-Za-z]:\\/.test(full) && full.length + "-journal".length >= 260 ? `\\\\?\\${full}` : path;
}
/**
 * Where Claude Code's hooks reach the adapter, and the secret it proves itself with before a hook sends it anything:
 * none for a socket file, which its private folder keeps to the user.
 */
export type HookSocket = { path: string; secret: string | null };

/**
 * The private socket Claude Code's hooks write to; the adapter listens there, so both agree without configuration. On
 * Windows it's a pipe with a random name the adapter makes at each start, written with a secret made with it in its
 * state folder's hooks.pipe (null until it has). Other accounts can list pipes' names and take one once it's free,
 * but can't read the secret.
 */
export function hookSocket(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): HookSocket | null {
  if (platform === "win32") {
    try {
      const [name = "", secret = ""] = readFileSync(join(stateDirectory(env), "claude", "hooks.pipe"), "utf8").split(/\r?\n/);
      return /^\\\\\.\\pipe\\\S+$/.test(name) && /^[0-9a-f]{32}$/.test(secret) ? { path: name, secret } : null;
    } catch { return null; }
  }
  return { path: env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, APP, "hooks.sock") : join(stateDirectory(env), "claude", "hooks.sock"), secret: null };
}
