// Two-key (docs/launch/spikes/two-key-hold.md): which commands a Bash call runs, as the guard reads them, and whether
// one of them is on the user's list (policy.ts `guard`). A small reading of shell syntax, enough for the forms agents
// write: quotes, `;` `&&` `||` `|` `&` `( )` and new lines, redirections (`2>&1`, `>/dev/null`, `&>log`), comments,
// `$( )` and backticks, `sh -c '…'`, `eval`, a heredoc fed to a shell, wrappers (`sudo`, `env`, `timeout 60`, `nice`,
// `xargs`, …), `cd` before a command, git's and Terraform's own options before the subcommand (`git -C repo`,
// `terraform -chdir=infra`). A `git push` is also read for where it pushes: `git push`, `git push origin HEAD` and
// `git push -u origin HEAD` on main are pushes to main, `+main` is a force push, `refs/heads/main` is main.
//
// It's a seatbelt, not a sandbox: an alias, a function, a script, a variable (`git push $REMOTE $BRANCH`) or another
// language running a guarded command isn't seen. Text that only goes somewhere (a quoted commit message, a heredoc fed
// to `cat`) isn't a command, so it isn't held.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

/** The current branch of the repository at `cwd`, or null (no repository, a detached HEAD). */
export type BranchOf = (cwd: string) => string | null;

export const branchAt: BranchOf = (cwd) => {
  try {
    return execFileSync("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
};

type Simple = { words: string[]; heredocs: string[] };

/**
 * Where the `)` that closes the `(` at `open` is, past quotes, heredocs (a commit message's "don't" in
 * `"$(cat <<'EOF' … EOF\n)"`) and nested parentheses; the end if it's never closed.
 */
function closing(src: string, open: number): number {
  let depth = 0;
  const delims: { delim: string; strip: boolean }[] = [];
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "'") { const k = src.indexOf("'", j + 1); if (k < 0) return src.length; j = k; continue; }
    if (c === '"') { j++; while (j < src.length && src[j] !== '"') { if (src[j] === "\\") j++; j++; } continue; }
    if (c === "<" && src[j + 1] === "<" && src[j + 2] !== "<") {
      const m = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|()<>]+))/.exec(src.slice(j));
      if (m) { delims.push({ delim: m[2] ?? m[3] ?? m[4] ?? "", strip: m[1] === "-" }); j += m[0].length - 1; continue; }
    }
    if (c === "\n" && delims.length) {
      // The heredocs started on this line: their bodies aren't shell, up to each one's own line.
      let at = j + 1;
      for (const h of delims.splice(0)) {
        while (at < src.length) {
          const nl = src.indexOf("\n", at), end = nl < 0 ? src.length : nl;
          const line = src.slice(at, end);
          at = end + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        }
      }
      j = at - 1; continue;
    }
    if (c === "(") depth++;
    if (c === ")" && --depth === 0) return j;
  }
  return src.length;
}

/**
 * The simple commands of `src`, each its words (quotes taken off, as the shell would) and the heredocs fed to it, with
 * the text of every `$( )`, backtick and `<( )` in it (`subs`), which run too. Redirections and comments are left out.
 */
