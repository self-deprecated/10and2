// Which coding-agent processes are running, where, and since when: how the ACP agents' adapters tell a session open in a
// terminal or an editor (Gemini CLI and Copilot CLI keep no lock or registry of their own sessions). Linux reads /proc;
// macOS asks `ps` and `lsof`; elsewhere (Windows) the folder can't be read, so a process counts for every folder.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { parsePsStart } from "../claude/registry.ts";

/** A running process: its arguments, its working folder (null when it can't be read), and when it started (ms). */
export type Proc = { pid: number; args: string[]; cwd: string | null; startMs: number };

/** Every process of this user whose arguments `match` says is the agent. */
export function processes(match: (args: string[]) => boolean, platform = process.platform): Proc[] {
  try {
    if (platform === "linux") return linux(match);
    if (platform === "darwin") return darwin(match);
    return windows(match);
  } catch { return []; }
}

function linux(match: (args: string[]) => boolean): Proc[] {
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      if (!args.length || !match(args)) continue;
      // Another user's process can't be read; it isn't this user's session either.
      out.push({ pid: Number(name), args, cwd: readlinkSync(`/proc/${name}/cwd`), startMs: statSync(`/proc/${name}`).ctimeMs });
    } catch { /* gone, or not ours */ }
  }
  return out;
}

/** `ps -axww -o pid=,lstart=,args=`'s lines: the pid, a 24-character start date, then the arguments as one string. */
export function parsePs(text: string): { pid: number; startMs: number; args: string[] }[] {
  const out: { pid: number; startMs: number; args: string[] }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    const startMs = m ? parsePsStart(m[2]!) : null;
    // ps joins the arguments with spaces; one with a space in it can't be told apart, which matching doesn't need.
    if (m && startMs !== null) out.push({ pid: Number(m[1]), startMs, args: m[3]!.trim().split(/\s+/) });
  }
  return out;
}

/** `lsof -Fpn`'s output: `p<pid>` lines, each followed by `n<path>` for the cwd asked for. */
export function parseLsofCwd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}

function darwin(match: (args: string[]) => boolean): Proc[] {
  const env = { ...process.env, LC_ALL: "C" };
  const found = parsePs(execFileSync("ps", ["-axww", "-o", "pid=,lstart=,args="], { encoding: "utf8", timeout: 3000, env, maxBuffer: 16 * 1024 * 1024 }))
    .filter((p) => p.pid !== process.pid && match(p.args));
  if (!found.length) return [];
  let cwds = new Map<number, string>();
  try { cwds = parseLsofCwd(execFileSync("lsof", ["-a", "-p", found.map((p) => p.pid).join(","), "-d", "cwd", "-Fpn"], { encoding: "utf8", timeout: 3000, env })); }
  catch (e) { cwds = parseLsofCwd(String((e as { stdout?: unknown }).stdout ?? "")); }
  return found.map((p) => ({ ...p, cwd: cwds.get(p.pid) ?? null }));
}

function windows(match: (args: string[]) => boolean): Proc[] {
  // The command line and start of each process; Windows doesn't say another process's working folder.
  const json = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,@{n='Start';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],
  { encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const rows: any[] = [JSON.parse(json || "[]")].flat();
  return rows.filter((r) => typeof r?.CommandLine === "string" && r.ProcessId !== process.pid)
    .map((r) => ({ pid: Number(r.ProcessId), args: String(r.CommandLine).split(/\s+/), cwd: null, startMs: Date.parse(r.Start) }))
    .filter((p) => Number.isFinite(p.startMs) && match(p.args));
}
