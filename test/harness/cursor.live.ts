// Cursor's CLI agent, for real, through the connector's adapter: unlike the other harness tests this one can't run
// against the fake model in the container, since Cursor's CLI speaks only to Cursor's own servers. It uses this
// computer's signed-in `cursor-agent` and its ~/.cursor, and a handful of one-line prompts on the account's default
// model. Run it by hand, never in CI:
//   CURSOR_LIVE=1 node --test test/harness/cursor.live.ts
// Its chats are in a scratch project under the temp folder, and stay in Cursor's own chat list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { CursorAdapter } from "../../src/cursor/adapter.ts";
import type { Action, LaunchProfile } from "../../src/contract.ts";
import { has, project, Terminal, until } from "./lib.ts";

const skip = process.env.CURSOR_LIVE !== "1" ? "set CURSOR_LIVE=1 (uses Cursor's servers and the signed-in account)" : !has("cursor-agent") ? "cursor-agent isn't on PATH" : false;
const build: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "root", interactionMode: "default" };

test("Cursor CLI, live: start work, read it, continue it closed, refuse it open, start in a worktree, list models", { skip, timeout: 900_000 }, async (t) => {
  const cwd = project(), state = mkdtempSync(join(tmpdir(), "cursor-live-state-"));
  const adapter = new CursorAdapter({ db: join(state, "cursor.db"), stateDir: state, log: (m) => t.diagnostic(m), readCacheMs: 0, acceptanceTimeoutMs: 120_000,
    policy: { brain: "wss://unused.invalid/connector", projects: [resolve(cwd, "..")], actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access",
      claude: false, t3: false, codex: false, opencode: false, pi: false, cursor: true, steer: true, answer: true, limits: {}, worktreeBase: "HEAD" } });
  const tui = new Terminal("cursor");
  t.after(async () => { tui.stop(); Terminal.stopAll(); await adapter.close(); });
  await adapter.start();
  const item = async (id: string) => (await adapter.list()).find((i) => i.id === id);
  let id = "";

  await t.test("models: Cursor's list, named", async () => {
    await until("the models", () => (adapter as any).models.length > 0, 90_000);
    const models = (adapter as any).models as { id: string; name: string }[];
    assert.ok(models.some((m) => m.id === "auto" && m.name === "Auto"), JSON.stringify(models.slice(0, 3)));
    t.diagnostic(`${models.length} models`);
  });

  await t.test("start work in the project, then read its reply", async () => {
    // A place is a checkout one of its chats ran in; a first chat makes it one, as `cursor-agent` run there would.
    const { execFileSync } = await import("node:child_process");
    execFileSync("cursor-agent", ["-p", "--trust", "Reply with exactly: READY"], { cwd, encoding: "utf8", input: "" });
    await until("the project to be a place", () => adapter.places().length > 0, 30_000);
    const place = adapter.places()[0]!;
    const r = await adapter.execute({ kind: "start_work", placeId: place.id, message: "Reply with exactly: ACK LIVEONE", profile: build } as Action, "live-start") as { ok: boolean; itemId?: string; error?: string };
    assert.equal(r.ok, true, r.error ?? "");
    id = r.itemId!;
    await until("its reply", async () => (await adapter.report(id)).text.includes("ACK LIVEONE"), 180_000);
    const w = (await item(id))!;
    assert.equal(w.status, "completed");
    assert.equal(w.group, "lap-timer");
    assert.equal((await adapter.firstAsk(id))?.text, "Reply with exactly: ACK LIVEONE");
  });

  await t.test("follow up a closed chat: a turn of 10 & 2's own", async () => {
    await until("the run to end", async () => adapter.refusals()[id] === undefined, 60_000);
    const r = await adapter.execute({ kind: "follow_up", itemId: id, message: "Now reply with exactly: ACK LIVETWO" }, "live-follow");
    assert.deepEqual(r, { ok: true });
    await until("the second reply", async () => (await adapter.report(id)).text.includes("ACK LIVETWO"), 180_000);
    const replies = await adapter.replies(id);
    assert.ok(replies.length >= 2 && replies[0]!.prompt === "Now reply with exactly: ACK LIVETWO");
  });

  await t.test("a chat open in a terminal is listed but not sent to", { skip: !has("tmux") ? "needs tmux" : false }, async () => {
    await until("the run to end", async () => adapter.refusals()[id] === undefined, 60_000);
    tui.start(`sh -c 'cursor-agent --resume ${id}; echo "EXITED $?"; sleep 120'`, cwd);
    try { await until("the terminal to show the chat", () => tui.screen().includes("Add a follow-up"), 60_000); }
    finally { t.diagnostic(tui.screen().split("\n").filter((l) => l.trim()).slice(-8).join("\n")); }
    await until("10 & 2 to see it open", () => adapter.refusals()[id]?.follow_up?.includes("open in Cursor") === true, 30_000);
    const refused = await adapter.execute({ kind: "follow_up", itemId: id, message: "Not while it's open" }, "live-open");
    assert.match((refused as { error: string }).error, /open in Cursor/);
    tui.key("C-c"); await new Promise((r) => setTimeout(r, 1000)); tui.key("C-c");
    await until("the terminal to close it", () => tui.screen().includes("EXITED"), 30_000);
    await until("10 & 2 to see it closed", () => adapter.refusals()[id] === undefined, 30_000);
  });

  await t.test("start work in a worktree inside the project", async () => {
    const place = adapter.places()[0]!;
    const r = await adapter.execute({ kind: "start_work", placeId: place.id, message: "Reply with exactly: ACK LIVETREE", profile: { ...build, workspace: "worktree" } } as Action, "live-tree") as { ok: boolean; itemId?: string; error?: string };
    assert.equal(r.ok, true, r.error ?? "");
    await until("its reply", async () => (await adapter.report(r.itemId!)).text.includes("ACK LIVETREE"), 180_000);
    const rows = (adapter as any).rows as Map<string, { cwd: string }>;
    assert.ok(rows.get(r.itemId!)!.cwd.startsWith(join(cwd, ".cursor", "worktrees") + sep), rows.get(r.itemId!)!.cwd);
    assert.ok(existsSync(rows.get(r.itemId!)!.cwd));
    assert.equal((await item(r.itemId!))!.group, "lap-timer");
  });
});
