import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { answersFor, folderOf, instanceOn, mapStatus, newThreadModel, offeredModels, providerLabel, snoozedUntil, t3Home, t3Origin, T3Adapter, titleFrom, toCommand, toLaunch, type ShellThread, type T3Config, type T3Provider, type T3Settings } from "../src/t3/adapter.ts";
import { CONNECTOR_SCOPES, issueSession, revokeSession } from "../src/t3/auth.ts";
import { resolveCommand } from "../src/command.ts";
import { worktreeStart } from "../src/work.ts";
import type { LaunchProfile } from "../src/contract.ts";
import { ConnectionError, RpcClient, RpcError } from "../src/t3/rpc.ts";
import { nodeCommand, removeDir } from "./fixtures/platform.ts";

const thread = (id: string, over: Partial<ShellThread> = {}): ShellThread => ({
  id, projectId: "p1", title: `Thread ${id}`, status: "completed", updatedAt: "2026-10-16T08:00:00Z", ...over,
});

test("status, settled and snooze follow T3's own rules", () => {
  assert.equal(mapStatus(thread("a", { status: "running", pendingRuntimeRequest: { id: "r", kind: "user_input" } })), "waiting");
  assert.equal(mapStatus(thread("a", { status: "queued" })), "running");
  assert.equal(mapStatus(thread("a", { status: "interrupted" })), "cancelled");
  // A follow-up queued and cancelled while the first run still works: the thread is still running.
  assert.equal(mapStatus(thread("a", { status: "cancelled", activityRunStatus: "running" })), "running");
  const now = Date.parse("2026-10-16T09:00:00Z");
  assert.equal(snoozedUntil(thread("a", { snoozedUntil: "2026-10-17T08:00:00Z" }), now), "2026-10-17T08:00:00Z");
  assert.equal(snoozedUntil(thread("a", { snoozedUntil: "2026-10-15T08:00:00Z" }), now), null);
  // A run that finished after the snooze wakes it, as in T3's client.
  assert.equal(snoozedUntil(thread("a", { snoozedUntil: "2026-10-17T08:00:00Z", snoozedAt: "2026-10-16T07:00:00Z", latestRunCompletedAt: "2026-10-16T08:30:00Z" }), now), null);
});

test("T3 waiting is an active run unless it has a question for the user", () => {
  assert.equal(mapStatus(thread("a", { status: "waiting" })), "running");
  assert.equal(mapStatus(thread("a", { status: "waiting", pendingRuntimeRequest: { id: "r", kind: "user_input" } })), "waiting");
});

test("actions map to exactly the four allowed thread commands", () => {
  assert.deepEqual(toCommand({ kind: "settle", itemId: "t" }, "k"), { type: "thread.settle", commandId: "k", threadId: "t" });
  assert.deepEqual(toCommand({ kind: "archive", itemId: "t" }, "k"), { type: "thread.archive", commandId: "k", threadId: "t" });
  assert.deepEqual(toCommand({ kind: "snooze", itemId: "t", until: "2026-10-19T06:00:00.000Z" }, "k"), { type: "thread.snooze", commandId: "k", threadId: "t", snoozedUntil: "2026-10-19T06:00:00.000Z" });
  assert.deepEqual(toCommand({ kind: "unsnooze", itemId: "t" }, "k"), { type: "thread.unsnooze", commandId: "k", threadId: "t", reason: "user" });
  assert.deepEqual(toCommand({ kind: "unsettle", itemId: "t" }, "k"), { type: "thread.unsettle", commandId: "k", threadId: "t", reason: "user" });
  const f = toCommand({ kind: "follow_up", itemId: "t", message: "Go ahead." }, "k") as any;
  assert.equal(f.type, "message.dispatch");
  assert.deepEqual(f.dispatchMode, { type: "queue_after_active" });
  assert.equal(f.messageId, "driver:k");
});

test("a follow-up answers a question with the option it names, or else in its own words", () => {
  const host = { id: "host", options: [{ label: "Prism (Recommended)" }, { label: "Quartz", value: "quartz-mini" }] };
  assert.deepEqual(answersFor([host], "Prism."), { host: "Prism (Recommended)" });
  assert.deepEqual(answersFor([host], "quartz"), { host: "quartz-mini" });
  assert.deepEqual(answersFor([host], "Neither, use Lattice."), { host: "Neither, use Lattice." });
  // Asked several at once: each gets the whole message, which the agent reads in full.
  assert.deepEqual(answersFor([host, { id: "why" }], "Prism, it's free"), { host: "Prism, it's free", why: "Prism, it's free" });
  assert.match((answersFor([{ ...host, allowCustomAnswer: false }], "Lattice") as { error: string }).error, /Prism \(Recommended\) \/ Quartz/);
  assert.ok("error" in answersFor([], "Prism"), "a question that can't be found isn't answered blind");
});

/**
 * A fake T3: ticket endpoint plus a socket that speaks the captured Effect RPC frames. `threads` answers the HTTP API's
 * whole-thread snapshot (`/api/orchestration/threads/<id>`) with a projection, or a status to fail with.
 */
async function fakeT3(handlers: { onRequest: (frame: any, ws: WebSocket) => void; tokens?: Set<string>; threads?: (id: string) => object | number }) {
  const tokens = handlers.tokens ?? new Set(["good"]);
  const frames: any[] = [];
  const sockets: WebSocket[] = [];
  const threadReads: string[] = [];
  const http = createServer((req, res) => {
    const authorized = tokens.has(String(req.headers.authorization).replace("Bearer ", ""));
    if (req.url === "/api/auth/websocket-ticket" && req.method === "POST") {
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify(authorized ? { ticket: "tk" } : { error: "no" }));
    }
    const thread = /^\/api\/orchestration\/threads\/([^/?]+)$/.exec(req.url ?? "");
    if (thread && req.method === "GET") {
      const id = decodeURIComponent(thread[1]);
      threadReads.push(id);
      const answer = !authorized ? 401 : req.headers["x-t3-orchestration-protocol"] !== "2" ? 400 : (handlers.threads?.(id) ?? 404);
      if (typeof answer === "number") return res.writeHead(answer).end();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ snapshotSequence: 1, projection: answer }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url!, "http://x");
    if (url.searchParams.get("orchestrationProtocol") !== "2" || url.searchParams.get("wsTicket") !== "tk") {
      socket.end("HTTP/1.1 426 Upgrade Required\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (d) => {
        const f = JSON.parse(String(d));
        frames.push(f);
        if (f._tag === "Request") handlers.onRequest(f, ws);
      });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, frames, sockets, threadReads, close: () => { for (const s of sockets) s.terminate(); wss.close(); http.close(); } };
}
const exit = (ws: WebSocket, requestId: number, value: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Success", value } }));
const fail = (ws: WebSocket, requestId: number, message: string) =>
  ws.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "EnvironmentAuthorizationError", message } } } }));

test("RpcClient: requests, failures, streams with acks, and pings", async () => {
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "echo") return exit(ws, f.id, f.payload);
      if (f.tag === "denied") return fail(ws, f.id, "missing required scope: orchestration:operate.");
      if (f.tag === "stream") {
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [1, 2] }));
        ws.send(JSON.stringify({ _tag: "Ping" }));
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [3] }));
      }
    },
  });
  try {
    const c = await RpcClient.connect(t3.base, "good");
    assert.deepEqual(await c.request("echo", { a: 1 }), { a: 1 });
    await assert.rejects(c.request("denied", {}), (e: unknown) => e instanceof RpcError && e.tag === "EnvironmentAuthorizationError" && /orchestration:operate/.test(e.message));
    const got: unknown[] = [];
    const stop = c.stream("stream", {}, (v) => got.push(v), () => {});
    await new Promise((r) => setTimeout(r, 100));
    stop();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(got, [1, 2, 3]);
    const tags = t3.frames.map((f) => f._tag);
    assert.equal(tags.filter((t) => t === "Ack").length, 2);
    assert.ok(tags.includes("Pong"));
    assert.ok(tags.includes("Interrupt"));
    await assert.rejects(RpcClient.connect(t3.base, "bad"), (e: unknown) => e instanceof RpcError && e.tag === "Unauthorized");
    c.close();
  } finally {
    t3.close();
  }
});

