// Helpers every coding-agent adapter shares: where a folder's checkout is, what to call its project, and a place's
// `folder`.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FirstAsk } from "./contract.ts";
import { execFileCommand } from "./command.ts";

/** A worktree a coding agent keeps inside its project (`<project>/.claude/worktrees/<name>`, and `.codex`, `.opencode`, `.pi`, `.gemini`, `.copilot`, `.cursor`). */
const AGENT_WORKTREE = /^(.*?)[/\\]\.(?:claude|codex|opencode|pi|gemini|copilot|cursor)[/\\]worktrees[/\\][^/\\]+(?:[/\\]|$)/;

/**
 * The nearest folder at or above `cwd` with a `.git` (a checkout or a worktree), or null. A coding agent's own worktree
 * inside its project counts as that project, so it isn't offered as a project of its own.
 */
export function gitRoot(cwd: string): string | null {
  const inner = AGENT_WORKTREE.exec(resolve(cwd));
  if (inner && inner[1]) return gitRoot(inner[1]);
  for (let p = resolve(cwd);; p = dirname(p)) {
    if (existsSync(join(p, ".git"))) return p;
    if (dirname(p) === p) return null;
  }
}

const MESSAGE_MAX = 8000;
const TRUNCATED = "\n[Content truncated]\n";
/**
 * A long message's start and end, at most 8000 characters: a pasted log followed by the question keeps the question.
 * brain/src/titles.ts `limited` is the same (test/protocol.test.ts holds them equal); the connector's own code can't
 * import the brain's, which isn't beside it in the package it's built and published from.
 */
export function limited(text: string): string {
  if (text.length <= MESSAGE_MAX) return text;
  const available = MESSAGE_MAX - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  return `${text.slice(0, head)}${TRUNCATED}${text.slice(-(available - head))}`;
}

/**
 * The user's first message as `first_ask` sends it: their words, cut to their start and end (`limited`) to bound the
 * frame, the message's time, and whether the work system read the item from its start. Null for words that are only
 * whitespace.
 */
export function firstAsk(text: string, at: string, complete: boolean): FirstAsk | null {
  const words = text.trim();
  return words ? { text: limited(words), at, complete } : null;
}

/** The end of a checkout's path ("mono/nix"), as a place's `folder`, without a Windows drive ("D:"); t3/adapter.ts has the same. */
export const folderOf = (root: string) => root.replace(/[/\\]+$/, "").split(/[/\\]/).filter((s) => s && !/^[A-Za-z]:$/.test(s)).slice(-2).join("/");

/** What a session's work belongs to, as it's said: a workspace's project ("…/workspaces/driver/…"), else its checkout's name. */
export function group(cwd: string): string {
  const workspace = cwd.match(/[/\\]workspaces[/\\]([^/\\]+)[/\\][^/\\]+(?:[/\\]|$)/);
  return workspace?.[1] ?? basename(gitRoot(cwd) ?? cwd);
}


/**
 * Where a new worktree of the project in `root` starts, given the policy's `worktreeBase`: null when the folder isn't in
 * a git repository, which has nothing to branch, so the work runs in the folder itself; "HEAD" when the repository has
 * no branch of that name here or from origin (a project whose main branch is named otherwise); else `base`.
 */
export async function worktreeStart(root: string, base: string): Promise<string | null> {
  // "error": git didn't run (not on this PATH), which says nothing about the folder; the agent's own git decides then.
  const run = (...args: string[]) => new Promise<"yes" | "no" | "error">((done) =>
    execFileCommand("git", ["-C", root, ...args], { timeout: 10_000 }, (e) => done(!e ? "yes" : typeof (e as { code?: unknown }).code === "number" ? "no" : "error")));
  const ok = async (...args: string[]) => await run(...args) === "yes";
  const inside = await run("rev-parse", "--is-inside-work-tree");
  if (inside === "no") return null;
  if (inside === "error") return base;
  if (base === "HEAD") return base;
  const has = (ref: string) => ok("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return await has(`refs/remotes/origin/${base}`) || await has(`refs/heads/${base}`) ? base : "HEAD";
}

const git = (root: string, ...args: string[]) => new Promise<string | null>((done) =>
  execFileCommand("git", ["-C", root, ...args], { timeout: 60_000 }, (e, out) => done(e ? null : out.trim())));

/**
 * A fresh worktree for new work Driver starts, at `<root>/<dir>/10and2-<id>` on the branch `10and2/<id>`, kept out of
 * the project's own git status. It starts from `base` (the policy's `worktreeBase`): a branch, fetched from origin first,
 * or "HEAD". A folder that isn't in a git repository has nothing to branch, so the work runs in the folder itself.
 */
export async function addWorktree(root: string, dir: string, id: string, base = "HEAD"): Promise<string> {
  const start = await worktreeStart(root, base);
  if (start === null) return root;
  const path = join(root, dir, `10and2-${id}`);
  if (existsSync(path)) return path;
  let ref = "HEAD";
  if (start !== "HEAD") {
    await git(root, "fetch", "--quiet", "origin", start);
    ref = await git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${start}^{commit}`) ? `origin/${start}` : start;
  }
  // A worktree's paths are longer by its folder: Git for Windows refuses paths past 260 characters unless told.
  const long = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];
  if (await git(root, ...long, "worktree", "add", "-B", `10and2/${id}`, path, ref) === null) throw new Error("10 & 2 couldn't make a worktree in that project.");
  const common = await git(root, "rev-parse", "--git-common-dir");
  if (common) {
    // Git's patterns take "/" only: in `/.codex\worktrees/` (a Windows join) the backslash escapes, and nothing matches.
    const exclude = join(isAbsolute(common) ? common : join(root, common), "info", "exclude"), line = `/${dir.split(/[\\/]+/).join("/")}/`;
    try { if (!(existsSync(exclude) ? readFileSync(exclude, "utf8") : "").split(/\r?\n/).includes(line)) appendFileSync(exclude, `\n${line}\n`); }
    catch { /* only git status is untidier */ }
  }
  return path;
}
