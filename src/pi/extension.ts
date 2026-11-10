// 10 & 2's Pi extension (extensions/pi/10and2.ts): copied into Pi's own extensions folder, where every Pi finds it. It
// gives each open Pi a private socket and a registry entry, so Driver can tell a session is open and reach it there.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** The first line of 10 & 2's copy: a file without it is someone else's and is never replaced or removed. */
export const MARKER = "// 10and2 Pi extension (installed by `10and2 pi install`)";

/** Pi's agent folder: $PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) return join(homedir(), ".pi", "agent");
  return resolve(dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);
}

/**
 * The extension's source: beside the sources (src/pi/ → extensions/pi/) or beside the bundle (dist/ → extensions/pi/),
 * since the package ships `extensions/`.
 */
export function extensionSource(): string {
  const here = import.meta.dirname;
  const found = [join(here, "..", "..", "extensions", "pi", "10and2.ts"), join(here, "..", "extensions", "pi", "10and2.ts")].find((p) => existsSync(p));
  if (!found) throw new Error("10and2's Pi extension is missing from this installation. Reinstalling 10and2 fixes that.");
  return found;
}

export const installedPath = (agentDir: string) => join(agentDir, "extensions", "10and2.ts");

const read = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
};
const ours = (text: string) => text.split("\n", 1)[0]!.trim() === MARKER;

/**
 * `installed`: this version's copy. `outdated`: an older (or newer) copy of ours. `missing`: none. `foreign`: a file
 * of someone else's at that path, which is left alone.
 */
export type PiExtensionState = "installed" | "outdated" | "missing" | "foreign";

export function piExtensionStatus(agentDir: string): { state: PiExtensionState; path: string } {
  const path = installedPath(agentDir), text = read(path);
  const state: PiExtensionState = text === null ? "missing" : !ours(text) ? "foreign" : text === readFileSync(extensionSource(), "utf8") ? "installed" : "outdated";
  return { state, path };
}

/** Copies the extension in, replacing only a copy of ours. Pi loads it in each Pi started from then on. */
export function installPiExtension(agentDir: string): { state: PiExtensionState; path: string } {
  const path = installedPath(agentDir), text = read(path);
  if (text !== null && !ours(text)) throw new Error(`${path} is another extension, not 10and2's, so it's left as it is. Move it, then try again.`);
  const source = readFileSync(extensionSource(), "utf8");
  if (text !== source) {
    mkdirSync(join(agentDir, "extensions"), { recursive: true, mode: 0o700 });
    const tmp = `${path}.10and2-${randomUUID()}`;
    writeFileSync(tmp, source, { mode: 0o644 });
    renameSync(tmp, path);
  }
  return { state: "installed", path };
}

/** Removes the extension if it's ours. */
export function uninstallPiExtension(agentDir: string): { state: PiExtensionState; path: string } {
  const path = installedPath(agentDir), text = read(path);
  if (text === null) return { state: "missing", path };
  if (!ours(text)) return { state: "foreign", path };
  rmSync(path, { force: true });
  return { state: "missing", path };
}
