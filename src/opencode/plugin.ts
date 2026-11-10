// Installs 10 & 2's OpenCode plugin (extensions/opencode/10and2.js) into OpenCode's global plugin folder,
// ~/.config/opencode/plugins/ (or $XDG_CONFIG_HOME/opencode/plugins/), which OpenCode 1.19.5 loads into every process,
// terminal UIs included (it loads plugin/ too; measured). Only a file that starts with the plugin's marker line is ever
// replaced or removed, so a file of the user's own by that name stays.
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const MARKER = "// 10and2 OpenCode plugin (installed by `10and2 opencode install`)";
const NAME = "10and2.js";

export const defaultConfigDir = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

/** The plugin as shipped: beside the sources (src/opencode/ → extensions/) or beside the bundle (dist/ → extensions/). */
export function pluginSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [join(here, "..", "..", "extensions", "opencode", NAME), join(here, "..", "extensions", "opencode", NAME)]
    .find((p) => { try { return ours(readFileSync(p, "utf8")); } catch { return false; } });
  if (!found) throw new Error("10and2's OpenCode plugin is missing from this installation");
  return found;
}
const shipped = () => readFileSync(pluginSource(), "utf8");

async function read(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
const ours = (text: string | null) => text !== null && text.split("\n", 1)[0]!.trimEnd() === MARKER;

export type PluginStatus = { installed: boolean; current: boolean; path: string };

export async function installOpenCodePlugin(configDir = defaultConfigDir()): Promise<PluginStatus> {
  const path = join(configDir, "plugins", NAME), text = shipped();
  const existing = await read(path);
  if (existing !== null && !ours(existing)) throw new Error(`${path} is someone else's file; 10and2 won't replace it`);
  if (existing !== text) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.10and2-${randomUUID()}`;
    await writeFile(tmp, text, { mode: 0o644 });
    await rename(tmp, path);
  }
  // An older copy in the singular folder would load twice.
  const legacy = join(configDir, "plugin", NAME);
  if (ours(await read(legacy))) await unlink(legacy);
  return { installed: true, current: true, path };
}

export async function uninstallOpenCodePlugin(configDir = defaultConfigDir()): Promise<PluginStatus> {
  for (const dir of ["plugins", "plugin"]) {
    const path = join(configDir, dir, NAME);
    if (ours(await read(path))) await unlink(path);
  }
  return { installed: false, current: false, path: join(configDir, "plugins", NAME) };
}

/** Whether the plugin is installed, and whether it's this connector's version of it. */
export async function openCodePluginStatus(configDir = defaultConfigDir()): Promise<PluginStatus> {
  for (const dir of ["plugins", "plugin"]) {
    const path = join(configDir, dir, NAME), text = await read(path);
    if (ours(text)) return { installed: true, current: text === shipped(), path };
  }
  return { installed: false, current: false, path: join(configDir, "plugins", NAME) };
}
