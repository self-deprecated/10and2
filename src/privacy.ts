// macOS privacy (TCC): Desktop, Documents, Downloads and iCloud Drive stay closed to a program until the user allows
// it. The login service's Node is that program, not the Terminal that set it up, and so is everything it starts: a
// headless or background Claude, Codex's daemon (where a Codex terminal's own turns then run too), a Pi turn, OpenCode's
// server. Without the user's OK, reading a folder there doesn't fail: it waits for an answer to a prompt on the Mac's
// screen, so work there would hang silently (measured on Quartz, macOS 27.2, 21 November). The folder itself can still
// be looked up (stat, realpath), so the policy sees it.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";

/** The folders macOS asks about, under the home folder, and the name System Settings gives each. */
const PROTECTED: [string, string][] = [
  ["Desktop", "Desktop Folder"], ["Documents", "Documents Folder"], ["Downloads", "Downloads Folder"], [join("Library", "Mobile Documents"), "iCloud Drive"],
];

/** The protected folder `dir` is in, or null (and always null off macOS). */
export function protectedFolder(dir: string, home = homedir(), platform = process.platform): { root: string; name: string } | null {
  if (platform !== "darwin") return null;
  for (const [sub, name] of PROTECTED) {
    const root = join(home, sub), rel = relative(root, dir);
    if (rel === "" || (rel && !rel.startsWith("..") && !isAbsolute(rel))) return { root, name };
  }
  return null;
}

/** Whether a child of this process can list `dir` within `ms`: a list macOS holds for a prompt times out. */
export type Opens = (dir: string, ms: number) => Promise<boolean>;
const listDir: Opens = (dir, ms) => new Promise((done) => execFile("/bin/ls", ["-A", dir], { timeout: ms }, (e) => done(!e)));

const KEEP_MS = 30_000;
const seen = new Map<string, { ok: boolean; at: number }>();
const blockedNames = new Set<string>();

/** The protected folders found closed to this process, by System Settings' names, for `10and2 status`. */
export const blockedFolders = () => [...blockedNames];

/**
 * Why work can't start in `dir` now: it's in a folder macOS keeps closed to this program, said with what to allow; else
 * null. Each protected folder is tried once per 30 s, so an OK in System Settings counts within that.
 */
export async function privacyRefusal(dir: string | null | undefined, opts: { home?: string; platform?: NodeJS.Platform; opens?: Opens; now?: number; program?: string } = {}): Promise<string | null> {
  const p = dir ? protectedFolder(dir, opts.home, opts.platform) : null;
  if (!p) return null;
  const now = opts.now ?? Date.now();
  let known = seen.get(p.root);
  if (!known || now - known.at >= KEEP_MS) {
    known = { ok: await (opts.opens ?? listDir)(p.root, 3000), at: now };
    seen.set(p.root, known);
  }
  if (known.ok) { blockedNames.delete(p.name); return null; }
  blockedNames.add(p.name);
  return privacyHelp(p.name, opts.program);
}

/** What to allow, in System Settings' words, for a protected folder closed to this program (`node`, as macOS names it). */
export function privacyHelp(name: string, program = basename(process.execPath)): string {
  return `macOS hasn't let 10 & 2 into your ${name.replace(/ Folder$/, " folder")} on this Mac. To allow it, on the Mac open System Settings, then Privacy & Security, then Files & Folders, and turn on ${name} under “${program}”.`;
}

/** Tests only. */
export function forgetPrivacy() { seen.clear(); blockedNames.clear(); }