function parse(src: string): { commands: Simple[]; subs: string[] } {
  const commands: Simple[] = [], subs: string[] = [];
  let current: Simple = { words: [], heredocs: [] };
  let word = "", inWord = false, drop = false;
  let heredoc: { strip: boolean } | null = null;
  const pending: { delim: string; strip: boolean; to: Simple }[] = [];
  const endWord = () => {
    if (!inWord) return;
    if (heredoc) pending.push({ delim: word, strip: heredoc.strip, to: current });
    else if (!drop) current.words.push(word);
    heredoc = null; drop = false; word = ""; inWord = false;
  };
  const endCommand = () => { endWord(); if (current.words.length || current.heredocs.length) commands.push(current); current = { words: [], heredocs: [] }; };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!, next = src[i + 1];
    if (c === "\\") { if (next !== "\n") { word += next ?? ""; inWord = true; } i += 2; continue; }
    if (c === "'") { const k = src.indexOf("'", i + 1); const end = k < 0 ? n : k; word += src.slice(i + 1, end); inWord = true; i = end + 1; continue; }
    if (c === "$" && next === "'") {
      let j = i + 2;
      while (j < n && src[j] !== "'") { if (src[j] === "\\") { word += src[j + 1] ?? ""; j += 2; continue; } word += src[j]; j++; }
      inWord = true; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") { word += src[j + 1] ?? ""; j += 2; continue; }
        if (src[j] === "$" && src[j + 1] === "(") { const k = closing(src, j + 1); subs.push(src.slice(j + 2, k)); word += src.slice(j, k + 1); j = k + 1; continue; }
        if (src[j] === "`") { const k = src.indexOf("`", j + 1); const end = k < 0 ? n : k; subs.push(src.slice(j + 1, end)); word += src.slice(j, end + 1); j = end + 1; continue; }
        word += src[j]; j++;
      }
      inWord = true; i = j + 1; continue;
    }
    if (c === "$" && next === "(") { const k = closing(src, i + 1); subs.push(src.slice(i + 2, k)); word += src.slice(i, k + 1); inWord = true; i = k + 1; continue; }
    if (c === "`") { const k = src.indexOf("`", i + 1); const end = k < 0 ? n : k; subs.push(src.slice(i + 1, end)); word += src.slice(i, end + 1); inWord = true; i = end + 1; continue; }
    if ((c === "<" || c === ">") && next === "(") { const k = closing(src, i + 1); subs.push(src.slice(i + 2, k)); i = k + 1; continue; }
    if (c === "#" && !inWord) { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { endWord(); i++; continue; }
    if (c === "\n") {
      endCommand(); i++;
      // The heredocs started on that line: their bodies, up to each one's own line.
      for (const h of pending.splice(0)) {
        const lines: string[] = [];
        while (i < n) {
          const nl = src.indexOf("\n", i), end = nl < 0 ? n : nl;
          const line = src.slice(i, end);
          i = end + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          lines.push(line);
        }
        h.to.heredocs.push(lines.join("\n"));
      }
      continue;
    }
    // Redirections: a file descriptor's digits before one go with it, and its target (a word, or `&1`) is left out.
    if (c === "&" && next === ">") { endWord(); i += src[i + 2] === ">" ? 3 : 2; drop = true; continue; }
    if (c === ">" || c === "<") {
      if (inWord && /^\d+$/.test(word)) { word = ""; inWord = false; } else endWord();
      const op = ["<<<", "<<-", "<<", ">>", ">&", "<&", ">|", "<>", ">", "<"].find((o) => src.startsWith(o, i))!;
      i += op.length;
      if (op === "<<" || op === "<<-") { heredoc = { strip: op === "<<-" }; continue; }
      if ((op === ">&" || op === "<&") && /[\d-]/.test(src[i] ?? "")) { while (/[\d-]/.test(src[i] ?? "")) i++; continue; }
      drop = true; continue;
    }
    if ((c === "&" && next === "&") || (c === "|" && (next === "|" || next === "&"))) { endCommand(); i += 2; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") { endCommand(); i++; continue; }
    word += c; inWord = true; i++;
  }
  endCommand();
  return { commands, subs };
}

