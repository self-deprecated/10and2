// 10 & 2's Copilot extension (extensions/copilot/10and2.mjs): copied into Copilot's own extensions folder, where every
// Copilot started after finds it, once Copilot's extensions are on (`"experimental": true` in its settings.json, which
// turns on all of Copilot's experimental features). It gives each open Copilot a private socket and a registry entry
// (copilot/bridge.ts), so Driver can send to it and answer its questions there.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { replaceFile } from "../util.ts";

/** The first line of 10 & 2's copy: a file without it is someone else's and is never replaced or removed. */
export const MARKER = "// 10and2 Copilot extension (installed by `10and2 copilot install`)";

/** The extension's source: beside the sources (src/copilot/ → extensions/copilot/) or beside the bundle (dist/). */
export function extensionSource(): string {
  const here = import.meta.dirname;
  const found = [join(here, "..", "..", "extensions", "copilot", "10and2.mjs"), join(here, "..", "extensions", "copilot", "10and2.mjs")].find((p) => existsSync(p));
  if (!found) throw new Error("10and2's Copilot extension is missing from this installation. Reinstalling 10and2 fixes that.");
  return found;
}

const folder = (copilotDir: string) => join(copilotDir, "extensions", "10and2");
export const installedPath = (copilotDir: string) => join(folder(copilotDir), "extension.mjs");
/** Left beside the extension when it was 10 & 2 that turned Copilot's experimental features on, so uninstall turns them off. */
const turnedOn = (copilotDir: string) => join(folder(copilotDir), "experimental-turned-on-by-10and2");

const read = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
};
const ours = (text: string) => text.split("\n", 1)[0]!.trim() === MARKER;

/** Copilot's settings.json as an object (none: empty). One that isn't plain JSON is never rewritten. */
function settings(copilotDir: string): Record<string, unknown> {
  const path = join(copilotDir, "settings.json"), text = read(path);
  if (text === null || !text.trim()) return {};
  try {
    const o = JSON.parse(text);
    if (o && typeof o === "object" && !Array.isArray(o)) return o;
  } catch { /* below */ }
  throw new Error(`${path} isn't plain JSON, so 10 & 2 leaves it as it is. Set "experimental": true there yourself, then try again.`);
}
function writeSettings(copilotDir: string, o: Record<string, unknown>) {
  mkdirSync(copilotDir, { recursive: true, mode: 0o700 });
  const path = join(copilotDir, "settings.json"), tmp = `${path}.10and2-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n", { mode: 0o600 });
  replaceFile(tmp, path);
}

/**
 * `installed`: this version's copy, and extensions on. `outdated`: an older (or newer) copy of ours. `off`: ours, but
 * Copilot's experimental features (and so its extensions) are off. `missing`: none. `foreign`: someone else's file there.
 */
export type CopilotExtensionState = "installed" | "outdated" | "off" | "missing" | "foreign";

export function copilotExtensionStatus(copilotDir: string): { state: CopilotExtensionState; path: string } {
  const path = installedPath(copilotDir), text = read(path);
  if (text === null) return { state: "missing", path };
  if (!ours(text)) return { state: "foreign", path };
  if (text !== readFileSync(extensionSource(), "utf8")) return { state: "outdated", path };
  let on = false;
  try { on = settings(copilotDir).experimental === true; } catch { /* unreadable: as good as off */ }
  return { state: on ? "installed" : "off", path };
}

/** Copies the extension in (replacing only a copy of ours) and turns Copilot's experimental features on. */
export function installCopilotExtension(copilotDir: string): { state: CopilotExtensionState; path: string } {
  const path = installedPath(copilotDir), text = read(path);
  if (text !== null && !ours(text)) throw new Error(`${path} is another extension, not 10and2's, so it's left as it is. Move it, then try again.`);
  const s = settings(copilotDir);
  const source = readFileSync(extensionSource(), "utf8");
  if (text !== source) {
    mkdirSync(folder(copilotDir), { recursive: true, mode: 0o700 });
    const tmp = `${path}.10and2-${randomUUID()}`;
    writeFileSync(tmp, source, { mode: 0o644 });
    replaceFile(tmp, path);
  }
  if (s.experimental !== true) { writeSettings(copilotDir, { ...s, experimental: true }); writeFileSync(turnedOn(copilotDir), ""); }
  return { state: "installed", path };
}

/** Updates an older copy of ours in place, changing nothing else: what the connector does when it starts. */
export function updateCopilotExtension(copilotDir: string): boolean {
  const path = installedPath(copilotDir), text = read(path);
  if (text === null || !ours(text)) return false;
  const source = readFileSync(extensionSource(), "utf8");
  if (text === source) return false;
  const tmp = `${path}.10and2-${randomUUID()}`;
  writeFileSync(tmp, source, { mode: 0o644 });
  replaceFile(tmp, path);
  return true;
}

/** Removes the extension if it's ours, and turns the experimental features off again if 10 & 2 turned them on. */
export function uninstallCopilotExtension(copilotDir: string): { state: CopilotExtensionState; path: string } {
  const path = installedPath(copilotDir), text = read(path);
  if (text === null) return { state: "missing", path };
  if (!ours(text)) return { state: "foreign", path };
  if (existsSync(turnedOn(copilotDir))) {
    try { const s = settings(copilotDir); if (s.experimental === true) writeSettings(copilotDir, { ...s, experimental: false }); } catch { /* left as it is */ }
  }
  rmSync(folder(copilotDir), { recursive: true, force: true });
  return { state: "missing", path };
}
