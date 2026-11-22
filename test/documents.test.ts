import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, Adapter, Receipt, Report, WorkItem } from "../src/contract.ts";
import { discoverDocuments, DocumentRegistry, extractCandidates, toSummary } from "../src/documents.ts";
import { Local } from "../src/local.ts";
import { parsePolicy, visible, type Policy } from "../src/policy.ts";
import { tools } from "../src/protocol.ts";
import { Transcript } from "../src/claude/transcript.ts";
import { removeDir, WINDOWS } from "./fixtures/platform.ts";

const prose = (title: string, body = "This document explains the architecture, tradeoffs, rollout plan, and open questions in enough detail to read aloud cleanly on a drive.") =>
  `# ${title}\n\n## Overview\n\n${body}\n\n## Decisions\n\n${body}\n`;

function temp(t: { after: (f: () => void) => void }, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => removeDir(dir));
  return dir;
}

test("policy documents defaults to off and validates allowed modes", () => {
  const base = { brain: "wss://brain.example/connector" };
  assert.equal(parsePolicy(JSON.stringify(base)).documents, "off");
  assert.equal(parsePolicy(JSON.stringify({ ...base, documents: false })).documents, "off");
  assert.equal(parsePolicy(JSON.stringify({ ...base, documents: "project" })).documents, "project");
  assert.equal(parsePolicy(JSON.stringify({ ...base, documents: "all" })).documents, "all");
  assert.throws(() => parsePolicy(JSON.stringify({ ...base, documents: "everything" })), /documents must be one of/);
  assert.ok(!tools(["follow_up"], false, false, false).some((t) => t.name === "read_document"));
  assert.ok(tools(["follow_up"], false, false, true).some((t) => t.name === "read_document"));
});