test("T3Adapter: lists from the shell, ignores thread-less snapshots, reports changes, sends commands", async () => {
  const commands: any[] = [];
  let runStatus = "running";
  let shellSocket: WebSocket | null = null;
  let shellId = -1;
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        shellSocket = ws;
        shellId = f.id;
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: {
          projects: [{ id: "p1", title: "nix" }],
          threads: [
            thread("a", { lastVisitedAt: "2026-10-16T07:00:00Z", latestUserAuthoredMessageAt: "2026-10-16T06:50:00Z" }),
            thread("kid", { lineage: { parentThreadId: "a", relationshipToParent: "subagent" } }),
            thread("gone", { archivedAt: "2026-10-01T00:00:00Z" }),
          ],
        } }] }));
      } else if (f.tag === "orchestration.getThreadProjection" && f.payload?.threadId === "kid") {
        // A run is going: its notes are progress, and the reply is the finished run's last message.
        exit(ws, f.id, {
          // r3 failed without a reply: the reply is still r1's.
          // r0 was the agent's own, woken by a background task finishing.
          runs: [{ id: "r0", status: "completed", completedAt: "2026-10-16T07:10:00Z", userMessageId: "w0" }, { id: "r1", status: "completed", completedAt: "2026-10-16T07:30:00Z" }, { id: "r3", status: "failed", completedAt: "2026-10-16T07:40:00Z" }, { id: "r2", status: runStatus }],
          messages: [
            { id: "w0", role: "user", text: 'Background command "tests" completed (exit code 0)', streaming: false, runId: "r0", createdBy: "agent" },
            { id: "m0", role: "assistant", text: "The tests passed.", streaming: false, runId: "r0" },
            { id: "m1", role: "assistant", text: "Done: it builds.", streaming: false, runId: "r1" },
            { id: "m3", role: "user", text: "try again", streaming: false, runId: "r3" },
            { role: "user", text: "now test it", streaming: false, runId: "r2" },
            { role: "assistant", text: "Next I'll run the tests.", streaming: false, runId: "r2" },
          ],
          turnItems: [],
        });
      } else if (f.tag === "orchestration.getThreadProjection") {
        exit(ws, f.id, {
          messages: [
            { role: "assistant", text: "Older.", streaming: false },
            { role: "user", text: "ok", streaming: false },
            { role: "assistant", text: "Should I commit it?", streaming: false },
            { role: "assistant", text: "partial", streaming: true },
          ],
          turnItems: [{ type: "user_input_request", requestId: "r1", questions: [{ id: "q1", question: "Which host?", options: [{ label: "Prism" }, { label: "Quartz" }] }] }],
        });
      } else if (f.tag === "orchestration.dispatchCommand") {
        commands.push(f.payload);
        exit(ws, f.id, { sequence: 7 });
      }
    },
  });
  const revoked: string[] = [];
  const adapter = new T3Adapter({
    baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {},
    auth: { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async (id) => void revoked.push(id) },
  });
  try {
    await adapter.start();
    const items = await adapter.list();
    assert.deepEqual(items.map((i) => [i.id, i.group, i.parentId, i.visitedAt, i.wroteAt]), [["a", "nix", null, "2026-10-16T07:00:00Z", "2026-10-16T06:50:00Z"], ["kid", "nix", "a", null, null]]);

    const changes: [string[], boolean][] = [];
    adapter.watch((ids, urgent) => changes.push([ids, urgent]));
    const push = (v: unknown) => shellSocket!.send(JSON.stringify({ _tag: "Chunk", requestId: shellId, values: [v] }));
    push({ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [] } }); // project refresh only
    push({ kind: "thread.updated", location: "active", thread: thread("a", { updatedAt: "2026-10-16T08:05:00Z" }) }); // churn only
    push({ kind: "thread.updated", location: "active", thread: thread("a", { status: "running", pendingRuntimeRequest: { id: "r1", kind: "user_input" } }) });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await adapter.list()).length, 2, "a thread-less snapshot must not wipe the list");
    assert.deepEqual(changes, [[["a"], true]]);

    const rep = await adapter.report("a");
    assert.equal(rep.text, "Should I commit it?");
    assert.equal(rep.question, "Which host? Options: Prism / Quartz.");
    assert.equal(rep.progress, null);
    assert.equal(rep.reply, null, "a message without an id or a time can't be told apart, so it isn't a reply to track");
    const kid = { text: "Done: it builds.", progress: "Next I'll run the tests.", question: null, reply: { runId: "r1", messageId: "m1", at: "2026-10-16T07:30:00Z" }, earlier: ["2026-10-16T07:10:00Z"] };
    assert.deepEqual(await adapter.report("kid"), kid, "the reply is r1's, finished when r1 did: r3 failed without one; r0's before it");
    runStatus = "waiting";
    assert.deepEqual(await adapter.report("kid"), kid, "waiting notes are still progress, not a finished reply");
    assert.deepEqual(await adapter.replies("kid"), [
      { ...kid.reply, text: "Done: it builds.", prompt: null },
      { runId: "r0", messageId: "m0", at: "2026-10-16T07:10:00Z", byAgent: true, text: "The tests passed.", prompt: null },
    ], "only finished runs with a reply, r3 failed without one; a run the agent started itself says so");

    assert.deepEqual(await adapter.execute({ kind: "settle", itemId: "a" }, "P-1:a"), { ok: true });
    assert.deepEqual(await adapter.markRead("a", "2026-10-16T08:05:00Z", "driver-visit:m1"), { ok: true });
    // "a" is asking which host: a follow-up answers it rather than queueing behind it. "kid" asks nothing.
    assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: "a", message: "Quartz" }, "P-2:a"), { ok: true });
    assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: "kid", message: "Go on." }, "P-3:kid"), { ok: true });
    assert.deepEqual(commands.slice(2).map((c) => [c.type, c.answers]), [["runtime-request.respond", { q1: "Quartz" }], ["message.dispatch", undefined]]);
    assert.deepEqual(commands[2], { type: "runtime-request.respond", commandId: "P-2:a", threadId: "a", requestId: "r1", answers: { q1: "Quartz" } });
    // An approval isn't Driver's to give: a follow-up says where to answer it, and sends nothing.
    push({ kind: "thread.updated", location: "active", thread: thread("a", { status: "running", pendingRuntimeRequest: { id: "r2", kind: "command_execution_approval" } }) });
    await new Promise((r) => setTimeout(r, 100));
    const sent = commands.length;
    assert.match((await adapter.execute({ kind: "follow_up", itemId: "a", message: "Yes" }, "P-4:a") as { error: string }).error, /answer it in T3 Code/);
    assert.equal(commands.length, sent);
    assert.deepEqual(commands.slice(0, 2), [
      { type: "thread.settle", commandId: "P-1:a", threadId: "a" },
      { type: "thread.visit", commandId: "driver-visit:m1", threadId: "a", visitedAt: "2026-10-16T08:05:00Z" },
    ]);
  } finally {
    await adapter.close();
    t3.close();
  }
  assert.deepEqual(revoked, ["s1"], "closing revokes the brain's session");
});

test("T3Adapter: when a thread started, and its first ask: the user's own, complete only when the read held every row", async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, position) => ({ position }));
  const note = { id: "w", role: "user", text: 'Background command "tests" completed (exit code 0)', createdBy: "agent", createdAt: "2026-11-16T14:59:00.000Z" };
  const projections: Record<string, unknown> = {
    // Out of order, after a note the agent wrote itself.
    short: { messages: [note,
      { id: "m2", role: "user", text: "And add tests.", createdBy: "user", createdAt: "2026-11-16T15:10:00.000Z" },
      { id: "m1", role: "user", text: "  Make the screenshots sharper.\n", createdBy: "user", createdAt: "2026-11-16T15:00:05.000Z" },
      { id: "r1", role: "assistant", text: "Done.", createdAt: "2026-11-16T15:05:00.000Z" }], visibleTurnItems: rows(4) },
    // A long thread's recent window: the oldest ask it holds isn't the first.
    long: { messages: [{ id: "m9", role: "user", text: "x".repeat(9000), createdBy: "user", createdAt: "2026-11-17T08:00:00.000Z" }], visibleTurnItems: rows(75) },
    // A server whose shell doesn't count rows: it can't be told, so it isn't complete.
    uncounted: { messages: [{ id: "m1", role: "user", text: "Fix the login.", createdBy: "user", createdAt: "2026-11-15T10:00:00.000Z" }], visibleTurnItems: rows(2) },
    agent: { messages: [note], visibleTurnItems: rows(2) },
  };
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [
          thread("short", { createdAt: "2026-11-16T15:00:00.000Z", visibleItemCount: 4 }),
          thread("long", { createdAt: "2026-11-01T09:00:00.000Z", visibleItemCount: 900 }),
          thread("uncounted"),
          thread("agent", { createdAt: "2026-11-16T14:58:00.000Z", visibleItemCount: 2 }),
        ] } }] }));
      } else if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projections[f.payload.threadId]);
    },
  });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  try {
    await adapter.start();
    assert.deepEqual((await adapter.list()).map((i) => [i.id, i.createdAt]), [["short", "2026-11-16T15:00:00.000Z"], ["long", "2026-11-01T09:00:00.000Z"], ["uncounted", null], ["agent", "2026-11-16T14:58:00.000Z"]]);
    assert.deepEqual(await adapter.firstAsk("short"), { text: "Make the screenshots sharper.", at: "2026-11-16T15:00:05.000Z", complete: true });
    const long = await adapter.firstAsk("long");
    assert.deepEqual([long?.text.length, long?.complete], [8000, false], "cut to 8000 characters; a window of 75 of 900 rows isn't the whole thread");
    assert.equal((await adapter.firstAsk("uncounted"))?.complete, false);
    assert.equal(await adapter.firstAsk("agent"), null, "a note the agent wrote itself isn't the user's ask");
  } finally {
    await adapter.close();
    t3.close();
  }
});

