// Running Cursor's CLI: a new chat's id (`create-chat`, local only), a turn's arguments, the models it offers, and how
// a chat last ran (its `store.db`'s own settings, read only).
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { CodingModel } from "../contract.ts";
import type { RuntimeMode } from "../policy.ts";
import { execFileCommand } from "../command.ts";
import { sessionId } from "../claude/registry.ts";

const run = (command: string[], args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, timeout: number) => new Promise<string>((resolve, reject) => {
  const [bin, ...prefix] = command as [string, ...string[]];
  const child = execFileCommand(bin, [...prefix, ...args], { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim().split("\n").at(-1) || "it failed"));
    else resolve(stdout);
  });
  if (!child) reject(new Error("it isn't installed"));
});

/** A new empty chat in `cwd`, made by Cursor itself without calling a model; its id. */
export async function createChat(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const id = (await run(command, ["create-chat"], cwd, env, 30_000)).trim().split(/\s+/).find(sessionId);
  if (!id) throw new Error("Cursor didn't name the new chat");
  return id;
}

/**
 * One turn of chat `id`, the words on stdin: print mode, trusted (it's a folder the user works in and 10 & 2 may see),
 * with the permission flags for its mode, in plan mode or on a model when asked.
 */
export function runArgs(o: { id: string; flags: string[]; plan?: boolean; model?: string }): string[] {
  return ["-p", "--output-format", "stream-json", "--trust", "--resume", o.id, ...o.flags, ...(o.plan ? ["--plan"] : []), ...(o.model ? ["--model", o.model] : [])];
}

/** `cursor-agent models`' list: `<id> - <name>` lines (285 on 21 November), the default marked "(default)". */
export function parseModels(text: string): CodingModel[] {
  const out: CodingModel[] = [];
  // eslint-disable-next-line no-control-regex
  for (const raw of text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n")) {
    const m = /^\s*([A-Za-z0-9][\w.:/\-[\]=,]*)\s+-\s+(.+?)\s*(?:\((?:current|default)[^)]*\))?\s*$/.exec(raw);
    if (!m || m[1]!.length > 200 || out.some((o) => o.id === m[1])) continue;
    // Some names carry zero-width spaces and doubled spaces ("Grok 4.7  Low Fast\u200b\u200b").
    out.push({ id: m[1]!, name: m[2]!.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim() });
  }
  return out;
}
export async function listModels(command: string[], env: NodeJS.ProcessEnv): Promise<CodingModel[]> {
  return parseModels(await run(command, ["models"], undefined, env, 60_000));
}

/** How a chat last ran, from its own settings (`meta` key "0": its metadata, JSON as hex): its permission mode and Cursor mode. */
export function chatSettings(chatDir: string): { runtimeMode: RuntimeMode | null; mode: string | null } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(join(chatDir, "store.db"), { readOnly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value?: string } | undefined;
    if (!row?.value) return { runtimeMode: null, mode: null };
    const m = JSON.parse(Buffer.from(row.value, "hex").toString("utf8"));
    const runtimeMode: RuntimeMode = m.isRunEverything === true || m.approvalMode === "unrestricted" ? "full-access" : m.approvalMode === "auto-review" ? "auto" : "auto-accept-edits";
    return { runtimeMode, mode: typeof m.mode === "string" ? m.mode : null };
  } catch { return { runtimeMode: null, mode: null }; }
  finally { try { db?.close(); } catch { /* closed */ } }
}
