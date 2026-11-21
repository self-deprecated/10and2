// Running another program (claude, codex, pi, opencode, t3, git) the same way on every system. On Windows a command on
// PATH is often a script npm wrote (`codex.cmd`), which Node won't start without a shell, and a shell (cmd.exe) would
// read the user's words among its arguments as its own syntax. So such a script is read for the program it starts (a
// Node script, or an .exe), and that is run instead, with no shell in between.
import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, sep, win32 } from "node:path";

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
// An argument without spaces, quotes or cmd.exe's own characters, which passes through cmd.exe as it is.
const PLAIN = /^[\w@+=:,./\\-]+$/;

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
 * The lines npm, pnpm and Yarn (and Pi's installer) write around the one that runs the program, which change nothing it
 * is given: `@ECHO off`, comments, finding the script's own folder, choosing the Node beside it or on PATH. pnpm's NODE_PATH,
 * which only helps a package find others it didn't declare, is the one setting not passed on.
 */
const OWN = /^(?:|rem(?: .*)?|::.*|echo off|goto start|:find_dp0|:start|exit \/b|setlocal|call :find_dp0|\)|\) else \(|set dp0=%~dp0|set pathext=%pathext:;\.js;=;%|set "(?:_prog|node)=(?:node|[^"]*\\node\.exe)"|if exist "[^"]*\\node\.exe" (?:\(|set "node=[^"]*\\node\.exe")|if not defined node_path \(|set "node_path=[^"]*")$/i;
/** How npm's line that runs the program starts: it ends the script's own settings first. */
const NPM_RUN = /^endlocal & goto #_undefined_# 2>nul \|\| title %comspec% & /i;
/** A quoted path from the script's own folder or a drive. */
const QUOTED_PATH = /^"(%~?dp0%?\\?|[A-Za-z]:\\)([^"%]*)"$/i;
/** What runs a Node script there: npm's `"%_prog%"`, Pi's `"%node%"`, `node`, or a node.exe by its path. */
const NODE = /^"?(?:%_prog%|%node%|(?:[^"]*[\\/]|%~?dp0%?)?node(?:\.exe)?)"?$/i;

/**
 * A command script's line that runs the program with the user's words (`%*`): the program's quoted path, or Node and
 * its script's, with the plain words before the script (Node's flags, from the script's `#!`) and after it. Null for
 * anything else, words with cmd.exe's syntax included.
 */
function runLine(line: string) {
  const [program = "", ...words] = line.replace(NPM_RUN, "").match(/"[^"]*"|[^\s"]+/g) ?? [];
  if (words.pop() !== "%*") return null;
  const node = NODE.test(program);
  const at = node ? words.findIndex((w) => QUOTED_PATH.test(w)) : -1;
  const path = node ? words[at] : program;
  const before = node ? words.slice(0, at) : [], after = node ? words.slice(at + 1) : words;
  return path && QUOTED_PATH.test(path) && [...before, ...after].every((w) => PLAIN.test(w)) ? { node, path, before, after } : null;
}

/**
 * The program a Windows command script starts, when it's the kind npm (or pnpm, or Yarn) writes for a package's
 * command, a quoted path from the script's own folder (`"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`), or an
 * installer's one-liner (`"C:\Users\me\.t3\runtime\versions\0.1.11\t3.exe" %*`). A Node script comes back with the Node
 * the script would choose and the flags it gives it, an .exe as itself, and another command script as what that one
 * runs (Yarn v1's global command runs the package's own script in Yarn's folder), at most two deep, so scripts that run
 * each other end; plain words the script adds are kept. "missing" when what it runs is gone. A script that does anything
 * else before it (sets something for the program, runs another command) or adds words cmd.exe would read is null.
 */