test("T3Adapter: a run longer than the projection's window still has the replies before it, read from the whole thread", async () => {
  // T3's getThreadProjection holds only a long thread's newest rows (75), runs included: while a long run goes, it has
  // that run's notes and nothing else (18 November: "read me the latest response" got "no finished reply yet", with 14
  // finished runs behind the one going). The shell says nothing has ended while a run goes: latestRunCompletedAt is the
  // newest run's.
  const rows = (n: number) => Array.from({ length: n }, (_, position) => ({ position }));
  const r1 = { id: "r1", ordinal: 1, status: "completed", completedAt: "2026-11-18T09:15:52Z", userMessageId: "u1" };
  const r2 = { id: "r2", ordinal: 2, status: "completed", completedAt: "2026-11-18T18:20:00Z", userMessageId: "u2" };
  // Rolled back by the user: T3 keeps it in the whole snapshot, dated when it was rolled back, but not in the thread.
  const rx = { id: "rx", ordinal: 3, status: "rolled_back", completedAt: "2026-11-18T18:27:39Z", userMessageId: "ux" };
  let r4: any = { id: "r4", ordinal: 4, status: "running", userMessageId: "u4" };
  const said = (id: string, runId: string, role: string, text: string) => ({ id, runId, role, text, streaming: false });
  const earlier = [said("u1", "r1", "user", "Plan the ads."), said("a1a", "r1", "assistant", "Researching first."), said("a1", "r1", "assistant", "Here's the plan."),
    said("u2", "r2", "user", "Make them."), said("a2", "r2", "assistant", "Four drafts are made."),
    said("ux", "rx", "user", "Make them louder."), said("ax", "rx", "assistant", "Louder drafts are made.")];
  let latest = [said("u4", "r4", "user", "Animate them."), said("p4", "r4", "assistant", "Landing on main now.")];
  let push: (v: any) => void = () => {};
  const logs: string[] = [];
  const running = (over: Partial<ShellThread> = {}) =>
    thread("ads", { status: "running", activityRunStatus: "running", latestRunId: "r4", activeRunId: "r4", latestRunCompletedAt: null, visibleItemCount: 438, ...over });
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
        push({ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "driver" }], threads: [
          running(),
          thread("fresh", { status: "running", activityRunStatus: "running", latestRunId: "f1", activeRunId: "f1", latestRunCompletedAt: null, visibleItemCount: 300 }),
          thread("short", { latestRunId: "b2", latestRunCompletedAt: "2026-11-18T10:00:00Z", activeRunId: null, visibleItemCount: 3 }),
          thread("broken", { latestRunId: "b2", latestRunCompletedAt: "2026-11-18T10:00:00Z", activeRunId: null, visibleItemCount: 200 }),
        ] } });
      } else if (f.tag === "orchestration.getThreadProjection" && f.payload.threadId === "ads") {
        exit(ws, f.id, { runs: [r4], messages: latest, turnItems: [], visibleTurnItems: rows(75) });
      } else if (f.tag === "orchestration.getThreadProjection" && f.payload.threadId === "fresh") {
        exit(ws, f.id, { runs: [{ id: "f1", ordinal: 1, status: "running" }], messages: [said("fp", "f1", "assistant", "Still reading.")], turnItems: [], visibleTurnItems: rows(75) });
      } else if (f.tag === "orchestration.getThreadProjection") {
        // "short" is all here (3 of 3 rows); "broken" is a window of a thread T3 then can't give whole.
        exit(ws, f.id, { runs: [{ id: "b2", ordinal: 2, status: "completed", completedAt: "2026-11-18T10:00:00Z" }], messages: [said("bm", "b2", "assistant", "The latest only.")], turnItems: [],
          visibleTurnItems: rows(f.payload.threadId === "short" ? 3 : 75) });
      }
    },
    threads: (id) => (id === "ads" ? { runs: [r1, r2, rx, r4], messages: [...earlier, ...latest] } : 500),
  });
  const adapter = new T3Adapter({
    baseUrl: t3.base, cli: ["t3"], label: "test", log: (m) => logs.push(m),
    auth: { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} },
  });
  try {
    await adapter.start();
    assert.deepEqual(await adapter.report("ads"), {
      text: "Four drafts are made.", progress: "Landing on main now.", question: null, reply: { runId: "r2", messageId: "a2", at: r2.completedAt }, earlier: [r1.completedAt],
    }, "the last finished run's reply and the one before it (not the rolled-back one), with the run going as progress");
    // The run works on: the shell's updatedAt moves with every row, which doesn't make the thread worth reading again.
    push({ kind: "thread.updated", location: "active", thread: running({ updatedAt: "2026-11-18T19:47:40Z" }) });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await adapter.replies("ads"), [
      { runId: "r2", messageId: "a2", at: r2.completedAt, text: "Four drafts are made.", prompt: "Make them." },
      { runId: "r1", messageId: "a1", at: r1.completedAt, text: "Here's the plan.", prompt: "Plan the ads." },
    ]);
    assert.equal((await adapter.report("ads")).text, "Four drafts are made.");
    assert.deepEqual(t3.threadReads, ["ads"], "read whole once, and kept while the same run goes");

    // The long run ends: its reply is in the window, and the whole thread is read again for the replies before it.
    r4 = { ...r4, status: "completed", completedAt: "2026-11-18T19:48:12Z" };
    latest = [...latest, said("a4", "r4", "assistant", "Five drafts are up.")];
    push({ kind: "thread.updated", location: "active", thread: running({ status: "completed", activityRunStatus: null, activeRunId: null, latestRunCompletedAt: r4.completedAt, visibleItemCount: 439 }) });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await adapter.report("ads")).text, "Five drafts are up.");
    assert.deepEqual(t3.threadReads, ["ads"], "a reply in the window needs no whole read");
    assert.deepEqual((await adapter.replies("ads")).map((r) => r.messageId), ["a4", "a2", "a1"]);
    assert.deepEqual(t3.threadReads, ["ads", "ads"]);

    // A first run still going has no reply before it, and a window that holds every row is the whole thread.
    assert.deepEqual(await adapter.report("fresh"), { text: "", progress: "Still reading.", question: null, reply: null, earlier: [] });
    assert.deepEqual((await adapter.replies("short")).map((r) => r.text), ["The latest only."]);
    assert.deepEqual(t3.threadReads, ["ads", "ads"], "neither is read whole");

    // Where the whole thread can't be read, the window's replies are given, at once for a while after.
    assert.deepEqual((await adapter.replies("broken")).map((r) => r.text), ["The latest only."]);
    assert.deepEqual((await adapter.replies("broken")).map((r) => r.text), ["The latest only."]);
    assert.deepEqual(t3.threadReads, ["ads", "ads", "broken"], "a failed read isn't tried again straight away");
    assert.equal(logs.filter((l) => l.includes("couldn't read the whole of thread broken (HTTP 500)")).length, 1, logs.join("\n"));
  } finally {
    await adapter.close();
    t3.close();
  }
});

test("T3Adapter: whole reads at once share one renewed session, and a long thread's replies are cut to what the link carries", async () => {
  const issued: string[] = [];
  const revoked: string[] = [];
  const t3 = await fakeT3({
    tokens: new Set(["t1", "t2", "t3"]),
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "driver" }],
          threads: ["x", "y", "z"].map((id) => thread(id, { latestRunId: "r2", latestRunCompletedAt: "2026-11-18T10:00:00Z", activeRunId: null, visibleItemCount: 500 })) } }] }));
      } else if (f.tag === "orchestration.getThreadProjection") {
        exit(ws, f.id, { runs: [], messages: [], turnItems: [], visibleTurnItems: [] });
      }
    },
    // "z" has 6 replies of a megabyte each: more than the link carries in one message.
    threads: (id) => {
      const n = id === "z" ? 6 : 1;
      const runs = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, ordinal: i + 1, status: "completed", completedAt: `2026-11-18T1${i}:00:00Z` }));
      return { runs, messages: runs.map((r, i) => ({ id: `m${i}`, runId: r.id, role: "assistant", text: (id === "z" ? "x".repeat(1 << 20) : "Done.") + i, streaming: false })) };
    },
  });
  const logs: string[] = [];
  const adapter = new T3Adapter({
    baseUrl: t3.base, cli: ["t3"], label: "test", log: (m) => logs.push(m),
    // The first session is in its last hour, so the next caller renews it.
    auth: {
      issue: async () => {
        issued.push(`t${issued.length + 1}`);
        await new Promise((r) => setTimeout(r, 20));
        return { token: issued.at(-1)!, sessionId: issued.at(-1)!, expiresAt: new Date(Date.now() + (issued.length === 1 ? 1_800_000 : 86_400_000)).toISOString() };
      },
      revoke: async (id) => void revoked.push(id),
    },
  });
  try {
    await adapter.start();
    const [x, y] = await Promise.all([adapter.replies("x"), adapter.replies("y")]);
    assert.deepEqual([x.length, y.length], [1, 1]);
    assert.deepEqual([issued, revoked], [["t1", "t2"], ["t1"]], "one renewal for both, and the old session revoked once");
    const z = await adapter.replies("z");
    assert.deepEqual(z.map((r) => r.messageId), ["m5", "m4", "m3"], "the newest replies that fit in 4 MB");
    assert.ok(logs.some((l) => l.includes("thread z has 6 replies; giving the newest 3")), logs.join("\n"));
  } finally {
    await adapter.close();
    t3.close();
  }
  assert.deepEqual(revoked, ["t1", "t2"], "closing revokes the renewed session");
});

test("a request T3 never answers times out as a ConnectionError (outcome unknown)", async () => {
  const t3 = await fakeT3({ onRequest: () => {} });
  try {
    const c = await RpcClient.connect(t3.base, "good");
    await assert.rejects(c.request("slow", {}, 100), (e: unknown) => e instanceof ConnectionError);
    c.close();
  } finally {
    t3.close();
  }
});

test("T3Adapter: a dropped socket mid-command is unknown; a rejected session stops for good", async () => {
  let socket: WebSocket | null = null;
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        socket = ws;
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [thread("a")] } }] }));
      }
      if (f.tag === "orchestration.dispatchCommand") ws.terminate(); // applied or not, we can't know
    },
  });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  try {
    await adapter.start();
    const r = await adapter.execute({ kind: "settle", itemId: "a" }, "P-1:a");
    assert.equal(r.ok, false);
    assert.equal((r as any).unknown, true);
    assert.ok(socket);
  } finally {
    await adapter.close();
    t3.close();
  }

  const t3b = await fakeT3({ onRequest: () => {}, tokens: new Set(["other"]) });
  const rejected = new T3Adapter({ baseUrl: t3b.base, cli: ["t3"], label: "test", log: () => {}, auth });
  try {
    await assert.rejects(rejected.start(), /refused the connector's session/);
    assert.deepEqual(await rejected.execute({ kind: "settle", itemId: "a" }, "k"), { ok: false, error: "10 & 2's access to T3 was revoked." });
  } finally {
    await rejected.close();
    t3b.close();
  }
});

test("T3Adapter: until T3 has answered, marking read is to be tried again, not given up as unsupported", async () => {
  const adapter = new T3Adapter({ baseUrl: "http://127.0.0.1:9", cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => { throw new Error("no"); }, revoke: async () => {} } });
  const r = await adapter.markRead("a", "2026-10-16T08:00:00Z", "k");
  assert.notEqual(r, "unsupported");
  assert.equal(r !== "unsupported" && r.ok, false);
});

const build: LaunchProfile = { name: "Build", workspace: "worktree", runtimeMode: "full-access", interactionMode: "default" };