test("discoverDocuments handles project docs, worktree visibility inheritance, agent plan folders, and ignores code/fences/web URLs", async (t) => {
  const home = temp(t, "docs-home-");
  const proj = join(home, "projects", "game");
  const wt = join(home, "workspaces", "game", "t3-wt1");
  const agy = join(home, ".t3", "userdata", "providers", "antigravity", "h1", "brain", "u1");
  const claudePlans = join(home, ".claude", "plans");
  const codexWt = join(proj, ".codex", "worktrees", "w1");
  const copilotDir = join(home, ".copilot", "session-state", "s1");
  for (const d of [join(proj, "docs"), join(proj, "src"), join(wt, "docs"), agy, claudePlans, join(codexWt, "docs"), copilotDir]) {
    mkdirSync(d, { recursive: true });
  }
  const planFile = join(agy, "plan.md");
  writeFileSync(planFile, prose("Recursive Turret Defense"));
  writeFileSync(join(wt, "docs", "design.md"), prose("Worktree Design"));
  writeFileSync(join(proj, "docs", "arch.md"), prose("Architecture"));
  writeFileSync(join(proj, "src", "main.ts"), "export const x = 1;\n");
  writeFileSync(join(claudePlans, "cool-plan.md"), prose("Claude Plan"));
  writeFileSync(join(codexWt, "docs", "rollout.md"), prose("Codex Rollout"));
  writeFileSync(join(copilotDir, "plan.md"), prose("Copilot Plan"));

  const policy = parsePolicy(JSON.stringify({ brain: "wss://brain.example/connector", projects: [proj], documents: "all" }));
  const isVis = (f: string | null | undefined) => visible(policy, f);
  const noPrivacy = async () => null;

  // Off returns nothing
  const off = await discoverDocuments({
    threadId: "t1", replyText: `See [plan.md](file://${planFile})`, ctx: { agent: "t3", cwd: proj, projectRoot: proj },
    access: "off", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.equal(off.length, 0);

  // Project-only rejects external T3 artifact folder, accepts project doc
  const projOnly = await discoverDocuments({
    threadId: "t1", replyText: `See [plan.md](file://${planFile}) and [arch.md](docs/arch.md) and [main.ts:1](src/main.ts:1) and https://example.com/x.md\n\`\`\`md\n[ignored](docs/ignored.md)\n\`\`\``,
    ctx: { agent: "t3", cwd: proj, projectRoot: proj }, access: "project", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.deepEqual(projOnly.map((d) => [d.name, d.offer]), [["arch.md", "primary"]]);

  // All accepts T3 artifact folder + worktreeTrusted inherits visibility
  const t3All = await discoverDocuments({
    threadId: "t2", replyText: `Review [plan.md](file://${planFile}) and [design.md](docs/design.md)`,
    ctx: { agent: "t3", cwd: wt, projectRoot: proj, worktreeTrusted: true, waitTexts: [`Check [plan.md](file://${planFile})`] },
    access: "all", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.deepEqual(t3All.map((d) => [d.name, d.offer, d.reason]), [
    ["plan.md", "primary", "review_wait"],
    ["design.md", "secondary", "secondary_link"],
  ]);

  // Codex .codex/worktrees/ allowed inside project
  const codexDocs = await discoverDocuments({
    threadId: "cx1", replyText: `Wrote [rollout.md](${join(codexWt, "docs", "rollout.md")})`,
    ctx: { agent: "codex", cwd: codexWt, projectRoot: proj }, access: "project", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.deepEqual(codexDocs.map((d) => d.name), ["rollout.md"]);

  // Copilot implicit session-state/plan.md
  const copilotDocs = await discoverDocuments({
    threadId: "cp1", replyText: "I updated the plan.",
    ctx: { agent: "copilot", cwd: proj, projectRoot: proj, sessionDir: copilotDir }, access: "all", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.deepEqual(copilotDocs.map((d) => [d.name, d.reason, d.offer]), [["plan.md", "session_plan", "primary"]]);

  // Claude extraPaths (Write tool) finds unlinked plan
  const claudeDocs = await discoverDocuments({
    threadId: "cl1", replyText: "Drafted the rollout plan.",
    ctx: { agent: "claude", cwd: proj, projectRoot: proj, extraPaths: [join(claudePlans, "cool-plan.md")] },
    access: "all", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.deepEqual(claudeDocs.map((d) => d.name), ["cool-plan.md"]);
});

test("security: blocks symlink escapes, secret files, private projects, oversized/binary files, cross-thread ids, and TOCTOU swaps", async (t) => {
  const home = temp(t, "docs-sec-");
  const proj = join(home, "projects", "app");
  const priv = join(home, "private");
  mkdirSync(join(proj, "docs"), { recursive: true });
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(priv, { recursive: true });
  const secretFile = join(priv, "secret.md");
  writeFileSync(secretFile, prose("Top Secret"));
  writeFileSync(join(proj, ".git", "notes.md"), prose("Git Internal"));
  writeFileSync(join(proj, "docs", ".hidden.md"), prose("Hidden"));
  writeFileSync(join(proj, "docs", "huge.md"), "word ".repeat(100_000));
  writeFileSync(join(proj, "docs", "bin.md"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
  if (!WINDOWS) symlinkSync(secretFile, join(proj, "docs", "escape.md"));

  const policy = parsePolicy(JSON.stringify({ brain: "wss://brain.example/connector", projects: [proj], documents: "all" }));
  const isVis = (f: string | null | undefined) => visible(policy, f);
  const noPrivacy = async () => null;

  const bad = await discoverDocuments({
    threadId: "t1",
    replyText: [
      `[priv](${secretFile})`,
      `[git](${join(proj, ".git", "notes.md")})`,
      `[hidden](docs/.hidden.md)`,
      `[huge](docs/huge.md)`,
      `[bin](docs/bin.md)`,
      `[esc](docs/escape.md)`,
    ].join(" "),
    ctx: { agent: "claude", cwd: proj, projectRoot: proj }, access: "all", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.equal(bad.length, 0);

  // TOCTOU: edit updates hash; symlink swap fails at read time; cross-thread read fails
  const docPath = join(proj, "docs", "live.md");
  writeFileSync(docPath, prose("Live V1", "Bearer super_secret_token_999 and regular prose words for version one of the plan."));
  const docs = await discoverDocuments({
    threadId: "t1", replyText: "See [live.md](docs/live.md).",
    ctx: { agent: "claude", cwd: proj, projectRoot: proj }, access: "project", visibleProject: isVis, privacyCheck: noPrivacy, home,
  });
  assert.equal(docs.length, 1);
  const reg = new DocumentRegistry(noPrivacy);
  reg.register("t1", docs);

  const r1 = await reg.read("t1", docs[0]!.id, "project");
  assert.doesNotMatch(r1.text, /super_secret_token_999/);
  assert.match(r1.text, /Bearer \[REDACTED\]/);
  await assert.rejects(() => reg.read("t2", docs[0]!.id, "project"), /isn't linked/);
  await assert.rejects(() => reg.read("t1", "../etc/passwd", "project"), /isn't valid/);
  await assert.rejects(() => reg.read("t1", docs[0]!.id, "off"), /turned off/);

  writeFileSync(docPath, prose("Live V2", "Completely updated content for version two of the design document."));
  const r2 = await reg.read("t1", docs[0]!.id, "project");
  assert.notEqual(r1.contentHash, r2.contentHash);

  if (!WINDOWS) {
    unlinkSync(docPath);
    symlinkSync(secretFile, docPath);
    await assert.rejects(() => reg.read("t1", docs[0]!.id, "project"), /no longer inside/);
  }
});

test("Local integrates document discovery into report() and readDocument() without leaking paths", async (t) => {
  const dir = temp(t, "local-docs-");
  const proj = join(dir, "app");
  mkdirSync(join(proj, "docs"), { recursive: true });
  const planPath = join(proj, "docs", "plan.md");
  writeFileSync(planPath, prose("Launch Plan"));

  const fake: Adapter & { docContext(id: string): { agent: "claude"; cwd: string; projectRoot: string } } = {
    name: "claude", actions: [], connected: () => true,
    list: async (): Promise<WorkItem[]> => [],
    report: async (): Promise<Report> => ({ text: `Wrote [plan.md](docs/plan.md).`, question: null }),
    execute: async (_a: Action): Promise<Receipt> => ({ ok: false, error: "no" }),
    watch: () => () => {}, close: async () => {},
    docContext: () => ({ agent: "claude", cwd: proj, projectRoot: proj }),
  };
  const policy: Policy = parsePolicy(JSON.stringify({ brain: "wss://brain.example/connector", projects: [proj], documents: "project" }));
  const local = new Local([{ prefix: "cl", adapter: fake }], policy);

  assert.equal(local.documentsEnabled, true);
  const rep = await local.report("cl:s1");
  assert.equal(rep.docs?.length, 1);
  assert.equal(rep.docs![0]!.name, "plan.md");
  assert.equal(JSON.stringify(rep.docs).includes(proj), false, "no file path crosses the wire");
  const doc = await local.readDocument("cl:s1", rep.docs![0]!.id);
  assert.match(doc.text, /Launch Plan/);
});

test("ClaudeTranscript tracks Write tool prose doc paths per turn", (t) => {
  const dir = temp(t, "ct-docs-");
  const file = join(dir, "s.jsonl");
  const now = new Date().toISOString();
  writeFileSync(file, [
    JSON.stringify({ type: "user", uuid: "u1", cwd: dir, timestamp: now, message: { role: "user", content: "Write a plan" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", cwd: dir, timestamp: now, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/tmp/plan.md" } }] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", cwd: dir, timestamp: now, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } }),
  ].join("\n") + "\n");
  const tr = new Transcript(file);
  tr.read();
  assert.deepEqual(tr.writtenDocs, ["/tmp/plan.md"]);
});

test("extractCandidates strips code fences and anchors", () => {
  const cands = extractCandidates("See [plan](docs/plan.md#open) and `notes/a.txt:12`.\n```md\n[fake](docs/fake.md)\n```");
  assert.deepEqual(cands.map((c) => c.normalized), ["docs/plan.md", "notes/a.txt"]);
  assert.equal(typeof toSummary, "function");
});
