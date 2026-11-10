// Helpers every coding-agent adapter shares: where a folder's checkout is, what to call its project, and a place's
// `folder`.
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** A worktree a coding agent keeps inside its project (`<project>/.claude/worktrees/<name>`, and `.codex`, `.opencode`, `.pi`). */
const AGENT_WORKTREE = /^(.*?)[/\\]\.(?:claude|codex|opencode|pi)[/\\]worktrees[/\\][^/\\]+(?:[/\\]|$)/;

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

/** The end of a checkout's path ("mono/nix"), as a place's `folder`; t3/adapter.ts has the same. */
export const folderOf = (root: string) => root.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).slice(-2).join("/");

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
  const ok = (...args: string[]) => new Promise<boolean>((done) => execFile("git", ["-C", root, ...args], { timeout: 10_000 }, (e) => done(!e)));
  if (!await ok("rev-parse", "--is-inside-work-tree")) return null;
  if (base === "HEAD") return base;
  const has = (ref: string) => ok("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  return await has(`refs/remotes/origin/${base}`) || await has(`refs/heads/${base}`) ? base : "HEAD";
}

const git = (root: string, ...args: string[]) => new Promise<string | null>((done) =>
  execFile("git", ["-C", root, ...args], { timeout: 60_000 }, (e, out) => done(e ? null : String(out).trim())));

/**
 * A fresh worktree for new work Driver starts, at `<root>/<dir>/driver-<id>` on the branch `driver/<id>`, kept out of
 * the project's own git status. It starts from `base` (the policy's `worktreeBase`): a branch, fetched from origin first,
 * or "HEAD". A folder that isn't in a git repository has nothing to branch, so the work runs in the folder itself.
 */
export async function addWorktree(root: string, dir: string, id: string, base = "HEAD"): Promise<string> {
  const start = await worktreeStart(root, base);
  if (start === null) return root;
  const path = join(root, dir, `driver-${id}`);
  if (existsSync(path)) return path;
  let ref = "HEAD";
  if (start !== "HEAD") {
    await git(root, "fetch", "--quiet", "origin", start);
    ref = await git(root, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${start}^{commit}`) ? `origin/${start}` : start;
  }
  if (await git(root, "worktree", "add", "-B", `driver/${id}`, path, ref) === null) throw new Error("Driver couldn't make a worktree in that project.");
  const common = await git(root, "rev-parse", "--git-common-dir");
  if (common) {
    const exclude = join(isAbsolute(common) ? common : join(root, common), "info", "exclude"), line = `/${dir}/`;
    try { if (!(existsSync(exclude) ? readFileSync(exclude, "utf8") : "").split("\n").includes(line)) appendFileSync(exclude, `\n${line}\n`); }
    catch { /* only git status is untidier */ }
  }
  return path;
}