test("a launch is built in code: the profile's modes, a worktree of the policy's base or the root, never a path", () => {
  const start = { kind: "start_work" as const, placeId: "p1", title: "Launch profiles", message: "Add launch profiles.", profile: build };
  assert.deepEqual(toLaunch(start, "P-1:start", { instanceId: "codex", model: "gpt-6" }), {
    commandId: "P-1:start", creationSource: "mobile", projectId: "p1", title: "Launch profiles", generateTitle: false,
    modelSelection: { instanceId: "codex", model: "gpt-6" }, runtimeMode: "full-access", interactionMode: "default",
    workspaceStrategy: { type: "worktree", baseRef: "HEAD" }, initialMessage: { text: "Add launch profiles.", attachments: [] },
  });
  const plan = toLaunch({ ...start, profile: { name: "Here", workspace: "root", runtimeMode: "approval-required", interactionMode: "plan" } }, "k", {}) as any;
  assert.deepEqual(plan.workspaceStrategy, { type: "root" });
  assert.deepEqual((toLaunch(start, "k", {}, "main") as any).workspaceStrategy, { type: "worktree", baseRef: "main", startFromOrigin: true }, "a branch is fetched from origin first");
  assert.deepEqual((toLaunch(start, "k", {}, "HEAD") as any).workspaceStrategy, { type: "worktree", baseRef: "HEAD" });
  assert.deepEqual((toLaunch({ ...start, profile: { ...build, workspace: "root" } }, "k", {}, "main") as any).workspaceStrategy, { type: "root" }, "the checkout itself ignores it");
  assert.equal(plan.interactionMode, "plan");
  assert.throws(() => toCommand(start, "k"), "start_work never goes through dispatchCommand");
  assert.deepEqual((toLaunch(start, "k", {}, null) as any).workspaceStrategy, { type: "root" }, "a folder that isn't a repository runs in itself");
});

test("a launch with no title has T3 name the thread from its message, with a seed from it until then", () => {
  const message = "(Dictated by voice in 10 & 2 and transcribed on my phone.)\n\nAdd gift cards to checkout, with a balance page and tests for every edge case.";
  const launch = toLaunch({ kind: "start_work", placeId: "p1", message, profile: build }, "P-2:start", {}) as any;
  assert.deepEqual([launch.title, launch.generateTitle, launch.initialMessage.text], ["Add gift cards to checkout, with a balance page…", true, message]);
  assert.equal(titleFrom("Fix the login."), "Fix the login");
});

test("a new worktree starts from the policy's branch where the repository has it, HEAD where it doesn't, and nowhere outside a repository", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worktree-start-"));
  t.after(() => removeDir(dir));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  const repo = (name: string, branch: string) => {
    const r = join(dir, name);
    git(dir, "init", "-q", "-b", branch, r);
    git(r, "commit", "-q", "--allow-empty", "-m", "first");
    return r;
  };
  const main = repo("main", "main"), master = repo("master", "master");
  const notes = join(dir, "notes");
  mkdirSync(notes);
  assert.equal(await worktreeStart(main, "main"), "main");
  assert.equal(await worktreeStart(main, "HEAD"), "HEAD");
  assert.equal(await worktreeStart(master, "main"), "HEAD", "no main here or on origin: the checkout's commit, rather than a failed launch");
  // A branch only on origin counts, as T3 fetches it.
  const clone = join(dir, "clone");
  git(dir, "clone", "-q", main, clone);
  git(clone, "checkout", "-q", "--detach");
  git(clone, "branch", "-q", "-D", "main");
  assert.equal(await worktreeStart(clone, "main"), "main");
  assert.equal(await worktreeStart(notes, "main"), null);
  assert.equal(await worktreeStart(notes, "HEAD"), null);
  assert.equal(await worktreeStart(join(dir, "gone"), "main"), null);
});

test("T3Adapter: places are the shell's projects; a launch uses the project's model, is named at once, and repeats as the same thread", async () => {
  const launches: any[] = [];
  const byCommand = new Map<string, string>();
  let push: (v: any) => void = () => {};
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
        push({ kind: "snapshot", snapshot: {
          projects: [{ id: "p1", title: "nix", defaultModelSelection: null, workspaceRoot: "/home/x/mono/nix", repositoryIdentity: { name: "mono-nix" } }, { id: "p2", title: "driver", defaultModelSelection: { instanceId: "claude", model: "opus" } }],
          threads: [
            thread("old", { updatedAt: "2026-10-15T08:00:00Z", modelSelection: { instanceId: "codex", model: "old" } }),
            thread("new", { updatedAt: "2026-10-16T08:00:00Z", modelSelection: { instanceId: "codex", model: "gpt-6" } }),
          ],
        } });
      } else if (f.tag === "server.getConfig") {
        // A T3 that doesn't give its settings: the project's own model, as before 20 November.
        fail(ws, f.id, "not allowed");
      } else if (f.tag === "orchestration.launchThread") {
        launches.push(f.payload);
        if (f.payload.title === "Refused") return fail(ws, f.id, "Provider instance codex is disabled.");
        const resumed = byCommand.has(f.payload.commandId);
        const id = byCommand.get(f.payload.commandId) ?? `t${byCommand.size + 1}`;
        byCommand.set(f.payload.commandId, id);
        exit(ws, f.id, { threadId: id, projection: {}, resumed });
        // The thread reaches the shell stream a little after the launch answers.
        if (!resumed) setTimeout(() => push({ kind: "thread.updated", location: "active", thread: thread(id, { projectId: f.payload.projectId, title: f.payload.title, status: "running" }) }), 30);
      }
    },
  });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  try {
    await adapter.start();
    // With the end of its checkout's path and its repository's name: other names for it (brain/src/places.ts).
    // No models: this T3 doesn't give its config.
    assert.deepEqual(adapter.places(), [{ id: "p1", name: "nix", activeAt: "2026-10-16T08:00:00Z", folder: "mono/nix", repo: "mono-nix", models: [] }, { id: "p2", name: "driver", activeAt: null, models: [] }]);
    const start = { kind: "start_work" as const, placeId: "p1", title: "Launch profiles", message: "Add them.", profile: build };
    assert.deepEqual(await adapter.execute(start, "P-1:start"), { ok: true, itemId: "t1" });
    assert.deepEqual(launches[0].modelSelection, { instanceId: "codex", model: "gpt-6" }, "the project's most recently active thread's model");
    assert.ok(!JSON.stringify(launches).includes("/home"), "no path is ever sent");
    assert.deepEqual((await adapter.list()).find((i) => i.id === "t1")?.title, "Launch profiles", "named as soon as the launch returns");
    assert.deepEqual(await adapter.execute(start, "P-1:start"), { ok: true, itemId: "t1" }, "a retry with the same key is the same thread");
    assert.equal((await adapter.list()).length, 3);

    await adapter.execute({ ...start, placeId: "p2" }, "P-2:start");
    assert.deepEqual(launches.at(-1).modelSelection, { instanceId: "claude", model: "opus" }, "the project's default model comes first");
    assert.deepEqual(await adapter.execute({ ...start, title: "Refused" }, "P-3:start"), { ok: false, error: "Provider instance codex is disabled." });

    push({ kind: "project.updated", sequence: 9, project: { id: "p3", title: "empty", defaultModelSelection: null } });
    push({ kind: "project.removed", sequence: 10, projectId: "p2" });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(adapter.places().map((p) => p.name), ["nix", "empty"]);
    const sent = launches.length;
    assert.match((await adapter.execute({ ...start, placeId: "p2" }, "P-4:start") as any).error, /no longer in T3/);
    assert.match((await adapter.execute({ ...start, placeId: "p3" }, "P-5:start") as any).error, /no model/, "a project with no default model and no threads can't start anything");
    assert.equal(launches.length, sent, "neither reached T3");
  } finally {
    await adapter.close();
    t3.close();
  }
});

test("which provider instances T3 lets a project's new threads use, by T3's own rule", () => {
  const settings: T3Settings = {
    providerInstances: {
      codex: { driver: "codex", enabled: false },
      "claude-proxy": { driver: "claudeAgent" },
      "codex-proxy": { driver: "codex", config: { enabled: false } },
      pi: { driver: "pi" },
      "pi-on": { driver: "pi", enabled: true },
    },
    projectSettingsOverrides: { p1: { providerInstances: { codex: { enabled: true }, "claude-proxy": { enabled: false } } } },
  };
  assert.equal(instanceOn(settings, "p2", "codex"), false, "switched off for the machine");
  assert.equal(instanceOn(settings, "p1", "codex"), true, "the project's own switch comes first");
  assert.equal(instanceOn(settings, "p1", "claude-proxy"), false);
  assert.equal(instanceOn(settings, "p2", "claude-proxy"), true, "an instance is on unless something switches it off");
  assert.equal(instanceOn(settings, "p2", "codex-proxy"), false, "its own config can switch it off");
  assert.equal(instanceOn(settings, "p2", "pi"), false, "Pi is off until switched on");
  assert.equal(instanceOn(settings, "p2", "pi-on"), true);
  assert.equal(instanceOn({}, "p2", "claudeAgent"), true, "the built-in instances are on when not configured");
  assert.equal(instanceOn({}, "p2", "codex"), true);
  assert.equal(instanceOn({}, "p2", "gone"), false, "an instance T3 doesn't know isn't");
});

