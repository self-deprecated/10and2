// Linked-document discovery, local authorization, safe file reading, and thread-bound document registry.
// Enforced strictly on the connector so the cloud brain never sends paths and can only read prose documents
// that a visible thread actually linked (or wrote as its plan), redacted before leaving the computer.
import { createHash } from "node:crypto";
import { closeSync, constants as fsConst, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DocSummary, DocumentText } from "./contract.ts";
import type { Agent, DocumentAccess } from "./policy.ts";
import { privacyRefusal } from "./privacy.ts";
import { redactText } from "./redact.ts";

/** Maximum bytes read from any linked document (200 KB). */
export const MAX_DOC_BYTES = 200 * 1024;
/** Prose extensions eligible to be served as linked documents. */
export const PROSE_EXTS = new Set([".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".org"]);
/** Segments blocked everywhere, even inside visible projects or agent roots. */
const FORBIDDEN_SEGMENTS = new Set([
  ".git", ".jj", ".hg", ".svn",
  ".ssh", ".gnupg", ".aws", ".kube", ".docker", ".npm", ".netrc",
  ".config", "node_modules",
]);
/** Dot-directories allowed inside a project root because coding agents place worktrees/plans there. */
const ALLOWED_PROJECT_DOT_DIRS = new Set([".codex", ".cursor", ".claude", ".github"]);
/** Basenames blocked regardless of extension (hidden files, common secret filenames). */
const FORBIDDEN_BASENAMES = [
  /^\./,
  /(?:^|[._-])(secret|secrets|credentials|private[_-]?key|id_rsa|id_ed25519)(?:[._-]|$)/i,
  /^env(?:\.|$)/i,
];
/** Maximum documents indexed per thread report, and maximum threads retained in the registry. */
const MAX_DOCS_PER_THREAD = 10;
const MAX_REGISTRY_ENTRIES = 2000;

export type ThreadDocContext = {
  agent: Agent;
  /** The thread's working directory or worktree path. */
  cwd?: string | null;
  /** The project's root folder (when different from a worktree cwd). */
  projectRoot?: string | null;
  /** Agent-specific session folder (Copilot session-state/<id>, Gemini tmp/<project>). */
  sessionDir?: string | null;
  /** Review wait / prompt texts that explicitly point to a document for review. */
  waitTexts?: string[];
  /** Extra file paths written by the agent during the latest turn (e.g. Claude Write tool). */
  extraPaths?: string[];
  /** True when `cwd` is a worktree of a project already verified visible by the adapter. */
  worktreeTrusted?: boolean;
};

export type DiscoveredDoc = DocSummary & {
  /** Internal canonical path; never serialized over the wire. */
  canonicalPath: string;
  allowedRoot: string;
};

const expandTilde = (p: string, home = homedir()) =>
  p === "~" ? home : p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\")) ? join(home, p.slice(2)) : p;

export function safeReal(p: string, home = homedir()): string | null {
  try { return realpathSync(resolve(expandTilde(p, home))); } catch { return null; }
}

function isInside(target: string, root: string, platform = process.platform): boolean {
  const norm = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const rel = relative(norm(root), norm(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Allowlisted coding-agent document roots outside project folders (active only when policy.documents === "all"). */
export function agentDocRoots(ctx: ThreadDocContext, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const roots: string[] = [];
  const t3Home = env.T3_HOME || join(home, ".t3");
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const geminiDir = join(env.GEMINI_CLI_HOME || home, ".gemini");
  const cursorDir = env.CURSOR_CONFIG_DIR || join(home, ".cursor");

  switch (ctx.agent) {
    case "t3":
      roots.push(join(t3Home, "userdata", "providers"));
      roots.push(join(t3Home, "scratch"));
      roots.push(join(claudeDir, "plans"));
      break;
    case "claude":
      roots.push(join(claudeDir, "plans"));
      break;
    case "gemini":
      if (ctx.sessionDir) roots.push(join(ctx.sessionDir, "plans"));
      roots.push(join(geminiDir, "tmp"));
      break;
    case "copilot":
      if (ctx.sessionDir) roots.push(ctx.sessionDir);
      break;
    case "cursor":
      roots.push(join(cursorDir, "plans"));
      break;
    case "codex":
    case "opencode":
    case "pi":
      break;
  }
  return roots.map((r) => safeReal(r, home)).filter((p): p is string => p !== null);
}

/** Strips fenced code blocks so example links inside ```markdown snippets aren't treated as linked documents. */
export function stripCodeFences(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence: string | null = null;
  for (const line of lines) {
    const m = /^\s*(```|~~~)/.exec(line);
    if (m) {
      if (!inFence) inFence = m[1]!;
      else if (line.trimStart().startsWith(inFence)) inFence = null;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

/** Normalizes a raw file reference: decodes file:// URLs, strips #fragment and :line, ignores web/custom schemes. */
export function normalizeCandidate(raw: string): string | null {
  let s = raw.trim().replace(/^<|>$/g, "");
  if (!s) return null;
  if (/^(?:https?|mailto|data|javascript|t3-context):/i.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.hostname && u.hostname !== "localhost") return null;
      s = decodeURIComponent(u.pathname);
      if (process.platform === "win32" && /^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
    } catch { return null; }
  } else {
    s = s.split(/[?#]/)[0]!;
    try { s = decodeURIComponent(s); } catch { /* keep literal */ }
  }
  s = s.replace(/:\d+(?:[:\-]\d+)*$/, "").replace(/[.,;:'")]+$/, "");
  return s || null;
}

/** Extracts candidate file references from reply prose (markdown links, backtick prose paths, bare abs/tilde prose paths). */
export function extractCandidates(text: string): { raw: string; normalized: string }[] {
  const clean = stripCodeFences(text);
  const found: { raw: string; normalized: string }[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const normalized = normalizeCandidate(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    found.push({ raw, normalized });
  };

  for (const m of clean.matchAll(/(?<!!)\[[^\]]+\]\(([^)\s]+(?:\s+[^)"]+)?)(?:\s+"[^"]*")?\)/g)) add(m[1]!);
  for (const m of clean.matchAll(/`([^`\n]{2,300})`/g)) {
    const inner = m[1]!.trim();
    if (!/\s{2,}/.test(inner) && /\.(?:md|markdown|mdx|txt|rst|adoc|org)(?:[:#][^\s]*)?$/i.test(inner)) add(inner);
  }
  for (const m of clean.matchAll(/(?:^|[\s(])((?:~\/|\/)[^\s"'`()<>]+?\.(?:md|markdown|mdx|txt|rst|adoc|org))(?:[:#][^\s"'`()<>]*)?(?=[\s.,;:'")]|$)/gi)) add(m[1]!);
  return found;
}

function checkPathSafety(canonical: string, allowedRoot: string): { ok: true } | { ok: false; reason: string } {
  const base = basename(canonical);
  const ext = extname(base).toLowerCase();
  if (!PROSE_EXTS.has(ext)) return { ok: false, reason: `not_prose_ext:${ext || "none"}` };
  for (const re of FORBIDDEN_BASENAMES) if (re.test(base)) return { ok: false, reason: `forbidden_basename:${base}` };
  if (!isInside(canonical, allowedRoot)) return { ok: false, reason: "outside_allowed_root" };
  for (const seg of canonical.split(sep).filter(Boolean)) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return { ok: false, reason: `forbidden_segment:${seg}` };
  }
  const rel = relative(allowedRoot, canonical);
  for (const seg of dirname(rel).split(sep).filter((s) => s && s !== ".")) {
    if (seg.startsWith(".") && !ALLOWED_PROJECT_DOT_DIRS.has(seg)) return { ok: false, reason: `hidden_dir:${seg}` };
  }
  return { ok: true };
}

/**
 * Reads a regular UTF-8 text file safely without blocking on FIFOs/devices or following a post-check symlink swap.
 */
export function safeReadTextFile(canonicalPath: string, maxBytes = MAX_DOC_BYTES): { ok: true; text: string; bytes: number } | { ok: false; reason: string } {
  let fd: number | null = null;
  try {
    const lst = lstatSync(canonicalPath);
    if (!lst.isFile()) return { ok: false, reason: `not_regular_file:${lst.isFIFO() ? "fifo" : lst.isSymbolicLink() ? "symlink" : lst.isDirectory() ? "dir" : "other"}` };
    if (lst.size > maxBytes) return { ok: false, reason: `too_large:${lst.size}` };

    const flags = fsConst.O_RDONLY | (fsConst.O_NOFOLLOW ?? 0) | (fsConst.O_NONBLOCK ?? 0);
    fd = openSync(canonicalPath, flags);
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { ok: false, reason: "fstat_not_regular_file" };
    if (fst.size > maxBytes) return { ok: false, reason: `too_large:${fst.size}` };

    const buf = Buffer.alloc(Math.min(fst.size + 1, maxBytes + 1));
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, null);
      if (n === 0) break;
      total += n;
    }
    if (total > maxBytes) return { ok: false, reason: `too_large_read:${total}` };
    const slice = buf.subarray(0, total);
    if (slice.subarray(0, Math.min(slice.length, 8192)).includes(0)) return { ok: false, reason: "binary_nul_byte" };
    return { ok: true, text: slice.toString("utf8"), bytes: total };
  } catch (e: any) {
    return { ok: false, reason: `io_error:${e?.code ?? e?.message ?? String(e)}` };
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function extractHeadings(text: string, max = 6): string[] {
  const out: string[] = [];
  for (const line of stripCodeFences(text).split("\n")) {
    const m = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const h = m[1]!.replace(/[*_`~]/g, "").trim();
      if (h) out.push(h.slice(0, 80));
      if (out.length >= max) break;
    }
  }
  return out;
}

export const docIdFor = (threadId: string, canonicalPath: string) =>
  createHash("sha256").update(`${threadId}\0${canonicalPath}`).digest("hex").slice(0, 16);

export const contentHashOf = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export const toSummary = ({ canonicalPath: _, allowedRoot: __, ...summary }: DiscoveredDoc): DocSummary => summary;

/**
 * Discovers, authorizes, inspects, and scores prose documents for one thread's reply.
 * Returns internal DiscoveredDoc entries (which the caller registers and strips to DocSummary before sending).
 */
export async function discoverDocuments(opts: {
  threadId: string;
  replyText: string;
  ctx: ThreadDocContext;
  access: DocumentAccess;
  visibleProject: (folder: string | null | undefined) => boolean;
  privacyCheck?: (dir: string) => Promise<string | null>;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): Promise<DiscoveredDoc[]> {
  const { threadId, replyText, ctx, access, visibleProject, privacyCheck = (d) => privacyRefusal(d), env = process.env, home = homedir() } = opts;
  if (access === "off") return [];

  const projectRoots: string[] = [];
  const addProjectRoot = (dir: string | null | undefined, trusted = false) => {
    if (!dir) return;
    if (!trusted && !visibleProject(dir)) return;
    const r = safeReal(dir, home);
    if (r && !projectRoots.includes(r)) projectRoots.push(r);
  };
  addProjectRoot(ctx.cwd, ctx.worktreeTrusted === true);
  addProjectRoot(ctx.projectRoot, false);
  const agentRoots = access === "all" ? agentDocRoots(ctx, env, home) : [];
  if (!projectRoots.length && !agentRoots.length) return [];

  const baseDir = ctx.cwd ? safeReal(ctx.cwd, home) : ctx.projectRoot ? safeReal(ctx.projectRoot, home) : null;
  const waitNormalized = new Set<string>();
  const candidates: { normalized: string; fromWait: boolean; implicit: boolean }[] = [];
  const seenNorm = new Set<string>();
  const push = (normalized: string, fromWait: boolean, implicit: boolean) => {
    if (seenNorm.has(normalized)) return;
    seenNorm.add(normalized);
    candidates.push({ normalized, fromWait, implicit });
  };

  for (const wt of ctx.waitTexts ?? []) {
    for (const c of extractCandidates(wt)) { waitNormalized.add(c.normalized); push(c.normalized, true, false); }
  }
  for (const c of extractCandidates(replyText)) push(c.normalized, waitNormalized.has(c.normalized), false);
  for (const p of ctx.extraPaths ?? []) {
    const n = normalizeCandidate(p);
    if (n) push(n, false, true);
  }
  if (access === "all" && ctx.agent === "copilot" && ctx.sessionDir) {
    const implicitPlan = join(ctx.sessionDir, "plan.md");
    if (existsSync(implicitPlan)) push(implicitPlan, false, true);
  }

  const accepted: (DiscoveredDoc & { _fromWait: boolean; _implicit: boolean })[] = [];
  const seenCanonical = new Set<string>();

  for (const cand of candidates) {
    if (accepted.length >= MAX_DOCS_PER_THREAD) break;
    const expanded = expandTilde(cand.normalized, home);
    const resolved = isAbsolute(expanded) ? expanded : baseDir ? resolve(baseDir, expanded) : null;
    if (!resolved || !PROSE_EXTS.has(extname(resolved).toLowerCase())) continue;

    // On macOS, avoid touching a TCC-protected folder until privacyRefusal approves it.
    if (await privacyCheck(dirname(resolved))) continue;

    const canonical = safeReal(resolved, home);
    if (!canonical || seenCanonical.has(canonical)) continue;
    if (await privacyCheck(dirname(canonical))) continue;

    const allowedRoot = projectRoots.find((r) => isInside(canonical, r)) ?? agentRoots.find((r) => isInside(canonical, r));
    if (!allowedRoot) continue;
    if (!checkPathSafety(canonical, allowedRoot).ok) continue;

    const read = safeReadTextFile(canonical);
    if (!read.ok) continue;
    const redacted = redactText(read.text);
    const words = redacted.trim().split(/\s+/).filter(Boolean).length;
    if (words < 20) continue;

    seenCanonical.add(canonical);
    accepted.push({
      id: docIdFor(threadId, canonical),
      name: basename(canonical),
      chars: redacted.length,
      words,
      minutes: Math.max(1, Math.round(words / 150)),
      headings: extractHeadings(redacted),
      contentHash: contentHashOf(redacted),
      reason: cand.fromWait ? "review_wait" : cand.implicit ? "session_plan" : "secondary_link",
      offer: "secondary",
      canonicalPath: canonical,
      allowedRoot,
      _fromWait: cand.fromWait,
      _implicit: cand.implicit,
    });
  }

  const hasWaitPrimary = accepted.some((d) => d._fromWait);
  return accepted.map(({ _fromWait, _implicit, ...d }) => ({
    ...d,
    reason: _fromWait ? "review_wait" : !hasWaitPrimary && accepted.length === 1 ? (_implicit ? "session_plan" : "primary_link") : _implicit ? "session_plan" : "secondary_link",
    offer: _fromWait || (!hasWaitPrimary && accepted.length === 1) ? "primary" : "secondary",
  }));
}

/**
 * In-memory registry mapping `(threadId, docId)` -> `{ canonicalPath, allowedRoot }`.
 * Re-verifies realpath, containment, macOS privacy, and O_NOFOLLOW at read time to defeat TOCTOU swaps.
 */
export class DocumentRegistry {
  private readonly entries = new Map<string, { threadId: string; canonicalPath: string; allowedRoot: string }>();
  private readonly privacyCheck: (dir: string) => Promise<string | null>;

  constructor(privacyCheck: (dir: string) => Promise<string | null> = (d) => privacyRefusal(d)) {
    this.privacyCheck = privacyCheck;
  }

  register(threadId: string, docs: DiscoveredDoc[]): void {
    for (const d of docs) {
      const key = `${threadId}\0${d.id}`;
      this.entries.delete(key);
      this.entries.set(key, { threadId, canonicalPath: d.canonicalPath, allowedRoot: d.allowedRoot });
    }
    while (this.entries.size > MAX_REGISTRY_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async read(threadId: string, docId: string, access: DocumentAccess): Promise<DocumentText> {
    if (access === "off") throw new Error("Document reading is turned off on this computer.");
    if (!/^[0-9a-f]{16}$/.test(docId)) throw new Error("That document id isn't valid.");
    const entry = this.entries.get(`${threadId}\0${docId}`);
    if (!entry) throw new Error("That document isn't linked to this thread.");

    const closed = await this.privacyCheck(dirname(entry.canonicalPath));
    if (closed) throw new Error(closed);
    const currentReal = safeReal(entry.canonicalPath);
    if (!currentReal || !isInside(currentReal, entry.allowedRoot)) {
      throw new Error("That document is no longer inside an allowed folder.");
    }
    const closedReal = await this.privacyCheck(dirname(currentReal));
    if (closedReal) throw new Error(closedReal);
    const safety = checkPathSafety(currentReal, entry.allowedRoot);
    if (!safety.ok) throw new Error("That document can't be read.");

    const read = safeReadTextFile(currentReal);
    if (!read.ok) throw new Error("That document couldn't be read.");
    const text = redactText(read.text);
    return { id: docId, name: basename(currentReal), text, contentHash: contentHashOf(text) };
  }
}