/** Words that open or close a compound command, left off the front of the command they start. */
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "time"]);
/** Commands that run the rest of their words as a command, each with its options that take a value. */
const WRAPPERS: Record<string, { value: string[]; skip?: number }> = {
  sudo: { value: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir", "--prompt", "--host", "--role", "--type", "--other-user", "--command-timeout"] },
  doas: { value: ["-u", "-C"] },
  env: { value: ["-u", "-C", "--unset", "--chdir"] },
  command: { value: [] }, builtin: { value: [] }, exec: { value: ["-a"] }, nohup: { value: [] }, time: { value: ["-f", "-o"] },
  nice: { value: ["-n", "--adjustment"] }, ionice: { value: ["-c", "-n", "-p", "--class", "--classdata"] }, stdbuf: { value: ["-i", "-o", "-e"] },
  timeout: { value: ["-s", "-k", "--signal", "--kill-after"], skip: 1 },
  xargs: { value: ["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a", "--max-args", "--max-lines", "--max-procs", "--delimiter", "--arg-file", "--replace"] },
  caffeinate: { value: ["-t", "-w"] },
  watch: { value: ["-n", "--interval", "-q", "--equexit"] },
};
/** Package runners that run a package's command: `npx`, `bunx`, `pnpx` (and `pnpm exec`, `pnpm dlx`, `yarn dlx`, `npm exec`, `bun x`). */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/**
 * Package managers' own options before their subcommand (`pnpm -r publish`, `npm -w pkg publish`, `pnpm --filter api
 * exec prisma …`), each with those that take a value as the next word: read past, as git's are.
 */
const MANAGER_VALUE: Record<string, string[]> = {
  npm: ["-w", "--workspace", "-C", "--prefix", "--registry", "--tag", "--otp", "--access", "--userconfig", "--cache", "--loglevel"],
  pnpm: ["-C", "--dir", "-F", "--filter", "--filter-prod", "--registry", "--tag", "--otp", "--access", "--loglevel", "--reporter", "--workspace-concurrency"],
  yarn: ["--cwd", "--registry", "--tag", "--otp", "--access", "--mutex", "--network-timeout", "--modules-folder", "--cache-folder"],
  bun: ["--cwd", "-c", "--config", "--registry", "--tag", "--otp", "--access"],
};
/**
 * Their own subcommands: any other first word is a package's command they run (`pnpm prisma migrate reset`, `yarn
 * prisma …`, `bun prisma …`, as `npx` would), read as that command too.
 */
const MANAGER_OWN: Record<string, Set<string>> = {
  pnpm: new Set(["add", "approve-builds", "audit", "bin", "c", "cache", "ci", "config", "create", "dedupe", "deploy", "dlx", "doctor", "env", "exec", "fetch", "help", "i",
    "import", "init", "install", "install-test", "it", "licenses", "link", "list", "ln", "ls", "outdated", "pack", "patch", "patch-commit", "patch-remove", "prune",
    "publish", "rb", "rebuild", "remove", "rm", "root", "run", "self-update", "server", "setup", "start", "store", "t", "test", "un", "uninstall", "unlink", "up",
    "update", "upgrade", "why"]),
  yarn: new Set(["add", "audit", "autoclean", "bin", "cache", "check", "config", "constraints", "create", "dedupe", "dlx", "exec", "explain", "generate-lock-entry",
    "global", "help", "import", "info", "init", "install", "licenses", "link", "list", "login", "logout", "node", "npm", "outdated", "owner", "pack", "patch",
    "patch-commit", "plugin", "policies", "publish", "rebuild", "remove", "run", "search", "set", "stage", "tag", "team", "test", "unlink", "unplug", "up", "upgrade",
    "upgrade-interactive", "version", "versions", "why", "workspace", "workspaces"]),
  bun: new Set(["a", "add", "audit", "build", "c", "create", "exec", "i", "info", "init", "install", "link", "outdated", "patch", "pm", "publish", "remove", "repl",
    "rm", "test", "unlink", "update", "upgrade", "why", "x"]),
};
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** git's own options that come before its subcommand, with a value as the next word. */
const GIT_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);
const MAX_DEPTH = 4;

const home = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p);

/** A command's words with what runs it taken off the front: assignments, wrappers and their options, keywords. */
function unwrap(words: string[]): string[] {
  let w = words.slice();
  for (let before = -1; before !== w.length;) {
    before = w.length;
    while (w.length && (ASSIGNMENT.test(w[0]!) || KEYWORDS.has(w[0]!))) w.shift();
    const name = w[0] && w[0].includes("/") ? basename(w[0]) : w[0];
    const wrapper = name ? WRAPPERS[name] : undefined;
    if (!wrapper) break;
    let j = 1;
    while (j < w.length && (w[j]!.startsWith("-") || (name === "env" && ASSIGNMENT.test(w[j]!)))) {
      if (w[j] === "--") { j++; break; }
      j += wrapper.value.includes(w[j]!) ? 2 : 1;
    }
    w = w.slice(j + (wrapper.skip ?? 0));
  }
  // A command run by its path (`/usr/local/bin/terraform`, `./terraform`, `node_modules/.bin/prisma`): by its name.
  if (w[0]?.includes("/")) w[0] = basename(w[0]);
  return w;
}

