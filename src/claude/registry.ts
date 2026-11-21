import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, isAbsolute, basename } from "node:path";
import { uptime } from "node:os";
import { resolveCommand } from "../command.ts";

export const sessionId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export function versionAtLeast(v: unknown, minimum: string): boolean {
  if (typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v)) return false;
  const parts = v.split(".").map(Number), floor = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== floor[i]) return parts[i]! > floor[i]!;
  return true;
}
const newerVersions = new Set<string>();
export function knownVersion(v: unknown, log: (s: string) => void = console.warn): boolean {
  if (!versionAtLeast(v, "2.1.280")) return false;
  if (v !== "2.1.310" && versionAtLeast(v, "2.1.310") && !newerVersions.has(v as string)) {
    newerVersions.add(v as string);
    log(`claude: reading newer version ${v} with the registry and transcript schema measured on 2.1.310`);
  }
  return true;
}

/**
 * Darwin ps's `lstart`, an English date with second precision, read as UTC: `ps` runs here with TZ=UTC, and Claude Code
 * writes its registry's `procStart` the same way whatever the session's TZ (measured on 2.1.325, Quartz).
 */
export function parsePsStart(text: string): number | null {
  const value = text.trim();
  if (!/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(value)) return null;
  const at = Date.parse(`${value} UTC`);
  return Number.isFinite(at) ? at : null;
}
const ps = (pid: number, field: string) => execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
  encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
});
export function darwinIdentity(command: string, lstart: string, start: string | null, startedAt?: unknown): "dead" | "verified" | "unverified" {
  // `comm` is the process's title where it sets one: Claude Code's background sessions show `claude bg-spare`.
  if (!/^(claude|node|nodejs)(?:$|[-.\s])/.test(basename(command.trim()))) return "dead";
  const actual = parsePsStart(lstart);
  // Claude Code's own `procStart` is ps's lstart. Without it, `startedAt` is when the session began, which can be well
  // after the process did (its folder-trust question comes first), so a session open there would read as gone.
  const expected = start?.startsWith("darwin:") ? Number(start.slice(7)) : start && parsePsStart(start) !== null ? parsePsStart(start) :
    start && /^\d{13}$/.test(start) ? Number(start) :
    start && /^\d{10}$/.test(start) ? Number(start) * 1000 :
    start?.includes("T") && iso(start) ? Date.parse(iso(start)!) : iso(startedAt) ? Date.parse(iso(startedAt)!) : null;
  if (actual !== null && expected !== null && Number.isFinite(expected)) return Math.abs(actual - expected) <= 5000 ? "verified" : "dead";
  // Some registry versions omit a comparable start time. Command identity is the minimum Darwin evidence.
  return "verified";
}

/** `tasklist /FO CSV /NH`'s lines (`"claude.exe","1234","Console","1","123,456 K"`) as each pid's image, lower-cased. */
export function parseTasklist(text: string): Map<number, string> {
  const images = new Map<number, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) images.set(Number(m[2]), m[1]!.toLowerCase());
  }
  return images;
}
/** A pid's image name on Windows: a string, null when no process has that pid, undefined when it can't be told. */
export type ImageOf = (pid: number) => string | null | undefined;
/**
 * Windows has no /proc or ps: a process's image name comes from one `tasklist` for every pid, kept for a couple of
 * seconds, since a scan checks every session at once and runs on every burst of file events. A pid the listing doesn't
 * have may have started since, so it's listed again before it counts as gone. A listing that fails isn't tried again
 * for a minute: each try holds the connector up.
 */
