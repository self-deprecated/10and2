import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, isAbsolute, basename } from "node:path";

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

/** Darwin ps emits a local-time English date, with second precision. */
export function parsePsStart(text: string): number | null {
  const value = text.trim();
  if (!/^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
const ps = (pid: number, field: string) => execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
  encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C" },
});
export function darwinIdentity(command: string, lstart: string, start: string | null, startedAt?: unknown): "dead" | "verified" | "unverified" {
  if (!/^(claude|node|nodejs)(?:$|[-.])/.test(basename(command.trim()))) return "dead";
  const actual = parsePsStart(lstart);
  const expected = start?.startsWith("darwin:") ? Number(start.slice(7)) :
    start && /^\d{13}$/.test(start) ? Number(start) :
    start && /^\d{10}$/.test(start) ? Number(start) * 1000 :
    start?.includes("T") && iso(start) ? Date.parse(iso(start)!) : iso(startedAt) ? Date.parse(iso(startedAt)!) : null;
  if (actual !== null && expected !== null && Number.isFinite(expected)) return Math.abs(actual - expected) <= 5000 ? "verified" : "dead";
  // Some registry versions omit a comparable start time. Command identity is the minimum Darwin evidence.
  return "verified";
}

/** /proc's command name can contain spaces and parentheses: split after its final closing parenthesis. */
export function procStart(pid: number): string | null {
  try {
    if (process.platform === "darwin") {
      const at = parsePsStart(ps(pid, "lstart"));
      return at === null ? null : `darwin:${at}`;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
  }
  catch { return null; }
}

export function pidState(pid: number, start: string | null, platform = process.platform, startedAt?: unknown): "dead" | "verified" | "unverified" {
  try { process.kill(pid, 0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return "dead"; }
  if (platform === "darwin") {
    try { return darwinIdentity(ps(pid, "comm"), ps(pid, "lstart"), start, startedAt); }
    catch { return "unverified"; }
  }
  if (platform !== "linux" || !start) return "unverified";
  const actual = procStart(pid);
  return actual === null ? "unverified" : actual === start ? "verified" : "dead";
}

export type Live = {
  pid: number; sessionId: string; cwd: string; procStart: string | null; verified: boolean;
  status: "busy" | "idle" | "waiting" | null; statusUpdatedAt: string | null; waitingFor: string | null; name: string | null;
  /** How it was started: `cli` in a terminal, `sdk-*` for headless runs and apps built on the Agent SDK. */
  entrypoint: string | null;
  /** Its inbox for cross-session messages (2.1.224+), a Unix socket; null when it has none. */
  socket: string | null;
};

export function iso(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function registrySnapshot(configDir: string, log?: (s: string) => void): { live: Live[]; uncertain: boolean } {
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
        uncertain ||= pidState(Number(file.slice(0, -5)), null) !== "dead";
        continue;
      }
      const start = typeof r.procStart === "string" ? r.procStart : null;
      const alive = pidState(r.pid, start, process.platform, r.startedAt);
      if (alive === "dead") continue;
      const verified = alive === "verified" && knownVersion(r.version, log);
      out.push({ pid: r.pid, sessionId: r.sessionId, cwd: r.cwd, procStart: start, verified,
        status: verified && ["busy", "idle", "waiting"].includes(r.status) ? r.status : null,
        statusUpdatedAt: iso(r.statusUpdatedAt), waitingFor: typeof r.waitingFor === "string" ? r.waitingFor : null,
        name: typeof r.name === "string" ? r.name : null,
        entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : null,
        socket: typeof r.messagingSocketPath === "string" && isAbsolute(r.messagingSocketPath) && r.messagingSocketPath.endsWith(".sock") ? r.messagingSocketPath : null });
    } catch (e) {
      // A partial file owned by a live pid may be the session we're about to resume. Absence of its id isn't a lock.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") uncertain ||= pidState(Number(file.slice(0, -5)), null) !== "dead";
    }
  }
  return { live: out, uncertain };
}

export function readRegistry(configDir: string, log?: (s: string) => void): Live[] { return registrySnapshot(configDir, log).live; }