export function shimTarget(script: string, env: Env = process.env, platform: NodeJS.Platform = process.platform, depth = 0): Resolved | "missing" | null {
  let text: string;
  try { text = readFileSync(script, "utf8"); } catch { return null; }
  const lines = text.split(/\r?\n/).map((raw) => raw.trim().replace(/^@/, ""));
  const runs = (line: string) => /(^|\s)%\*$/.test(line);
  const parsed = [];
  // What comes after the last line that runs it happens once it has ended (Pi's launcher passes its exit code on, or
  // says Node is missing), so it changes nothing the program is given.
  for (const line of lines.slice(0, lines.findLastIndex(runs) + 1)) {
    if (runs(line)) parsed.push(runLine(line));
    else if (!OWN.test(line.replace(/\s+/g, " "))) return null;
  }
  // Yarn's and pnpm's two lines, for a node.exe beside the script or none, run the same script with the same words.
  const run = parsed[0];
  if (!run || parsed.some((r) => JSON.stringify(r) !== JSON.stringify(run))) return null;
  const [, from = "", rest = ""] = QUOTED_PATH.exec(run.path)!;
  const target = /^[A-Za-z]:\\$/.test(from) ? from + rest : join(dirname(script), ...rest.split(/[\\/]+/).filter(Boolean));
  if (!isFile(target)) return "missing";
  const ext = extname(target).toLowerCase();
  if (run.node) return [".js", ".cjs", ".mjs", ""].includes(ext) ? { file: nodeFor(script, text, env, platform), args: [...run.before, target, ...run.after] } : null;
  if (ext === ".exe" || ext === ".com") return { file: target, args: run.after };
  if ((ext === ".cmd" || ext === ".bat") && depth < 2) {
    const inner = shimTarget(target, env, platform, depth + 1);
    return inner && inner !== "missing" ? { file: inner.file, args: [...inner.args, ...run.after] } : inner;
  }
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
  if (ext !== ".cmd" && ext !== ".bat") return runnable(command, { file: found, args });
  const shim = shimTarget(found, env, platform);
  if (shim === "missing") throw failed(command, "ENOENT", `${command} isn't fully installed; install it again.`);
  if (shim) return runnable(command, { file: shim.file, args: [...shim.args, ...args] });
  // Inside quotes cmd.exe still expands %VAR%; the script's own path is quoted, so only " and % are refused there.
  if (/["%]/.test(found) || !args.every((a) => PLAIN.test(a))) {
    throw new Error(`${command} is a Windows command script (${found}) that can't be given these words safely; install it so it's an .exe or an npm package's command.`);
  }
  // cmd.exe by its path too, without ComSpec: a bare name would be looked for in the current folder first.
  const shell = envVar(env, "ComSpec") || win32.join(envVar(env, "SystemRoot") || "C:\\Windows", "System32", "cmd.exe");
  return { file: shell, args: ["/d", "/s", "/c", `""${found}"${args.map((a) => ` ${a}`).join("")}"`], verbatim: true };
}

/**
 * `r`, unless the .exe it starts isn't a program (one starts "MZ"): what npm leaves as a text placeholder when a
 * package's install step is skipped, which Windows refuses with an error Node can't name.
 */
function runnable(command: string, r: Resolved): Resolved {
  if (extname(r.file).toLowerCase() !== ".exe") return r;
  const head = Buffer.alloc(2);
  let fd: number | undefined;
  try { fd = openSync(r.file, "r"); readSync(fd, head, 0, 2, 0); }
  catch { return r; } // unreadable: starting it says why
  finally { if (fd !== undefined) closeSync(fd); }
  if (head.toString("latin1") !== "MZ") throw failed(command, "EFTYPE", `${command} isn't fully installed (its install step didn't run); install it again.`);
  return r;
}

/**
 * `spawn` for a command found as the system finds it, with no console window on Windows. Like spawn, it throws when the
 * command can't be started at all (on Windows that includes not finding it, which spawn elsewhere reports as an event).
 */
export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const r = resolveCommand(command, args, options.env ?? process.env);
  const child = spawn(r.file, r.args, { windowsHide: true, ...options, ...(r.verbatim ? { windowsVerbatimArguments: true } : {}) });
  // One that couldn't start says so as the child's own error; its output pipes then fail too (on Windows "read
  // ENOTCONN", from a working folder too long to start in), which nothing would hear, and which would end 10and2.
  for (const out of [child.stdout, child.stderr]) out?.on("error", () => {});
  return child;
}

/** `execFile` for a command found as the system finds it. Every error, including one starting it, arrives in the callback. */
export function execFileCommand(command: string, args: string[], options: ExecFileOptions & { encoding?: BufferEncoding }, callback: (err: Error | null, stdout: string, stderr: string) => void): ChildProcess | null {
  try {
    const r = resolveCommand(command, args, options.env ?? process.env);
    return execFile(r.file, r.args, { windowsHide: true, encoding: "utf8", ...options, ...(r.verbatim ? { windowsVerbatimArguments: true } : {}) },
      (err, stdout, stderr) => callback(err, String(stdout), String(stderr)));
  } catch (e) {
    queueMicrotask(() => callback(e as Error, "", ""));
    return null;
  }
}

/** Whether a command is installed (it answers `--version`), for finding the coding agents. */
export const installed = (command: string) => new Promise<boolean>((resolve) => {
  execFileCommand(command, ["--version"], { timeout: 5000 }, (err) => resolve(!err));
});