test("20 November: a new thread starts on T3's default model, never on a provider T3 has switched off for the project", () => {
  const opus = { instanceId: "claude-proxy", model: "opus", options: [{ id: "effort", value: "high" }] };
  const project = { id: "p1", title: "No project", defaultModelSelection: { instanceId: "codex-proxy", model: "from-the-project" } };
  const threads = [
    thread("newest", { updatedAt: "2026-11-20T14:34:54Z", modelSelection: { instanceId: "codex", model: "gpt" } }),
    thread("older", { updatedAt: "2026-11-18T18:19:27Z", modelSelection: { instanceId: "codex-proxy", model: "gpt" } }),
    thread("oldest", { updatedAt: "2026-11-01T08:00:00Z", modelSelection: { instanceId: "claude-proxy", model: "fable" } }),
  ];
  const machine: T3Settings = {
    defaultModelSelection: opus, projectSettingsFolded: true,
    providerInstances: { codex: { driver: "codex", enabled: false }, "claude-proxy": { driver: "claudeAgent" }, "codex-proxy": { driver: "codex" } },
    projectSettingsOverrides: {},
  };
  // As it was on Lattice: no project default (its own field no longer counts once folded), the newest thread on `codex`.
  assert.deepEqual(newThreadModel("p1", project, threads, machine), opus, "the machine's default, passed on as T3 gave it");
  assert.deepEqual(newThreadModel("p1", project, threads, null), project.defaultModelSelection, "without T3's settings, the project's own");
  assert.deepEqual(newThreadModel("p1", undefined, threads, null), threads[0].modelSelection, "and failing that, its newest thread's, as before");
  // The project's own default comes first, unless its provider is off for the project.
  const own = { instanceId: "codex-proxy", model: "own" };
  assert.deepEqual(newThreadModel("p1", project, threads, { ...machine, projectSettingsOverrides: { p1: { defaultModelSelection: own } } }), own);
  assert.deepEqual(newThreadModel("p1", project, threads, { ...machine, projectSettingsOverrides: { p1: { defaultModelSelection: { instanceId: "codex", model: "x" } } } }), opus);
  // Before T3 folds a project's own default into its settings, that one still counts.
  assert.deepEqual(newThreadModel("p1", project, threads, { ...machine, projectSettingsFolded: false }), project.defaultModelSelection);
  // No default T3 allows: the newest thread on a provider still on for the project.
  const noOpus: T3Settings = { ...machine, projectSettingsOverrides: { p1: { providerInstances: { "claude-proxy": { enabled: false } } } } };
  assert.deepEqual(newThreadModel("p1", project, threads, noOpus), threads[1].modelSelection);
  assert.deepEqual(newThreadModel("p1", project, threads, { ...machine, defaultModelSelection: null }), threads[1].modelSelection);
  // Nothing allowed: nothing to start with, rather than a launch T3 refuses.
  assert.equal(newThreadModel("p1", project, threads.slice(0, 1), { ...machine, defaultModelSelection: null }), null);
  // A project default T3 has as null ("automatic") is none, not the machine's, nor the project's own field.
  const automatic: T3Settings = { ...machine, projectSettingsOverrides: { p1: { defaultModelSelection: null } } };
  assert.deepEqual(newThreadModel("p1", project, threads, automatic), threads[1].modelSelection);
  assert.deepEqual(newThreadModel("p1", project, threads, { ...automatic, projectSettingsFolded: false }), threads[1].modelSelection);
  // A project default on a model hidden from T3's pickers is passed over for the machine's, unless it's a custom model.
  const hiddenOwn: T3Settings = { ...machine, projectSettingsOverrides: { p1: { defaultModelSelection: own } }, providerModelPreferences: { "codex-proxy": { hiddenModels: ["own"] } } };
  assert.deepEqual(newThreadModel("p1", project, threads, hiddenOwn), opus);
  const custom: T3Settings = { ...hiddenOwn, providerInstances: { ...machine.providerInstances, "codex-proxy": { driver: "codex", config: { customModels: [{ slug: "own" }] } } } };
  assert.deepEqual(newThreadModel("p1", project, threads, custom), own);
  const spaced: T3Settings = { ...hiddenOwn, providerInstances: { ...machine.providerInstances, "codex-proxy": { driver: "codex", config: { customModels: [" own "] } } } };
  assert.deepEqual(newThreadModel("p1", project, threads, spaced), own, "a custom model's name as T3 reads it, trimmed");
});

test("T3Adapter: a launch reads T3's settings and starts on its default model; one T3 would refuse isn't sent", async () => {
  const launches: any[] = [];
  let push: (v: any) => void = () => {};
  let removeOnConfig = false;
  let dropOnConfig = false;
  let settings: T3Settings = {
    defaultModelSelection: { instanceId: "claude-proxy", model: "opus" }, projectSettingsFolded: true,
    providerInstances: { codex: { driver: "codex", enabled: false }, "claude-proxy": { driver: "claudeAgent" } },
  };
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
        push({ kind: "snapshot", snapshot: {
          projects: [{ id: "p1", title: "No project", defaultModelSelection: null }],
          threads: [thread("codex-thread", { modelSelection: { instanceId: "codex", model: "gpt" } })],
        } });
      } else if (f.tag === "server.getConfig") {
        if (dropOnConfig) return ws.terminate();
        if (removeOnConfig) push({ kind: "project.removed", sequence: 5, projectId: "p1" });
        exit(ws, f.id, { settings, providers: [] });
      } else if (f.tag === "orchestration.launchThread") {
        launches.push(f.payload);
        const id = `t${launches.length}`;
        exit(ws, f.id, { threadId: id, projection: {}, resumed: false });
        push({ kind: "thread.updated", location: "active", thread: thread(id, { projectId: "p1", title: f.payload.title, status: "running" }) });
      }
    },
  });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  try {
    await adapter.start();
    const start = { kind: "start_work" as const, placeId: "p1", title: "Dictated", message: "Go.", profile: { ...build, workspace: "root" as const } };
    assert.deepEqual(await adapter.execute(start, "P-1:start"), { ok: true, itemId: "t1" });
    assert.deepEqual(launches[0].modelSelection, { instanceId: "claude-proxy", model: "opus" }, "not the newest thread's codex, which T3 has off");
    // Read at each launch: its default now on a provider switched off, and every thread on one too.
    settings = { ...settings, providerInstances: { ...settings.providerInstances, "claude-proxy": { driver: "claudeAgent", enabled: false } } };
    assert.equal((await adapter.execute(start, "P-2:start") as any).error,
      "T3 has no model to start it with here: no default model, or only one on a provider that's switched off. Choose a default model in T3's settings.");
    assert.equal(launches.length, 1, "nothing T3 would refuse reaches it");
    // T3 drops the project while its settings are read: nothing is sent, and no error of the connector's own is told.
    settings = { ...settings, providerInstances: { ...settings.providerInstances, "claude-proxy": { driver: "claudeAgent" } } };
    removeOnConfig = true;
    assert.deepEqual(await adapter.execute(start, "P-3:start"), { ok: false, error: "That project is no longer in T3." });
    assert.equal(launches.length, 1);
    // Or the connection drops meanwhile: not connected, rather than the project's own model or no model at all.
    removeOnConfig = false;
    push({ kind: "project.updated", sequence: 6, project: { id: "p1", title: "No project", defaultModelSelection: null } });
    await new Promise((r) => setTimeout(r, 20));
    dropOnConfig = true;
    assert.deepEqual(await adapter.execute(start, "P-4:start"), { ok: false, error: "T3 is not connected right now." });
    assert.equal(launches.length, 1);
  } finally {
    await adapter.close();
    t3.close();
  }
});

test("T3Adapter: a machine with no threads yet is loaded, and its first thread shows up", async () => {
  let push: (v: any) => void = () => {};
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag !== "orchestration.subscribeShell") return;
      push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
      push({ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [] } });
    },
  });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  try {
    await adapter.start();
    assert.equal(adapter.isLoaded, true);
    assert.deepEqual(await adapter.list(), []);
    push({ kind: "thread.updated", thread: thread("a") });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual((await adapter.list()).map((i) => i.id), ["a"]);
    assert.equal(await adapter.markRead("a", "2026-10-16T08:00:00Z", "k"), "unsupported", "a server whose shells carry no lastVisitedAt doesn't track visits");

  } finally {
    await adapter.close();
    t3.close();
  }
});

test("T3 connection freshness waits for each connection's snapshot, including an empty reconnect", async () => {
  let push: (v: unknown) => void = () => {};
  let endStream: () => void = () => {};
  let subscriptions = 0;
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag !== "orchestration.subscribeShell") return;
      subscriptions++;
      push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
      endStream = () => exit(ws, f.id, undefined);
    },
  });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  const until = async (check: () => boolean) => {
    for (let n = 0; n < 150 && !check(); n++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(check(), "connection state changed within three seconds");
  };
  try {
    assert.equal(adapter.connected(), false);
    const started = adapter.start();
    await until(() => subscriptions === 1);
    assert.equal(adapter.connected(), false, "an open socket alone is not fresh");
    push({ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [thread("a")] } });
    await started;
    assert.equal(adapter.connected(), true);
    endStream();
    await until(() => !adapter.connected());
    assert.equal(adapter.isLoaded, true, "cached data remains loaded while disconnected");
    await until(() => subscriptions === 2);
    assert.equal(adapter.connected(), false, "reconnect must load a new snapshot");
    push({ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [] } });
    await until(() => adapter.connected());
    assert.deepEqual(await adapter.list(), [], "an empty first snapshot clears the old connection's threads");
  } finally {
    await adapter.close();
    t3.close();
  }
  assert.equal(adapter.connected(), false);
});