export function processImages(list: () => string | null, ttlMs = 2000): ImageOf {
  let last: { at: number; images: Map<number, string> | null } | null = null;
  const fresh = () => { const out = list(); last = { at: Date.now(), images: out === null ? null : parseTasklist(out) }; return last.images; };
  return (pid) => {
    const kept = last && Date.now() - last.at < (last.images ? ttlMs : 60_000) ? last.images : undefined;
    let images = kept === undefined ? fresh() : kept;
    if (kept && !kept.has(pid)) images = fresh();
    return images ? images.get(pid) ?? null : undefined;
  };
}
const tasklist = () => {
  try {
    const r = resolveCommand("tasklist", ["/FO", "CSV", "/NH"]);
    return execFileSync(r.file, r.args, { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  } catch { return null; }
};
const windowsImages = processImages(tasklist);
/** What Claude Code runs as on Windows: its own claude.exe (native or npm's copy), or a Node or Bun running its script. */
const CLAUDE_IMAGES = ["claude.exe", "node.exe", "bun.exe"];

/**
 * When a process started, as Driver records its own runs to tell them from a later process given the same pid: /proc's
 * start ticks on Linux, ps's start on macOS, and on Windows only its image name (`win32:claude.exe`), the same minimum
 * macOS accepts. /proc's command name can contain spaces and parentheses: split after its final closing parenthesis.
 */
export function procStart(pid: number, platform = process.platform, imageOf: ImageOf = windowsImages): string | null {
  try {
    if (platform === "win32") { const image = imageOf(pid); return image ? `win32:${image}` : null; }
    if (platform === "darwin") {
      const at = parsePsStart(ps(pid, "lstart"));
      return at === null ? null : `darwin:${at}`;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
  }
  catch { return null; }
}

/**
 * When this computer last started, by the earliest estimate seen: one made from the clock alone moves later whenever
 * the clock steps forward (or a paused VM syncs it), and live sessions started before it would look left behind.
 */
let boot = Date.now() - uptime() * 1000;
const bootAt = () => (boot = Math.min(boot, Date.now() - uptime() * 1000));

/**
 * Whether a pid is still the process recorded with `start`. On Windows that's its image: the one Driver recorded for its
 * own run (`win32:<image>`), else one Claude Code runs as; Claude Code's own start there (`procStartFt`) isn't compared.
 * There an entry started before the computer last started is one a reboot left behind (a minute's margin for the
 * clock), and is gone. A pid there that refuses the check (EPERM) is "foreign": a Claude Code run as administrator, or
 * another account's process, which may hold its session but whose state and inbox the connector can't use.
 */
export function holderState(pid: number, start: string | null, platform = process.platform, startedAt?: unknown, imageOf: ImageOf = windowsImages): "dead" | "verified" | "unverified" | "foreign" {
  let refused = false;
  try { process.kill(pid, 0); }
  catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code === "ESRCH") return "dead"; refused = code === "EPERM"; }
  if (platform === "win32") {
    if (iso(startedAt) && Date.parse(iso(startedAt)!) < bootAt() - 60_000) return "dead";
    const image = imageOf(pid);
    if (image === null) return "dead";
    if (image !== undefined && !(start?.startsWith("win32:") ? image === start.slice(6) : CLAUDE_IMAGES.includes(image))) return "dead";
    return refused ? "foreign" : image === undefined ? "unverified" : "verified";
  }
  if (platform === "darwin") {
    try { return darwinIdentity(ps(pid, "comm"), ps(pid, "lstart"), start, startedAt); }
    catch { return "unverified"; }
  }
  if (platform !== "linux" || !start) return "unverified";
  const actual = procStart(pid);
  return actual === null ? "unverified" : actual === start ? "verified" : "dead";
}

/**
 * holderState, for the connector's own processes and the runs it started: those answer the check, so on Windows one
 * that refuses it is a later process given the pid, perhaps another account's, and is gone.
 */
export function pidState(pid: number, start: string | null, platform = process.platform, startedAt?: unknown, imageOf: ImageOf = windowsImages): "dead" | "verified" | "unverified" {
  const state = holderState(pid, start, platform, startedAt, imageOf);
  return state === "foreign" ? "dead" : state;
}

export type Live = {
  pid: number; sessionId: string; cwd: string; procStart: string | null; verified: boolean;
  status: "busy" | "idle" | "waiting" | null; statusUpdatedAt: string | null; waitingFor: string | null; name: string | null;
  /** How it was started: `cli` in a terminal, `sdk-*` for headless runs and apps built on the Agent SDK. */
  entrypoint: string | null;
  /** Its inbox for cross-session messages (2.1.224+): a Unix socket, or on Windows a named pipe; null when it has none. */
  socket: string | null;
  /** Open where 10 & 2 can't reach it (Windows): run as administrator, or another account's. No state, no inbox. */
  foreign: boolean;
};

/** A Windows named pipe's name, as Claude Code names its inbox there (`\\.\pipe\LOCAL\cc-msg-<hex>`). */
export const PIPE = /^\\\\[.?]\\pipe\\(?:LOCAL\\)?[^\\]+$/i;
/** A registry entry's inbox, when it's one this system can reach: a pipe on Windows, an absolute `.sock` elsewhere. */
export function inboxPath(p: unknown, platform = process.platform): string | null {
  if (typeof p !== "string") return null;
  return (platform === "win32" ? PIPE.test(p) : isAbsolute(p) && p.endsWith(".sock")) ? p : null;
}

export function iso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function registrySnapshot(configDir: string, log?: (s: string) => void, platform = process.platform, imageOf: ImageOf = windowsImages): { live: Live[]; uncertain: boolean } {
  const dir = join(configDir, "sessions");
  let files: string[];
  try { files = readdirSync(dir); }
  catch (e) { return { live: [], uncertain: (e as NodeJS.ErrnoException).code !== "ENOENT" }; }
  const out: Live[] = [];
  let uncertain = false;
  for (const file of files) {
    if (!/^[1-9]\d*\.json$/.test(file)) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (r.pid !== Number(file.slice(0, -5)) || !sessionId(r.sessionId) || typeof r.cwd !== "string" || !isAbsolute(r.cwd)) {
        uncertain ||= pidState(Number(file.slice(0, -5)), null, platform, undefined, imageOf) !== "dead";
        continue;
      }
      // Claude Code on Windows records its start as procStartFt (a FILETIME) instead.
      const start = typeof r.procStart === "string" ? r.procStart : typeof r.procStartFt === "string" || typeof r.procStartFt === "number" ? String(r.procStartFt) : null;
      const alive = holderState(r.pid, start, platform, r.startedAt, imageOf);
      if (alive === "dead") continue;
      // A foreign holder (an administrator terminal's Claude Code) still holds its session, so it's never resumed
      // elsewhere; its pid may be another account's by now, so nothing goes to its inbox and its status isn't shown.
      const foreign = alive === "foreign";
      const verified = alive === "verified" && knownVersion(r.version, log);
      out.push({ pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, procStart: start, verified,
        status: verified && ["busy", "idle", "waiting"].includes(r.status) ? r.status : null,
        statusUpdatedAt: iso(r.statusUpdatedAt), waitingFor: typeof r.waitingFor === "string" ? r.waitingFor : null,
        name: typeof r.name === "string" ? r.name : null,
        entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : null,
        socket: foreign ? null : inboxPath(r.messagingSocketPath, platform), foreign });
    } catch (e) {
      // A partial file owned by a live pid may be the session we're about to resume. Absence of its id isn't a lock.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") uncertain ||= pidState(Number(file.slice(0, -5)), null, platform, undefined, imageOf) !== "dead";
    }
  }
  return { live: out, uncertain };
}

export function readRegistry(configDir: string, log?: (s: string) => void): Live[] { return registrySnapshot(configDir, log).live; }
