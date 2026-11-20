// Running another program (claude, codex, pi, opencode, t3, git) the same way on every system. On Windows a command on
// PATH is often a script npm wrote (`codex.cmd`), which Node won't start without a shell, and a shell (cmd.exe) would
// read the user's words among its arguments as its own syntax. So such a script is read for the program it starts (a
// Node script, or an .exe), and that is run instead, with no shell in between.
import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, sep } from "node:path";

type Env = NodeJS.ProcessEnv;
/** What runs a command: the program, its arguments, and whether they're already quoted for cmd.exe. */
export type Resolved = { file: string; args: string[]; verbatim?: boolean };

/** An error like the one spawn gives, for a command that can't be run. */
const failed = (command: string, code: string, message = `spawn ${command} ${code}`) =>
  Object.assign(new Error(message), { code, path: command, syscall: `spawn ${command}` });
/** What Windows can start from PATH: a program, or a command script. Not the rest of PATHEXT (.js, .vbs, .ps1). */
const RUNNABLE = [".com", ".exe", ".bat", ".cmd"];

/** An environment variable whatever its case: Windows has `Path`, and a copied environment keeps that spelling. */
export function envVar(env: Env, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const hasDir = (c: string) => /[\\/]/.test(c);

/**
 * Where `command` is, found as the system would: on Windows through PATH and PATHEXT (`codex` is `codex.cmd`), never in
 * the current folder; elsewhere the first executable file of that name on PATH. A path is returned as it is when it
 * exists. Null when it isn't there.
 */
export function which(command: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const win = platform === "win32";
  const exts = win ? (envVar(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()).filter((e) => RUNNABLE.includes(e)) : [];
  const named = (base: string) => {
    if (!win) return isFile(base) ? [base] : [];
    const own = extname(base).toLowerCase();
    return [...(own && exts.includes(own) ? [base] : []), ...exts.map((e) => base + e)].filter(isFile);
  };
  if (isAbsolute(command) || hasDir(command)) return named(command)[0] ?? null;
  for (const raw of (envVar(env, "PATH") ?? "").split(win ? ";" : ":")) {
    const dir = raw.replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const found = named(join(dir, command))[0];
    if (found) return found;
  }
  return null;
}

/**
 * The program a Windows command script starts, when it's the kind npm (or pnpm, or Yarn) writes for a package's
 * command, a quoted path from the script's own folder (`"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`), or an
 * installer's one-liner (`"C:\Users\me\.t3\runtime\versions\0.1.11\t3.exe" %*`). The last path it names is what it
 * runs: a Node script comes back with the Node the script would choose, an .exe as itself, and another command script
 * as what that one runs (Yarn v1's global command runs the package's own script in Yarn's folder), at most two deep, so
 * scripts that run each other end. Anything else is null.
 */
export function shimTarget(script: string, env: Env = process.env, platform: NodeJS.Platform = process.platform, depth = 0): Resolved | null {
  let text: string;
  try { text = readFileSync(script, "utf8"); } catch { return null; }
  if (!/%\*/.test(text)) return null;
  const paths = [...text.matchAll(/"(%~?dp0%?\\?|[A-Za-z]:\\)([^"%]*)"/gi)]
    .map((m) => /^[A-Za-z]:\\$/.test(m[1]!) ? m[1]! + m[2]! : join(dirname(script), ...m[2]!.split(/[\\/]+/).filter(Boolean)))
    .filter((p) => !/(^|[\\/])node(\.exe)?$/i.test(p));
  const target = paths.at(-1);
  if (!target || !isFile(target)) return null;
  const ext = extname(target).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { file: target, args: [] };
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs" || ext === "") return { file: nodeFor(script, text, env, platform), args: [target] };
  if ((ext === ".cmd" || ext === ".bat") && depth < 2) return shimTarget(target, env, platform, depth + 1);
  return null;
}

/**
 * The Node a command script runs its script with: a node.exe it names that's there (npm's beside itself; Pi's
 * installer's own, `%LOCALAPPDATA%\pi-node\current\node.exe`, for a Pi that needs a newer Node than the system's), else
 * the one on PATH, else this one.
 */
function nodeFor(script: string, text: string, env: Env, platform: NodeJS.Platform): string {
  const expand = (p: string) => p.replace(/%~?dp0%?\\?/gi, dirname(script) + "\\").replace(/%([^%]+)%/g, (all, name: string) => envVar(env, name) ?? all);
  const named = [...text.matchAll(/"([^"=]*node\.exe)"/gi)].map((m) => expand(m[1]!)).filter((p) => !p.includes("%"))
    .map((p) => normalize(p.replace(/[\\/]+/g, sep)));
  return named.find(isFile) ?? which("node", env, platform) ?? process.execPath;
}

// An argument without spaces, quotes or cmd.exe's own characters, which passes through cmd.exe as it is.
const PLAIN = /^[\w@+=:,./\\-]+$/;

/**
 * What to start for `command args` with no shell. On Windows: an .exe directly; an npm-style script as what it starts;
 * any other .cmd or .bat through cmd.exe only when every argument is plain (no spaces, quotes or cmd.exe syntax), and
 * otherwise an error, since the user's words would be read as commands. Elsewhere the command as given (spawn finds it).
 */
export function resolveCommand(command: string, args: string[], env: Env = process.env, platform: NodeJS.Platform = process.platform): Resolved {
  if (platform !== "win32") return { file: command, args };
  const found = which(command, env, platform);
  // Not a bare name for spawn to look up: on Windows it would try the current folder (a project's) first.
  if (!found) throw failed(command, "ENOENT");
  const ext = extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { file: found, args };
  const shim = shimTarget(found, env, platform);
  if (shim) return { file: shim.file, args: [...shim.args, ...args] };
  // Inside quotes cmd.exe still expands %VAR%; the script's own path is quoted, so only " and % are refused there.
  if (/["%]/.test(found) || !args.every((a) => PLAIN.test(a))) {
    throw new Error(`${command} is a Windows command script (${found}) that can't be given these words safely; install it so it's an .exe or an npm package's command.`);
  }
  return { file: envVar(env, "ComSpec") || "cmd.exe", args: ["/d", "/s", "/c", `""${found}"${args.map((a) => ` ${a}`).join("")}"`], verbatim: true };
}

/** A program Windows can't start: an .exe npm left as a text placeholder because its install step was skipped. */
const plainly = (command: string, e: unknown) => (e as NodeJS.ErrnoException)?.code === "EFTYPE"
  ? failed(command, "EFTYPE", `${command} isn't fully installed (its install step didn't run); install it again.`) : e;

/**
 * `spawn` for a command found as the system finds it, with no console window on Windows. Like spawn, it throws when the
 * command can't be started at all (on Windows that includes not finding it, which spawn elsewhere reports as an event).
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const r = resolveCommand(command, args, options.env ?? process.env);
  try { return spawn(r.file, r.args, { windowsHide: true, ...options, ...(r.verbatim ? { windowsVerbatimArguments: true } : {}) }); }
  catch (e) { throw plainly(command, e); }
}

/** `execFile` for a command found as the system finds it. Every error, including one starting it, arrives in the callback. */
export function execFileCommand(command: string, args: string[], options: ExecFileOptions & { encoding?: BufferEncoding }, callback: (err: Error | null, stdout: string, stderr: string) => void): ChildProcess | null {
  try {
    const r = resolveCommand(command, args, options.env ?? process.env);
    return execFile(r.file, r.args, { windowsHide: true, encoding: "utf8", ...options, ...(r.verbatim ? { windowsVerbatimArguments: true } : {}) },
      (err, stdout, stderr) => callback(err, String(stdout), String(stderr)));
  } catch (e) {
    queueMicrotask(() => callback(plainly(command, e) as Error, "", ""));
    return null;
  }
}

/** Whether a command is installed (it answers `--version`), for finding the coding agents. */
export const installed = (command: string) => new Promise<boolean>((resolve) => {
  execFileCommand(command, ["--version"], { timeout: 5000 }, (err) => resolve(!err));
});