/** A `git push`'s words as the guard reads where it pushes: options first, then the remote, then each branch it pushes to. */
function pushTargets(args: string[], current: () => string | null): string {
  const flags: string[] = [], positional: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "--") { positional.push(...args.slice(k + 1)); break; }
    if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(a)) { flags.push(a, args[k + 1] ?? ""); k++; continue; }
    if (a.startsWith("--")) { flags.push(a); continue; }
    if (a.startsWith("-") && a.length > 1) { for (const letter of a.slice(1)) flags.push(`-${letter}`); continue; }
    positional.push(a);
  }
  const specs = positional.slice(1);
  // Deleting a branch there (`--delete`, `-d`, `:main`) throws its history away as a force push does: read as one.
  const forced = (specs.some((s) => s.startsWith("+") || s.startsWith(":")) || flags.some((f) => f === "-d" || f === "--delete"))
    && !flags.some((f) => f === "-f" || f.startsWith("--force"));
  let targets = specs.map((s) => {
    const spec = s.replace(/^\+/, ""), at = spec.indexOf(":");
    const to = (at >= 0 ? spec.slice(at + 1) : spec).replace(/^refs\/heads\//, "");
    return to === "HEAD" || to === "@" ? current() ?? to : to;
  });
  // No branch named: the current branch goes (push.default simple, upstream or current); with --all, every branch.
  if (!specs.length && !flags.some((f) => ["--all", "--branches", "--mirror", "--tags"].includes(f))) targets = [current() ?? ""];
  return ["git", "push", ...flags, ...(forced ? ["--force"] : []), positional[0] ?? "origin", ...targets].filter(Boolean).join(" ");
}

/**
 * The commands a Bash call runs, as the guard matches them (`guarded`): each simple command's words, spaces collapsed,
 * with what runs it taken off the front, and for a `git push` also where it pushes (`pushTargets`). `cwd` is where the
 * call runs (a `cd` in it moves it), for the branch a `git push` that names none pushes.
 */
export function commandsOf(command: string, cwd?: string, branchOf: BranchOf = branchAt): string[] {
  return [...new Set(readings(command, cwd, branchOf).flat())];
}

/** A package runner's package word without its version or tag (`prisma@latest`, `@scope/pkg@1`): the command it runs. */
const unversioned = (word: string) => word.replace(/^((?:@[^/@\s]+\/)?[^@\s]+)@[^/\s]*$/, "$1");

/**
 * `commandsOf`, one entry per command the call runs, each with every way the guard reads it (as written, what a package
 * runner runs, where a `git push` pushes): what a call that runs two commands on the list is told by (`matchesOf`).
 */