test("local project visibility filters threads, places and changes, and guards every read and write", async () => {
  let push: (v: any) => void = () => {};
  const commands: any[] = [];
  const projections: string[] = [];
  const t3 = await fakeT3({ onRequest: (f, ws) => {
    if (f.tag === "orchestration.subscribeShell") {
      push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
      push({ kind: "snapshot", snapshot: {
        projects: [{ id: "p1", title: "Public", workspaceRoot: "/work/public", defaultModelSelection: { model: "m" } }, { id: "p2", title: "Secret", workspaceRoot: "/secret" }],
        threads: [thread("public"), thread("hidden", { projectId: "p2" })],
      } });
    }
    if (f.tag === "orchestration.getThreadProjection") { projections.push(f.payload.threadId); exit(ws, f.id, { messages: [] }); }
    if (f.tag === "orchestration.dispatchCommand" || f.tag === "orchestration.launchThread") { commands.push(f.payload); exit(ws, f.id, {}); }
  } });
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, visible: (root) => root.startsWith("/work/"), auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  try {
    await adapter.start();
    assert.deepEqual((await adapter.list()).map((i) => i.id), ["public"]);
    assert.deepEqual(adapter.places().map((p) => p.id), ["p1"]);
    assert.ok(!JSON.stringify(await adapter.list()).includes("/work"), "roots stay local");
    const changes: string[][] = [];
    adapter.watch((ids) => changes.push(ids));
    push({ kind: "thread.updated", thread: thread("hidden", { projectId: "p2", status: "running" }) });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(changes, []);
    await assert.rejects(adapter.report("hidden"), /outside/);
    await assert.rejects(adapter.replies("hidden"), /outside/);
    await assert.rejects(adapter.firstAsk("hidden"), /outside/);
    assert.equal((await adapter.execute({ kind: "archive", itemId: "hidden" }, "hidden")).ok, false);
    assert.equal((await adapter.markRead("hidden", "2026-10-30T12:00:00Z", "read-hidden") as any).ok, false);
    assert.equal((await adapter.execute({ kind: "start_work", placeId: "p2", title: "Hidden", message: "Go", profile: { name: "Build", workspace: "worktree", runtimeMode: "full-access", interactionMode: "default" } }, "launch-hidden")).ok, false);
    assert.deepEqual(projections, []);
    assert.deepEqual(t3.threadReads, [], "nor is a hidden thread read whole");
    assert.deepEqual(commands, []);
    await adapter.report("public");
    assert.deepEqual(projections, ["public"]);
    push({ kind: "project.updated", project: { id: "p1", title: "Moved", workspaceRoot: "/secret" } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await adapter.list(), []);
    assert.deepEqual(adapter.places(), []);
    await assert.rejects(adapter.report("public"), /outside/);
    assert.equal((await adapter.execute({ kind: "settle", itemId: "public" }, "moved")).ok, false);
    assert.deepEqual(changes, [["public"]], "removing a previously visible item invalidates the brain's view");
  } finally { await adapter.close(); t3.close(); }
});

test("folderOf: the end of a checkout's path, never all of it", () => {
  assert.equal(folderOf("/home/jmo/Development/mono/nix/"), "mono/nix");
  assert.equal(folderOf("/srv"), "srv");
  assert.equal(folderOf("C:\\work\\api"), "work/api");
  assert.equal(folderOf("D:\\work"), "work", "never the drive");
});

test("T3's own folder is $T3CODE_HOME as T3 reads it, else ~/.t3", () => {
  assert.equal(t3Home({}), join(homedir(), ".t3"));
  assert.equal(t3Home({ T3CODE_HOME: "  " }), join(homedir(), ".t3"));
  assert.equal(t3Home({ T3CODE_HOME: "~/t3-work" }), join(homedir(), "t3-work"));
  assert.equal(t3Home({ T3CODE_HOME: "~\\t3-work" }), join(homedir(), "t3-work"), "Windows' ~\\ too");
  assert.equal(t3Home({ T3CODE_HOME: "relative" }), resolve("relative"));
});

test("without T3_URL, T3 is found where it says it is (another port when 3773 is taken), read again at each connect", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "t3-home-"));
  t.after(() => removeDir(home));
  mkdirSync(join(home, "userdata"));
  const runtime = (state: object | string) => writeFileSync(join(home, "userdata", "server-runtime.json"), typeof state === "string" ? state : JSON.stringify(state));
  assert.equal(t3Origin(home), "http://127.0.0.1:3773", "no file: T3's default");
  runtime({ version: 1, pid: process.pid, host: "127.0.0.1", port: 3774, origin: "http://127.0.0.1:3774", startedAt: "2026-11-20T10:00:00.000Z" });
  assert.equal(t3Origin(home), "http://127.0.0.1:3774");
  const ended = spawnSync(process.execPath, ["-e", ""]).pid;
  runtime({ version: 1, pid: ended, port: 3775, origin: "http://127.0.0.1:3775" });
  assert.equal(t3Origin(home), "http://127.0.0.1:3773", "a server that has stopped left it");
  runtime({ version: 1, pid: process.pid, port: 3774, origin: "file:///etc/passwd" });
  assert.equal(t3Origin(home), "http://127.0.0.1:3773");
  runtime("{ not json");
  assert.equal(t3Origin(home), "http://127.0.0.1:3773");

  // T3 restarts on another port: the next connect goes there.
  const subscribed: string[] = [];
  const serve = (name: string) => fakeT3({
    onRequest: (f, ws) => {
      if (f.tag !== "orchestration.subscribeShell") return;
      subscribed.push(name);
      ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [thread(name)] } }] }));
    },
  });
  const first = await serve("first"), second = await serve("second");
  t.after(() => second.close());
  runtime({ version: 1, pid: process.pid, port: Number(new URL(first.base).port), origin: first.base });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ t3Home: home, cli: ["t3"], label: "test", log: () => {}, auth });
  t.after(() => adapter.close());
  await adapter.start();
  assert.deepEqual((await adapter.list()).map((i) => i.id), ["first"]);
  runtime({ version: 1, pid: process.pid, port: Number(new URL(second.base).port), origin: second.base });
  first.close();
  for (let n = 0; n < 250 && subscribed.length < 2; n++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(subscribed, ["first", "second"]);
  for (let n = 0; n < 50 && !adapter.connected(); n++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await adapter.list()).map((i) => i.id), ["second"]);
});