function readings(command: string, cwd: string | undefined, branchOf: BranchOf, depth = 0): string[][] {
  if (depth > MAX_DEPTH) return [];
  const out: string[][] = [];
  const { commands, subs } = parse(command);
  let here = cwd;
  for (const sub of subs) out.push(...readings(sub, here, branchOf, depth + 1));
  for (const simple of commands) {
    let words = unwrap(simple.words);
    const name = words[0];
    if (!name) continue;
    if (name === "cd" || name === "pushd") { const to = words[1]; if (to && to !== "-" && here !== undefined) here = resolve(here, home(to)); else if (to?.startsWith("/") || to?.startsWith("~")) here = resolve(home(to)); continue; }
    // A shell running a script given to it (`sh -c '…'`, `bash -lc "…"`, `bash -euo pipefail -c '…'`, `bash <<EOF`), and
    // `eval`: what they run. Its options read past: `-o`, `+o`, `-O` and `+O` take the next word, alone or ending a
    // cluster (`-euo pipefail`); a cluster with `c` in it makes the first word after the options the script; one with
    // `s` reads it from what's fed in, whatever words follow (`bash -s -- arg <<'EOF'`).
    if (SHELLS.has(name)) {
      let j = 1, c = false, fed = false;
      for (; j < words.length; j++) {
        const w = words[j]!;
        if (w === "-" || w === "--") { j++; break; }
        if (!/^[-+]./.test(w)) break;
        if (w === "--rcfile" || w === "--init-file") { j++; continue; }
        if (w.startsWith("--")) continue;
        if (w[0] === "-" && w.includes("c")) c = true;
        if (w[0] === "-" && w.includes("s")) fed = true;
        if (/[oO]$/.test(w)) j++;
      }
      const script = c ? words[j] : undefined;
      if (script !== undefined) out.push(...readings(script, here, branchOf, depth + 1));
      else if (!c && (fed || j >= words.length)) for (const body of simple.heredocs) out.push(...readings(body, here, branchOf, depth + 1));
      continue;
    }
    if (name === "eval") { out.push(...readings(words.slice(1).join(" "), here, branchOf, depth + 1)); continue; }
    let at = here;
    if (name === "git") {
      let j = 1;
      for (; j < words.length && words[j]!.startsWith("-"); j++) {
        if (words[j] === "-C" && words[j + 1] !== undefined) { at = resolve(at ?? process.cwd(), home(words[j + 1]!)); j++; continue; }
        if (GIT_VALUE.has(words[j]!)) j++;
      }
      words = ["git", ...words.slice(j)];
    }
    if (name === "terraform" || name === "tofu") words = [name, ...words.slice(1).filter((x, k, all) => !(x.startsWith("-chdir=") && all.slice(0, k).every((y) => y.startsWith("-"))))];
    // rustup's toolchain before cargo's subcommand (`cargo +nightly publish`), read past.
    if (name === "cargo" && words[1]?.startsWith("+")) words = [name, ...words.slice(2)];
    // A package manager's own options before its subcommand, and Yarn's `workspace <name>`, read past.
    const value = MANAGER_VALUE[name];
    if (value) {
      let j = 1;
      for (; j < words.length && words[j]!.startsWith("-"); j++) if (value.includes(words[j]!)) j++;
      if (name === "yarn" && words[j] === "workspace" && j + 1 < words.length) j += 2;
      words = [name, ...words.slice(j)];
    }
    const text = words.join(" ").replace(/\s+/g, " ").trim();
    const read = [text];
    // A package runner (`npx prisma …`, `pnpm exec prisma …`, `pnpm prisma …`, `bun run prisma …`): also what it runs,
    // its package named without a version or tag (`npx prisma@latest migrate reset` runs `prisma migrate reset`).
    const own = MANAGER_OWN[name];
    const runner = RUNNERS.has(name) ? 1 : (name === "pnpm" || name === "yarn" || name === "npm") && ["exec", "dlx", "x"].includes(words[1] ?? "") ? 2
      : name === "bun" && words[1] === "x" ? 2
      : name === "bun" && words[1] === "run" && words[2] !== undefined && !words[2].startsWith("-") ? 2
      : own && words[1] !== undefined && !words[1].startsWith("-") && !own.has(words[1]) ? 1 : 0;
    if (runner) {
      let j = runner;
      while (j < words.length && words[j]!.startsWith("-")) j += ["-p", "--package", "-c", "--call"].includes(words[j]!) ? 2 : 1;
      const ran = [unversioned(words[j] ?? ""), ...words.slice(j + 1)];
      if (j < words.length) read.push(...readings(ran.map((x) => (/[^\w@%+=:,./-]/.test(x) ? `'${x.replace(/'/g, `'\\''`)}'` : x)).join(" "), at, branchOf, depth + 1).flat());
    }
    if (words[0] === "git" && words[1] === "push") {
      let branch: string | null | undefined;
      read.push(pushTargets(words.slice(2), () => (branch === undefined ? (branch = branchOf(at ?? process.cwd())) : branch)).replace(/\s+/g, " "));
    }
    out.push([...new Set(read)]);
  }
  return out;
}

const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s");

/** The guard pattern a Bash command matches (`commandsOf`), or null: it runs as before. */
export function guarded(guard: readonly string[], command: unknown, cwd?: string, branchOf?: BranchOf): string | null {
  return matchOf(guard, command, cwd, branchOf)?.pattern ?? null;
}

/** Which pattern a Bash command matches and the command in it that matched it ("terraform apply -auto-approve"), or null. */
export function matchOf(guard: readonly string[], command: unknown, cwd?: string, branchOf?: BranchOf): { pattern: string; matched: string } | null {
  if (!guard.length || typeof command !== "string" || !command.trim()) return null;
  const ran = commandsOf(command, cwd, branchOf);
  for (const pattern of guard) {
    const re = globRe(pattern);
    const matched = ran.find((r) => re.test(r));
    if (matched !== undefined) return { pattern, matched };
  }
  return null;
}

/**
 * Each command of a Bash call that's on the list, in the order it runs, with the pattern it matches and how it was read
 * (`matchOf`'s, for every command in the call): two or more, and one tap would let them all run while the phone names
 * one (claude/hooks.ts stops such a call at once).
 */
export function matchesOf(guard: readonly string[], command: unknown, cwd?: string, branchOf: BranchOf = branchAt): { pattern: string; matched: string }[] {
  if (!guard.length || typeof command !== "string" || !command.trim()) return [];
  const res = guard.map((pattern) => ({ pattern, re: globRe(pattern) }));
  return readings(command, cwd, branchOf).flatMap((read) => {
    for (const { pattern, re } of res) {
      const matched = read.find((r) => re.test(r));
      if (matched !== undefined) return [{ pattern, matched }];
    }
    return [];
  });
}