test("T3's CLI mints and revokes the session with plain words only, which even the desktop app's t3.cmd on Windows takes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "t3-cli-"));
  t.after(() => removeDir(dir));
  const calls = join(dir, "calls"), fake = join(dir, "t3.mjs");
  writeFileSync(fake, [
    `import { appendFileSync } from "node:fs";`,
    `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `if (process.argv[4] === "issue") process.stdout.write(JSON.stringify({ token: "tok", sessionId: "6f1c2d3e-0a4b-4c5d-8e9f-0123456789ab", expiresAt: "2026-11-21T10:00:00.000Z" }));`,
  ].join("\n"));
  const cli = nodeCommand(fake);
  const session = await issueSession({ cli, label: "10and2-connector", ttl: "24h", scopes: CONNECTOR_SCOPES });
  assert.deepEqual(session, { token: "tok", sessionId: "6f1c2d3e-0a4b-4c5d-8e9f-0123456789ab", expiresAt: "2026-11-21T10:00:00.000Z" });
  await revokeSession(cli, session.sessionId);
  const said = readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  assert.deepEqual(said, [
    ["auth", "session", "issue", "--json", "--ttl", "24h", "--label", "10and2-connector", "--scope", "orchestration:read", "--scope", "orchestration:operate"],
    ["auth", "session", "revoke", "6f1c2d3e-0a4b-4c5d-8e9f-0123456789ab"],
  ]);

  // The desktop app's t3.cmd (as T3's DesktopCliShim writes it) starts T3 Code.exe on a script inside app.asar, which
  // isn't a file to run with Node: it goes through cmd.exe, which takes only plain words. Every word above is one.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const app = "C:\\Users\\me\\AppData\\Local\\Programs\\T3 Code";
  writeFileSync(join(bin, "t3.cmd"), [
    "@echo off", "rem Written by T3 Code: runs the desktop app's bundled t3 CLI.", "setlocal EnableExtensions DisableDelayedExpansion",
    `set "T3CODE_CLI_PATH=C:\\Users\\me\\.t3\\bin\\t3.cmd"`, `if not defined T3CODE_HOME set "T3CODE_HOME=C:\\Users\\me\\.t3"`,
    `set "ELECTRON_RUN_AS_NODE=1"`, `set "T3CODE_DESKTOP_CLI_LAUNCHER=1"`, `if exist "${app}\\T3 Code.exe" goto run`,
    "echo T3 Code has moved or been removed. Open the app once to update this command. 1>&2", "exit /b 127", ":run",
    `"${app}\\T3 Code.exe" "${app}\\resources\\app.asar\\apps\\server\\dist\\bin.mjs" %*`, `set "t3_exit=%ERRORLEVEL%"`, "exit /b %t3_exit%", "",
  ].join("\r\n"));
  const env = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  for (const args of said) {
    const r = resolveCommand("t3", args, env, "win32");
    assert.deepEqual(r, { file: env.ComSpec, args: ["/d", "/s", "/c", `""${join(bin, "t3.cmd")}" ${args.join(" ")}"`], verbatim: true });
  }
  assert.throws(() => resolveCommand("t3", ["auth", "session", "revoke", "a & b"], env, "win32"), /can't be given these words safely/);
});

/** Providers as `server.getConfig` gives them: the shapes of contracts' `ServerProvider`, models included. */
const model = (slug: string, name: string, over: object = {}) => ({ slug, name, isCustom: false, capabilities: null, ...over });
const providers = (): T3Provider[] => [
  { instanceId: "claudeAgent", driver: "claudeAgent", status: "ready", installed: true, auth: { status: "authenticated" }, supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"], models: [
    model("claude-opus-5-5", "Claude Opus 5.5", { isDefault: true }), model("claude-sonnet-5-5", "Claude Sonnet 5.5"), model("claude-fable-5-2", "Claude Fable 5.2"),
    model("claude-opus-5", "Claude Opus 5", { isLegacy: true }), model("from-the-snapshot", "Stale custom", { isCustom: true }),
  ], updateRequiredModels: [{ slug: "claude-haiku-6" }] },
  // A second Claude instance (a proxy), listing a model of the same name.
  { instanceId: "claude-proxy", driver: "claudeAgent", status: "ready", models: [model("claude-opus-5-5", "Claude Opus 5.5"), model("proxy-only", "Proxy Special")] },
  { instanceId: "codex", driver: "codex", status: "ready", models: [model("astra-6", "Astra 6"), model("astra-5", "Astra 5", { isLegacy: true })] },
  // A large catalog: 8 of it, in the user's order, and its custom models.
  { instanceId: "opencode", driver: "opencode", status: "warning", installed: true, auth: { status: "authenticated" }, models: Array.from({ length: 12 }, (_, n) => model(`m${n}`, `Open ${n}`)) },
  // Off for every project; failing its check; unavailable on this machine.
  { instanceId: "pi", driver: "pi", status: "ready", models: [model("pi-default", "Pi Default")] },
  { instanceId: "cursor", driver: "cursor", status: "error", models: [model("cursor-1", "Cursor One")] },
  { instanceId: "grok", driver: "grok", status: "ready", availability: "unavailable", models: [model("grok-1", "Grok One")] },
  // Only a muse that runs asking first or with full access.
  { instanceId: "muse", driver: "muse", status: "ready", supportedRuntimeModes: ["approval-required", "full-access"], models: [model("muse-1", "Muse One")] },
];
const offerSettings = (): T3Settings => ({
  projectSettingsFolded: true,
  defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
  providerInstances: {
    claudeAgent: { driver: "claudeAgent", config: { customModels: [{ slug: "claude-haiku-6", name: "Too new" }] } },
    "claude-proxy": { driver: "claudeAgent", config: { customModels: ["  my-own  "] } },
    opencode: { driver: "opencode", enabled: true, config: { customModels: [{ slug: "mine", name: "My Model" }, "m3"] } },
    cursor: { driver: "cursor", enabled: true },
    muse: { driver: "muse", enabled: true },
    grok: { driver: "grok", enabled: true },
  },
  projectSettingsOverrides: {
    p1: { providerInstances: { codex: { enabled: false } } },
    p2: { defaultModelSelection: { instanceId: "claude-proxy", model: "claude-opus-5-5" } },
  },
  providerModelPreferences: {
    claudeAgent: { hiddenModels: ["claude-fable-5-2"], modelOrder: ["claude-sonnet-5-5"] },
    "claude-proxy": { hiddenModels: ["my-own"], modelOrder: [] },
    opencode: { hiddenModels: ["m0"], modelOrder: ["m11", "m10"] },
  },
});

test("the models a project offers are T3's picker's: instances on and ready for it, less hidden, legacy and too new ones, each with its provider", () => {
  const config = { settings: offerSettings(), providers: providers() };
  const names = (projectId: string, preferred: unknown = null) => offeredModels(projectId, config, preferred).map((o) => `${o.model.id} ${o.model.name} (${o.model.provider})`);
  assert.deepEqual(names("p1", config.settings.defaultModelSelection), [
    // The default's instance first, in the user's order; Fable hidden, Opus 5 legacy, the snapshot's own custom row
    // not read (T3 reads them from its settings), and a model needing a newer CLI never offered.
    "claudeAgent:claude-sonnet-5-5 Claude Sonnet 5.5 (Claude)", "claudeAgent:claude-opus-5-5 Claude Opus 5.5 (Claude)",
    // Then the drivers' own instances, in T3's order. Codex is off for p1. OpenCode: 8 of its catalog in the user's
    // order (m0 hidden), then its custom ones; m3 is its own already.
    "opencode:m11 Open 11 (OpenCode)", "opencode:m10 Open 10 (OpenCode)", "opencode:m1 Open 1 (OpenCode)", "opencode:m2 Open 2 (OpenCode)",
    "opencode:m3 Open 3 (OpenCode)", "opencode:m4 Open 4 (OpenCode)", "opencode:m5 Open 5 (OpenCode)", "opencode:m6 Open 6 (OpenCode)", "opencode:mine My Model (OpenCode)",
    // Pi is off until switched on, Cursor failed its check, Grok is unavailable here.
    "muse:muse-1 Muse One (Muse Code)",
    // Then the others: the proxy's Opus too, under its own provider; its hidden custom model is still offered, as T3 does.
    "claude-proxy:claude-opus-5-5 Claude Opus 5.5 (Claude Proxy)", "claude-proxy:proxy-only Proxy Special (Claude Proxy)", "claude-proxy:my-own my-own (Claude Proxy)",
  ]);
  // Another project: Codex on, and its default on the proxy, which then comes first; the Opus of each is offered.
  const p2 = names("p2", { instanceId: "claude-proxy", model: "claude-opus-5-5" });
  assert.ok(p2.includes("codex:astra-6 Astra 6 (Codex)") && !p2.some((n) => n.includes("astra-5")));
  assert.deepEqual(p2.filter((n) => n.includes("Claude Opus 5.5")), ["claude-proxy:claude-opus-5-5 Claude Opus 5.5 (Claude Proxy)", "claudeAgent:claude-opus-5-5 Claude Opus 5.5 (Claude)"]);
  // No default: a driver's own instance before a proxy of it.
  assert.deepEqual(names("p3").filter((n) => n.includes("Opus 5.5")), ["claudeAgent:claude-opus-5-5 Claude Opus 5.5 (Claude)", "claude-proxy:claude-opus-5-5 Claude Opus 5.5 (Claude Proxy)"]);
  // Names that differ only in case, spaces or punctuation sound alike: one per instance, the first in T3's order; on
  // two providers, one each.
  const alike: T3Config = { settings: { providerInstances: { opencode: { driver: "opencode", enabled: true } } }, providers: [
    { instanceId: "codex", driver: "codex", status: "ready", models: [model("gpt-5.1-codex", "GPT-5.1-Codex")] },
    { instanceId: "opencode", driver: "opencode", status: "ready", models: [model("openai/gpt-5.1-codex", "gpt 5.1 codex"), model("other/gpt-5.1-codex", "GPT 5.1 Codex")] },
  ] };
  assert.deepEqual(offeredModels("p3", alike, null).map((o) => o.model.id), ["codex:gpt-5.1-codex", "opencode:openai/gpt-5.1-codex"]);
  // Two instances T3 shows under one name are both listed (what's listed never hangs on the order): the first is
  // what a start with no model would use.
  const twins: T3Config = { settings: { providerInstances: { "claude-work": { driver: "claudeAgent" } } }, providers: [
    { instanceId: "claudeAgent", driver: "claudeAgent", displayName: "Work", status: "ready", models: [model("claude-opus-5-5", "Claude Opus 5.5")] },
    { instanceId: "claude-work", driver: "claudeAgent", displayName: "Work", status: "ready", models: [model("claude-opus-5-5", "Claude Opus 5.5")] },
  ] };
  assert.deepEqual(offeredModels("p3", twins, { instanceId: "claude-work" }).map((o) => `${o.model.id} ${o.model.provider}`), ["claude-work:claude-opus-5-5 Work", "claudeAgent:claude-opus-5-5 Work"]);
  assert.deepEqual(offeredModels("p1", { settings: {}, providers: [] }, null), [], "no providers, nothing");
  // A warning with no confirmed sign-in, and one whose sub-provider is fine.
  const warn = (over: Partial<T3Provider>): T3Provider => ({ instanceId: "codex", driver: "codex", status: "warning", models: [model("astra-6", "Astra 6", { subProvider: "main" })], ...over });
  assert.deepEqual(offeredModels("p3", { settings: {}, providers: [warn({})] }, null), []);
  assert.equal(offeredModels("p3", { settings: {}, providers: [warn({ subProviders: [{ name: "main" }] })] }, null).length, 1);
  assert.equal(offeredModels("p3", { settings: {}, providers: [warn({ status: "error", modelsRetained: true })] }, null).length, 1, "an earlier check's models stay");
  // A shape not known here offers nothing, rather than throwing in the shell stream's handler.
  assert.deepEqual(offeredModels("p3", { settings: { providerModelPreferences: { codex: { hiddenModels: "x", modelOrder: 3 } } }, providers: [warn({ status: "ready", models: {} as never, updateRequiredModels: "x" as never }), null as never] }, null), []);
});

test("a provider is named as T3's pickers name it: the name the user gave it, else its id made readable, else its driver's", () => {
  // The name given it, unless that's only the driver's (then it's told apart by its id, as in T3).
  assert.equal(providerLabel({ instanceId: "claude-proxy", driver: "claudeAgent", displayName: "  Work Proxy " }), "Work Proxy");
  assert.equal(providerLabel({ instanceId: "claude-proxy", driver: "claudeAgent", displayName: "Claude" }), "Claude Proxy");
  assert.equal(providerLabel({ instanceId: "claude-proxy", driver: "claudeAgent" }), "Claude Proxy");
  assert.equal(providerLabel({ instanceId: "codexWork", driver: "codex" }), "Codex Work");
  assert.equal(providerLabel({ instanceId: "codex_2", driver: "codex" }), "Codex 2");
  // A driver's own instance: its driver's name.
  assert.equal(providerLabel({ instanceId: "claudeAgent", driver: "claudeAgent" }), "Claude");
  assert.equal(providerLabel({ instanceId: "codex", driver: "codex", displayName: "Codex" }), "Codex");
  assert.equal(providerLabel({ instanceId: "muse", driver: "muse" }), "Muse Code");
  assert.equal(providerLabel({ instanceId: "acpRegistry", driver: "acpRegistry" }), "ACP Registry");
  // A driver T3 has since added, by its id made readable.
  assert.equal(providerLabel({ instanceId: "newAgent", driver: "newAgent" }), "New Agent");
});

/** A fake T3 whose `server.getConfig` gives `config()`, recording launches. */
async function configuredT3(config: () => unknown) {
  const launches: any[] = [];
  let configReads = 0;
  let push: (v: any) => void = () => {};
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: {
          projects: [{ id: "p1", title: "driver", workspaceRoot: "/work/driver" }, { id: "p2", title: "nix", workspaceRoot: "/work/nix" }],
          threads: [thread("a", { modelSelection: { instanceId: "codex", model: "astra-6" } })],
        } }] }));
      } else if (f.tag === "server.getConfig") {
        configReads++;
        const c = config();
        if (c instanceof Error) fail(ws, f.id, c.message); else exit(ws, f.id, c);
      } else if (f.tag === "orchestration.launchThread") {
        launches.push(f.payload);
        exit(ws, f.id, { threadId: `t${launches.length}`, projection: {}, resumed: false });
        push({ kind: "thread.updated", location: "active", thread: thread(`t${launches.length}`, { projectId: f.payload.projectId, title: f.payload.title, status: "running" }) });
      }
    },
  });
  const auth = { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  return { t3, adapter, launches, reads: () => configReads };
}

test("T3Adapter: each project carries the models it offers, read once the shell has loaded; a change in them tells the brain, and nothing else does", async () => {
  let settings = offerSettings();
  const { t3, adapter, reads } = await configuredT3(() => ({ settings, providers: providers() }));
  try {
    await adapter.start();
    const changes: string[][] = [];
    adapter.watch((ids) => changes.push(ids));
    for (let n = 0; n < 50 && !adapter.places()[0]?.models?.length; n++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(changes, [[]], "the first read's models are a change");
    const [p1, p2] = adapter.places();
    assert.deepEqual(p1!.models!.slice(0, 2), [{ id: "claudeAgent:claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "Claude" }, { id: "claudeAgent:claude-opus-5-5", name: "Claude Opus 5.5", provider: "Claude" }]);
    assert.ok(!p1!.models!.some((m) => m.id.startsWith("codex:")) && p2!.models!.some((m) => m.id === "codex:astra-6"), "per project");
    assert.equal(reads(), 1);
    // Read again (here, as a launch reads it): the same models tell nothing; a model hidden since does.
    await (adapter as any).refreshConfig();
    assert.deepEqual(changes, [[]]);
    settings = { ...settings, providerModelPreferences: { ...settings.providerModelPreferences, claudeAgent: { hiddenModels: ["claude-sonnet-5-5"] } } };
    await (adapter as any).refreshConfig();
    assert.deepEqual(changes, [[], []]);
    assert.ok(!adapter.places()[0]!.models!.some((m) => m.name === "Claude Sonnet 5.5"));
  } finally {
    await adapter.close();
    t3.close();
  }
});

test("T3Adapter: with no default in T3's settings, a name's first provider is the one a start with none would use, and a launch on either runs there", async () => {
  const { defaultModelSelection: _, ...settings } = offerSettings();
  const { t3, adapter, launches } = await configuredT3(() => ({ settings, providers: providers() }));
  try {
    await adapter.start();
    for (let n = 0; n < 50 && !adapter.places()[0]?.models?.length; n++) await new Promise((r) => setTimeout(r, 10));
    const opus = () => adapter.places()[0]!.models!.filter((m) => m.name === "Claude Opus 5.5").map((m) => m.id);
    // The newest thread's Codex is off here: no model a start with none would use, so the driver's own instance first.
    assert.deepEqual(opus(), ["claudeAgent:claude-opus-5-5", "claude-proxy:claude-opus-5-5"]);
    // The newest thread now runs on the proxy: the proxy's comes first at once, with no read of T3's config, and the
    // brain is told; a thread used on another instance again moves it back.
    const changes: string[][] = [];
    adapter.watch((ids) => changes.push(ids));
    const newest = { instanceId: "claude-proxy", model: "claude-opus-5-5", options: [{ id: "effort", value: "max" }] };
    (adapter as any).onShell({ kind: "thread.updated", location: "active", thread: thread("newer", { projectId: "p1", updatedAt: "2026-11-21T00:00:00Z", modelSelection: newest }) });
    assert.deepEqual(opus(), ["claude-proxy:claude-opus-5-5", "claudeAgent:claude-opus-5-5"]);
    assert.ok(changes.some((ids) => ids.length === 0), "the models' change told");
    (adapter as any).onShell({ kind: "thread.updated", location: "active", thread: thread("newest", { projectId: "p1", updatedAt: "2026-11-21T01:00:00Z", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } }) });
    assert.deepEqual(opus(), ["claudeAgent:claude-opus-5-5", "claude-proxy:claude-opus-5-5"]);
    (adapter as any).onShell({ kind: "thread.removed", threadId: "newest" });
    assert.deepEqual(opus(), ["claude-proxy:claude-opus-5-5", "claudeAgent:claude-opus-5-5"], "gone: the one before it again");
    // Named as listed, the model a start with none would run on is that one, with its options; the same name on the
    // other provider runs there, as asked (the readback said which).
    const start = { kind: "start_work" as const, placeId: "p1", title: "Gift cards", message: "Add gift cards.", profile: { ...build, workspace: "root" as const } };
    assert.equal((await adapter.execute(start, "plain")).ok, true);
    assert.deepEqual(launches.at(-1).modelSelection, newest);
    assert.equal((await adapter.execute({ ...start, model: "claude-proxy:claude-opus-5-5" }, "named")).ok, true);
    assert.deepEqual(launches.at(-1).modelSelection, newest);
    assert.equal((await adapter.execute({ ...start, model: "claudeAgent:claude-opus-5-5" }, "other-provider")).ok, true);
    assert.deepEqual(launches.at(-1).modelSelection, { instanceId: "claudeAgent", model: "claude-opus-5-5" });
    assert.equal((await adapter.execute({ ...start, model: "claudeAgent:claude-sonnet-5-5" }, "other")).ok, true);
    assert.deepEqual(launches.at(-1).modelSelection, { instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
  } finally {
    await adapter.close();
    t3.close();
  }
});

test("T3Adapter: a launch on a chosen model sends it as T3's picker would, checked against a fresh read; one T3 doesn't offer isn't sent", async () => {
  let settings = offerSettings();
  let broken = false;
  const { t3, adapter, launches } = await configuredT3(() => broken ? new Error("no") : { settings, providers: providers() });
  try {
    await adapter.start();
    const start = { kind: "start_work" as const, placeId: "p1", title: "Gift cards", message: "Add gift cards.", profile: { ...build, workspace: "root" as const } };
    // No model: exactly the launch of before, on T3's default with its options.
    assert.deepEqual(await adapter.execute(start, "k1"), { ok: true, itemId: "t1" });
    assert.deepEqual(launches[0], toLaunch(start, "k1", settings.defaultModelSelection, null));
    // Another model: no options (they're the default's).
    assert.deepEqual(await adapter.execute({ ...start, model: "claudeAgent:claude-sonnet-5-5" }, "k2"), { ok: true, itemId: "t2" });
    assert.deepEqual(launches[1].modelSelection, { instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
    assert.deepEqual({ ...launches[1], modelSelection: null, commandId: null }, { ...toLaunch(start, "k2", null, null), commandId: null }, "the rest as before");
    // The default named: T3's own default, options and all.
    assert.equal((await adapter.execute({ ...start, model: "claudeAgent:claude-opus-5-5" }, "k3")).ok, true);
    assert.deepEqual(launches[2].modelSelection, settings.defaultModelSelection);
    assert.equal((await adapter.execute({ ...start, model: "opencode:mine" }, "k4")).ok, true);
    // The default's name on another provider: listed there too, and run there, without the default's options.
    assert.deepEqual(adapter.places()[0]!.models!.filter((m) => m.name === "Claude Opus 5.5").map((m) => [m.id, m.provider]), [["claudeAgent:claude-opus-5-5", "Claude"], ["claude-proxy:claude-opus-5-5", "Claude Proxy"]]);
    assert.equal((await adapter.execute({ ...start, model: "claude-proxy:claude-opus-5-5" }, "k-proxy")).ok, true);
    assert.deepEqual(launches.at(-1).modelSelection, { instanceId: "claude-proxy", model: "claude-opus-5-5" });
    assert.deepEqual(launches[3].modelSelection, { instanceId: "opencode", model: "mine" }, "a custom model");
    let sent = launches.length;
    // Not offered for this project (Codex is off here), hidden since the brain last read, a legacy one, one T3 doesn't know.
    for (const m of ["codex:astra-6", "claudeAgent:claude-fable-5-2", "claudeAgent:claude-opus-5", "claudeAgent:nope"]) {
      assert.deepEqual(await adapter.execute({ ...start, model: m }, `no-${m}`), { ok: false, error: "T3 Code doesn't offer that model for this project now." }, m);
    }
    settings = { ...settings, providerModelPreferences: { ...settings.providerModelPreferences, claudeAgent: { hiddenModels: ["claude-sonnet-5-5"] } } };
    assert.match((await adapter.execute({ ...start, model: "claudeAgent:claude-sonnet-5-5" }, "hidden-now") as any).error, /doesn't offer that model/, "checked against T3 now, not the last read");
    // A provider that would run it asking first (muse runs only asking first or with full access).
    assert.equal((await adapter.execute({ ...start, model: "muse-1" }, "bare")).ok, false, "a slug alone isn't an id");
    assert.equal((await adapter.execute({ ...start, model: "muse:muse-1" }, "muse-full")).ok, true, "full access it runs with");
    sent = launches.length;
    assert.deepEqual(await adapter.execute({ ...start, model: "muse:muse-1", profile: { ...start.profile, runtimeMode: "auto" } }, "muse"),
      { ok: false, error: "In T3 Code that model would ask for your OK at each step, which 10 & 2 can't give. Choose another model." });
    // T3 doesn't answer: a chosen model can't be checked, so it isn't started; without one, it starts as before.
    broken = true;
    assert.deepEqual(await adapter.execute({ ...start, model: "claudeAgent:claude-opus-5-5" }, "unread"), { ok: false, error: "T3 Code didn't say which models it offers just now. Try again in a moment." });
    assert.equal(launches.length, sent, "none of those reached T3");
    assert.equal((await adapter.execute(start, "plain")).ok, true);
    assert.deepEqual(launches.at(-1).modelSelection, { instanceId: "codex", model: "astra-6" }, "without T3's settings, the newest thread's model, as before");
    // The last good read still stands for the places.
    assert.ok(adapter.places()[0]!.models!.length > 0);
  } finally {
    await adapter.close();
    t3.close();
  }
});
