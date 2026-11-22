import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { answersFor, folderOf, HISTORY_PAGES, instanceOn, mapStatus, newThreadModel, offeredModels, outputVerdict, runItems, providerLabel, snoozedUntil, t3Home, t3Origin, T3Adapter, titleFrom, toCommand, toLaunch, toWorkItem, type ShellThread, type T3Config, type T3Provider, type T3Settings } from "../src/t3/adapter.ts";
import { CONNECTOR_SCOPES, issueSession, revokeSession } from "../src/t3/auth.ts";
import { resolveCommand } from "../src/command.ts";
import { Local } from "../src/local.ts";
import { parsePolicy } from "../src/policy.ts";
import { ANSWERED } from "../src/util.ts";
import { worktreeStart } from "../src/work.ts";
import type { LaunchProfile } from "../src/contract.ts";
import { ConnectionError, RpcClient, RpcError } from "../src/t3/rpc.ts";
import { NODE, nodeCommand, removeDir } from "./fixtures/platform.ts";

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

test("T3 pending background tasks and thread waits keep a thread running", () => {
  assert.equal(mapStatus(thread("a", { status: "completed", pendingBackgroundTasks: [{ taskId: "t1", kind: "subagent", description: "Phase 3 build" }] })), "running");
  assert.equal(mapStatus(thread("a", { status: "completed", pendingBackgroundTasks: [{ taskId: "t2", kind: "command", awaited: true, description: "Running tests", command: "npm test" }] })), "running");
  assert.equal(mapStatus(thread("a", { status: "completed", pendingBackgroundTasks: [{ taskId: "t3", kind: "command", awaited: false, description: "Dev server", command: "npm run dev" }] })), "completed");
  assert.equal(mapStatus(thread("a", { status: "completed", blockedOnThreadWait: true })), "running");
  assert.equal(mapStatus(thread("a", { status: "completed", pendingBackgroundTasks: [{ taskId: "t1", kind: "subagent" }], pendingRuntimeRequest: { id: "r", kind: "user_input" } })), "waiting");
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
 * whole-thread snapshot (`/api/orchestration/threads/<id>`) with a projection, or a status to fail with; `onHttp` answers
 * any other GET it returns something for (a thread's bounded window or a page of its history).
 */
async function fakeT3(handlers: { onRequest: (frame: any, ws: WebSocket) => void; tokens?: Set<string>; threads?: (id: string) => object | number; onHttp?: (url: URL, headers: Record<string, unknown>) => object | null }) {
  const tokens = handlers.tokens ?? new Set(["good"]);
  const frames: any[] = [];
  const sockets: WebSocket[] = [];
  const threadReads: string[] = [];
  const http = createServer((req, res) => {
    const authorized = tokens.has(String(req.headers.authorization).replace("Bearer ", ""));
    const got = req.method === "GET" && handlers.onHttp ? handlers.onHttp(new URL(req.url!, "http://x"), req.headers) : null;
    if (got) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(got));
    }
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
    // T3's bounded history, as T3 answers it: nothing older (a report reads it back for a run its window doesn't hold).
    onHttp: () => ({ snapshotSequence: 1, projection: { turnItems: [] }, hasMoreHistory: false }),
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
    const kid = { text: "Done: it builds.", progress: "Next I'll run the tests.", question: null, choices: null, reply: { runId: "r1", messageId: "m1", at: "2026-10-16T07:30:00Z" }, earlier: ["2026-10-16T07:10:00Z"] };
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
    // This fake T3 serves no turn-item pages, so the reply's run can't be read for its checks: the report says so.
    assert.deepEqual(await adapter.report("ads"), {
      text: "Four drafts are made.", progress: "Landing on main now.", question: null, choices: null, reply: { runId: "r2", messageId: "a2", at: r2.completedAt }, earlier: [r1.completedAt],
      checksUnread: true,
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
    assert.deepEqual(await adapter.report("fresh"), { text: "", progress: "Still reading.", question: null, choices: null, reply: null, earlier: [] });
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

test("a question for the user is input; any other request T3 is waiting on is an approval, which 10 & 2 never gives", () => {
  const kind = (t: ShellThread) => toWorkItem(t, new Map(), 0).questionKind;
  assert.equal(kind(thread("a", { status: "running", pendingRuntimeRequest: { id: "r", kind: "user_input" } })), "input");
  assert.equal(kind(thread("a", { status: "running", pendingRuntimeRequest: { id: "r", kind: "command_execution_approval" } })), "approval");
  assert.equal("questionKind" in toWorkItem(thread("a"), new Map(), 0), false, "asks nothing");
});

/** A T3 with four threads: one asking which way with two options, one waiting for an OK, one running, one done. */
async function asking(t: TestContext, policy: string | null) {
  const commands: any[] = [], launches: any[] = [];
  let push: (v: unknown) => void = () => {};
  const t3 = await fakeT3({ onRequest: (f, ws) => {
    if (f.tag === "orchestration.subscribeShell") {
      push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
      push({ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api", defaultModelSelection: { model: "m" } }], threads: [
        thread("ask", { status: "running", pendingRuntimeRequest: { id: "r1", kind: "user_input" } }),
        thread("ok", { status: "running", pendingRuntimeRequest: { id: "r2", kind: "command_execution_approval" } }),
        thread("busy", { status: "running" }),
        thread("done"),
      ] } });
    } else if (f.tag === "orchestration.getThreadProjection") {
      exit(ws, f.id, { messages: [], turnItems: f.payload.threadId !== "ask" ? [] : [{ type: "user_input_request", requestId: "r1",
        questions: [{ id: "q1", question: "Rebase onto main, or merge?", options: [{ label: "Rebase", value: "rebase" }, { label: "Rebase (later)", value: "later" }, { label: "Merge", value: "merge" }] }] }] });
    } else if (f.tag === "orchestration.dispatchCommand") { commands.push(f.payload); exit(ws, f.id, {}); }
    else if (f.tag === "orchestration.launchThread") { launches.push(f.payload); exit(ws, f.id, { threadId: "t-new" }); }
  } });
  const parsed = policy === null ? undefined : parsePolicy(policy);
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, ...(parsed ? { policy: parsed } : {}),
    auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  t.after(async () => { await adapter.close(); t3.close(); });
  await adapter.start();
  return { adapter, commands, launches, policy: parsed, push };
}

test("T3's question has its own options as choices, and a tap answers that request with the option's own label; a stale one sends nothing", async (t) => {
  const { adapter, commands } = await asking(t, null);
  assert.deepEqual((await adapter.report("ask")).choices, ["Rebase", "Rebase (later)", "Merge"]);
  assert.equal((await adapter.report("ok")).choices, null, "a permission has no options to tap");
  assert.equal((await adapter.report("done")).choices, null);
  assert.deepEqual(Object.fromEntries((await adapter.list()).map((i) => [i.id, i.questionKind])), { ask: "input", ok: "approval", busy: undefined, done: undefined });
  const tap = (questionId: string, message = "Rebase (later)") => ({ kind: "follow_up" as const, itemId: "ask", message, questionId });
  assert.deepEqual(await adapter.execute(tap("r0"), "T-1:ask"), { ok: false, error: ANSWERED }, "T3 holds another request now");
  assert.deepEqual(commands, []);
  assert.deepEqual(await adapter.execute(tap("r1"), "T-2:ask"), { ok: true });
  assert.deepEqual(commands, [{ type: "runtime-request.respond", commandId: "T-2:ask", threadId: "ask", requestId: "r1", answers: { q1: "later" } }]);
});

test("T3 Code keeps to its own narrowing in the policy (agents.t3): answering, steering a running thread, its actions and its ceiling", async (t) => {
  const brain = "ws://127.0.0.1:8790/connector";
  const all = ["follow_up", "settle", "snooze", "archive", "start_work"];
  const profile = { name: "Build", workspace: "root", runtimeMode: "full-access", interactionMode: "default" } as const;
  const follow = (itemId: string) => ({ kind: "follow_up" as const, itemId, message: "Rebase" });

  // The machine allows everything; T3 alone may not answer, steer, archive or start above auto.
  const narrowed = JSON.stringify({ brain, projects: "*", actions: all, maxRuntimeMode: "full-access",
    agents: { t3: { answer: false, steer: false, actions: ["follow_up", "settle", "snooze", "start_work"], maxRuntimeMode: "auto" } } });
  const n = await asking(t, narrowed);
  const local = new Local([{ prefix: "", adapter: n.adapter, retrySafe: true }], n.policy!);
  assert.match((await local.check(follow("ask")))!, /doesn't let 10 & 2 answer them/);
  assert.match((await local.execute(follow("ask"), "P-1:ask") as { error: string }).error, /doesn't let 10 & 2 answer them/);
  assert.match((await local.check(follow("busy")))!, /doesn't let 10 & 2 send to a running thread/);
  assert.equal(await local.check(follow("done")), null, "a thread that isn't running is followed up as before");
  assert.match((await local.check({ kind: "archive", itemId: "done" }))!, /doesn't allow that action/);
  assert.match((await local.check({ kind: "start_work", placeId: "p1", message: "Go", profile }))!, /permission ceiling/);
  assert.equal(await local.check({ kind: "start_work", placeId: "p1", message: "Go", profile: { ...profile, runtimeMode: "auto" } }), null);
  assert.deepEqual(local.refusals(), { ask: { follow_up: n.adapter.refusals().ask!.follow_up }, busy: { follow_up: n.adapter.refusals().busy!.follow_up } }, "said before a proposal is read back");
  assert.deepEqual([n.commands, n.launches], [[], []], "nothing reached T3");
  assert.match((await local.execute(follow("ok"), "P-2:ok") as { error: string }).error, /answer it in T3 Code/, "a permission is refused when it's sent, as before");

  // T3 may not start work at all: it offers no places.
  const noStart = await asking(t, JSON.stringify({ brain, projects: "*", actions: all, maxRuntimeMode: "full-access", agents: { t3: { actions: ["follow_up"] } } }));
  assert.deepEqual(noStart.adapter.places(), []);

  // Narrowed for another agent only, T3 answers, steers and starts as before.
  const other = await asking(t, JSON.stringify({ brain, projects: "*", actions: all, maxRuntimeMode: "full-access", agents: { t3: true, claude: { answer: false, steer: false } } }));
  assert.equal(await other.adapter.check(follow("ask")), null);
  assert.equal(await other.adapter.check(follow("busy")), null);
  assert.deepEqual(other.adapter.refusals(), {});
  assert.deepEqual(other.adapter.places().map((p) => p.id), ["p1"]);
  assert.deepEqual(await other.adapter.execute(follow("ask"), "P-3:ask"), { ok: true });
  assert.deepEqual(other.commands.map((c) => [c.type, c.answers]), [["runtime-request.respond", { q1: "rebase" }]]);
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
  const ended = spawnSync(NODE, ["-e", ""]).pid;
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

// main.ts passes T3's address only when T3_URL is set; without it, a run's pages are read where T3 says it is (t3Origin),
// as every other call to T3 is.
test("receipts: without T3_URL, a long run's history pages are read where T3 says it is", async (t) => {
  const at = "2026-11-16T09:00:00Z";
  const item = (ordinal: number, runId: string, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId, ordinal, status: "completed", updatedAt: at, ...over });
  const all = [
    item(1, "r1", { type: "assistant_message", text: "Earlier.", streaming: false }),
    item(2, "r2", { type: "command_execution", input: "pnpm test", status: "failed", exitCode: 1 }),
    ...Array.from({ length: 100 }, (_, n) => item(3 + n, "r2", { type: "reasoning", text: "thinking" })),
    item(103, "r2", { type: "assistant_message", text: "All done!", streaming: false }),
  ];
  const newest = (n: number, before = all.length) => all.slice(Math.max(0, before - n), before);
  const projection = {
    runs: [{ id: "r1", status: "completed", completedAt: "2026-11-16T08:00:00Z" }, { id: "r2", status: "completed", completedAt: at }],
    messages: [{ id: "i1", role: "assistant", runId: "r1", text: "Earlier.", streaming: false }, { id: "i103", role: "assistant", runId: "r2", text: "All done!", streaming: false }],
    turnItems: newest(77),
  };
  const asked: string[] = [];
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1")] } }] }));
      if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection);
    },
    onHttp: (url) => {
      asked.push(url.pathname.endsWith("/bounded") ? "bounded" : `history ${url.searchParams.get("cursor")}`);
      if (url.pathname === "/api/orchestration/threads/t1/bounded") return { snapshotSequence: 9, projection: { ...projection, turnItems: newest(75) }, historyCursor: "75", hasMoreHistory: true };
      if (url.pathname !== "/api/orchestration/threads/t1/history") return null;
      const skip = Number(url.searchParams.get("cursor"));
      return { snapshotSequence: 9, items: newest(75, all.length - skip).map((i, position) => ({ position, visibility: "local", sourceThreadId: "t1", sourceItemId: i.id, item: i })), nextCursor: String(skip + 75), hasMoreHistory: all.length - skip - 75 > 0 };
    },
  });
  t.after(() => t3.close());
  const home = mkdtempSync(join(tmpdir(), "t3-home-"));
  t.after(() => removeDir(home));
  mkdirSync(join(home, "userdata"));
  writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ version: 1, pid: process.pid, port: Number(new URL(t3.base).port), origin: t3.base }));
  const adapter = new T3Adapter({ t3Home: home, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  t.after(() => adapter.close());
  await adapter.start();
  const report = await adapter.report("t1");
  assert.deepEqual(asked, ["bounded", "history 75"]);
  assert.deepEqual(report.checks, { tests: { ok: false, runs: 1, failed: 1, label: "pnpm test" } });
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

test("what a person typed (the engine's stage 3.9): a thread is read only as T3's last user write moves, one recent at first sight; its own resumes and 10 & 2's sends aren't a person's, the phone's isn't at a computer", async () => {
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
  let push: (v: any) => void = () => {};
  const reads: string[] = [];
  const resumed = at(20);
  const messages: Record<string, any[]> = {
    a: [
      { id: "m1", role: "user", text: "Run the migration.", createdBy: "user", creationSource: "web", createdAt: at(30) },
      // T3's usage-limit resume, written as the user's: latestUserAuthoredMessageAt moves to it.
      { id: "limit-resume:x:legacy", role: "user", text: "Continue where you left off.", createdBy: "user", creationSource: "server", createdAt: resumed },
    ],
    old: [{ id: "m0", role: "user", text: "Long ago.", createdBy: "user", creationSource: "web", createdAt: at(80 * 60) }],
  };
  const t3 = await fakeT3({ onRequest: (f, ws) => {
    if (f.tag === "orchestration.subscribeShell") {
      push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
      push({ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "nix" }], threads: [
        thread("a", { latestUserAuthoredMessageAt: resumed }),
        thread("old", { latestUserAuthoredMessageAt: at(80 * 60) }),
        thread("none"),
      ] } });
    } else if (f.tag === "orchestration.getThreadProjection") {
      reads.push(f.payload.threadId);
      exit(ws, f.id, { messages: messages[f.payload.threadId] ?? [] });
    }
  } });
  const auth = { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} };
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth });
  const until = async (test: () => boolean) => { for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(test()); };
  try {
    const changed: string[][] = [];
    adapter.watch((ids) => changed.push(ids));
    await adapter.start();
    await until(() => adapter.personWrites("a").length === 1);
    assert.deepEqual(adapter.personWrites("a").map((w) => [w.at, w.desk]), [[messages.a![0].createdAt, true]], "the resume isn't a person's");
    assert.deepEqual(adapter.personWrites("old"), [], "a write from before Away could have begun isn't read");
    assert.deepEqual(reads, ["a"]);
    assert.ok(changed.some((ids) => ids.includes("a")), "reported again once read");
    // The same write again (another change to the thread): not read again.
    push({ kind: "thread.updated", thread: thread("a", { latestUserAuthoredMessageAt: resumed, status: "running" }) });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(reads, ["a"]);
    // 10 & 2's follow-up, then the user from T3's phone app.
    messages.a!.push({ id: "driver:op-1", role: "user", text: "Carry on.", createdBy: "user", creationSource: "mobile", createdAt: at(5) });
    messages.a!.push({ id: "m2", role: "user", text: "From the phone.", createdBy: "user", creationSource: "mobile", createdAt: at(1) });
    push({ kind: "thread.updated", thread: thread("a", { latestUserAuthoredMessageAt: at(1) }) });
    await until(() => adapter.personWrites("a").length === 2);
    assert.deepEqual(adapter.personWrites("a").map((w) => w.desk), [true, false], "the phone's isn't at a computer; 10 & 2's isn't a person's");
    const local = new Local([{ prefix: "", adapter }], parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] })));
    assert.deepEqual((await local.list()).find((i) => i.id === "a")!.typed, { at: messages.a![3].createdAt, desk: messages.a![0].createdAt });
    assert.deepEqual((await local.list()).find((i) => i.id === "none")!.typed, { at: null, desk: null });
  } finally { await adapter.close(); t3.close(); }
});

// Receipts (docs/launch/spikes/run-receipts.md): the reply's run's checks, from its projection's turn items as T3's server
// sends them (WireProjection.ts): no command output, only `outputIndicatesFailure` (a non-zero exit code, or output
// saying "Exit code 1") and an exit code for some agents. A check piped on has its output read with getTurnItem.
test("receipts: a report carries its run's checks, from command_execution exits and file_change items, and nothing of the commands", async () => {
  const item = (ordinal: number, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId: "r2", ordinal, status: "completed", updatedAt: "2026-11-16T09:00:00Z", ...over });
  const cmd = (ordinal: number, input: string, status: string, over: object = {}) => item(ordinal, { type: "command_execution", input, status, outputOmitted: true, ...over });
  const projection = {
    runs: [{ id: "r1", status: "completed", completedAt: "2026-11-16T08:00:00Z" }, { id: "r2", status: "completed", completedAt: "2026-11-16T09:00:00Z" }],
    messages: [{ id: "m1", role: "assistant", runId: "r1", text: "Earlier.", streaming: false }, { id: "m2", role: "assistant", runId: "r2", text: "All done!", streaming: false }],
    turnItems: [
      // Another run's failing test isn't this reply's.
      { ...cmd(1, "pnpm test", "failed", { exitCode: 1 }), runId: "r1" },
      // A filtered run isn't a whole run: its pass isn't counted (checks.ts `FULL`).
      cmd(2, "cd SECRET_DIR && pnpm test --filter SECRET_PKG", "completed", { exitCode: 0 }),
      item(3, { type: "file_change", fileName: "SECRET_FILE.ts" }),
      // Claude's, through T3: no exit code; failed with a non-zero exit, or refused by a hook.
      cmd(4, "pnpm test", "failed", { outputIndicatesFailure: true }),
      cmd(5, "pnpm test", "failed"),
      // Piped on: its exit is tail's, so its output's summary, read with getTurnItem, says how the tests went.
      cmd(6, "pnpm test 2>&1 | tail -20", "completed"),
      cmd(7, "npm run build", "failed", { outputIndicatesFailure: true }),
      cmd(8, "pnpm lint", "completed"),
    ],
  };
  const fetched: string[] = [];
  const t3 = await fakeT3({ onRequest: (f, ws) => {
    if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1")] } }] }));
    if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection);
    if (f.tag === "orchestration.getTurnItem") {
      fetched.push(f.payload.itemId);
      exit(ws, f.id, { item: { ...projection.turnItems.find((i: any) => i.id === f.payload.itemId), outputOmitted: undefined, output: "SECRET_OUTPUT\nℹ tests 12\nℹ pass 11\nℹ fail 1\n" } });
    }
  } });
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  try {
    await adapter.start();
    const report = await adapter.report("t1");
    assert.equal(report.text, "All done!");
    const edited = { edited: true as const };
    assert.deepEqual(report.checks, { tests: { ok: false, runs: 2, failed: 2, label: "pnpm test", ...edited }, build: { ok: false, runs: 1, failed: 1, label: "npm build", ...edited }, lint: { ok: true, runs: 1, failed: 0, label: "pnpm lint", ...edited } });
    assert.deepEqual(fetched, ["i6", "i8"], "only the piped check's output is read, and the lint's, whose clean exit only its status tells");
    assert.doesNotMatch(JSON.stringify(report), /SECRET_|--filter|Exit code|tail/);
    await adapter.report("t1");
    assert.deepEqual(fetched, ["i6", "i8"], "and only once: its verdict is kept, not its output");
  } finally { await adapter.close(); t3.close(); }
});

// The skeptic (16 November): T3 sends a thread's newest 77 turn items only (THREAD_HISTORY_SNAPSHOT_ROW_LIMIT), so a long
// run's failing test can be older than the projection. Its older items come from T3's HTTP history, a page at a time,
// back to the run's start; a finished run's receipts are then kept.
test("receipts: a long run's failing test older than T3's 77-item window is read back from its history pages, and kept", async () => {
  const at = "2026-11-16T09:00:00Z";
  const item = (ordinal: number, runId: string, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId, ordinal, status: "completed", updatedAt: at, ...over });
  // r1: an earlier run. r2: a failing test, a passing build, then 200 items of other work and its reply. No test after.
  const all = [
    item(1, "r1", { type: "assistant_message", text: "Earlier.", streaming: false }),
    item(2, "r2", { type: "user_message", text: "Refactor it" }),
    item(3, "r2", { type: "command_execution", input: "pnpm test", status: "failed", exitCode: 1 }),
    item(4, "r2", { type: "command_execution", input: "pnpm build", status: "completed", exitCode: 0 }),
    ...Array.from({ length: 200 }, (_, n) => item(5 + n, "r2", { type: "reasoning", text: "thinking" })),
    item(205, "r2", { type: "assistant_message", text: "All done!", streaming: false }),
  ];
  const newest = (n: number, before = all.length) => all.slice(Math.max(0, before - n), before);
  const projection = {
    runs: [{ id: "r1", status: "completed", completedAt: "2026-11-16T08:00:00Z" }, { id: "r2", status: "completed", completedAt: at }],
    messages: [{ id: "i1", role: "assistant", runId: "r1", text: "Earlier.", streaming: false }, { id: "i205", role: "assistant", runId: "r2", text: "All done!", streaming: false }],
    turnItems: newest(77),
  };
  const asked: string[] = [];
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1")] } }] }));
      if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection);
    },
    // T3's bounded window (75, with a cursor to what's older) and its history pages, 75 at a time, oldest last.
    onHttp: (url, headers) => {
      if (headers.authorization !== "Bearer good" || headers["x-t3-orchestration-protocol"] !== "2") return null;
      asked.push(url.pathname.endsWith("/bounded") ? "bounded" : `history ${url.searchParams.get("cursor")}`);
      if (url.pathname === "/api/orchestration/threads/t1/bounded") return { snapshotSequence: 9, projection: { ...projection, turnItems: newest(75) }, historyCursor: "75", hasMoreHistory: true };
      if (url.pathname !== "/api/orchestration/threads/t1/history") return null;
      const skip = Number(url.searchParams.get("cursor"));
      const items = newest(75, all.length - skip);
      return { snapshotSequence: 9, items: items.map((i, position) => ({ position, visibility: "local", sourceThreadId: "t1", sourceItemId: i.id, item: i })), nextCursor: String(skip + 75), hasMoreHistory: all.length - skip - 75 > 0 };
    },
  });
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  try {
    await adapter.start();
    const report = await adapter.report("t1");
    assert.equal(report.text, "All done!");
    assert.deepEqual(report.checks, { tests: { ok: false, runs: 1, failed: 1, label: "pnpm test" }, build: { ok: true, runs: 1, failed: 0, label: "pnpm build" } });
    // The window, then pages back until an older item that isn't r2's (r1's) shows where r2 began; no further.
    assert.deepEqual(asked, ["bounded", "history 75", "history 150"]);
    await adapter.report("t1");
    assert.deepEqual(asked, ["bounded", "history 75", "history 150"], "a finished run's receipts are kept, not read back again");
    assert.doesNotMatch(JSON.stringify(report), /Refactor it|thinking/);
  } finally { await adapter.close(); t3.close(); }
});

// "Call me when the tests pass" mid-run (the skeptic, 16 November): a report on a thread still running carries that run's
// checks so far, from its newest items (no reading back: a check that just exited is among them).
test("receipts: a running run's checks so far come with the report as running, beside the finished reply's", async () => {
  const item = (ordinal: number, runId: string, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId, ordinal, status: "completed", updatedAt: "2026-11-16T09:00:00Z", ...over });
  const projection = {
    runs: [{ id: "r1", status: "completed", completedAt: "2026-11-16T08:00:00Z" }, { id: "r2", status: "running" }],
    messages: [{ id: "i2", role: "assistant", runId: "r1", text: "Tests fail; fixing.", streaming: false }, { id: "i6", role: "assistant", runId: "r2", text: "Fixing the flaky test.", streaming: false }],
    turnItems: [
      item(1, "r1", { type: "command_execution", input: "pnpm test", status: "failed", exitCode: 1 }),
      item(2, "r1", { type: "assistant_message", text: "Tests fail; fixing.", streaming: false }),
      item(3, "r2", { type: "file_change" }),
      item(4, "r2", { type: "command_execution", input: "pnpm test", status: "failed", exitCode: 1 }),
      item(5, "r2", { type: "command_execution", input: "pnpm test", status: "completed", exitCode: 0 }),
      item(6, "r2", { type: "assistant_message", text: "Fixing the flaky test.", streaming: false }),
      item(7, "r2", { type: "command_execution", input: "pnpm lint", status: "running" }),
    ],
  };
  const t3 = await fakeT3({ onRequest: (f, ws) => {
    if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1", { status: "running" })] } }] }));
    if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection);
  } });
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  try {
    await adapter.start();
    const report = await adapter.report("t1");
    assert.equal(report.text, "Tests fail; fixing.");
    assert.deepEqual(report.checks, { tests: { ok: false, runs: 1, failed: 1, label: "pnpm test" } });
    assert.deepEqual(report.running, { tests: { ok: true, runs: 2, failed: 1, label: "pnpm test", edited: true } }, "the lint still running isn't counted");
  } finally { await adapter.close(); t3.close(); }
});

// The skeptic on 5828b30370cf: a check whose clean exit only its status tells, with output saying no test ran (go's
// `[no tests to run]` everywhere, as printed on this machine), isn't a pass; with its tests run, it is.
test("receipts: a status-only check whose output says no test ran is unknown, not a pass", () => {
  const i = { input: "go test -run TestNothing ./...", status: "completed" };
  assert.equal(outputVerdict(i, {}, "ok  \texample.com/x\t0.001s [no tests to run]\nok  \texample.com/x/pkg/b\t0.001s [no tests to run]\n"), null);
  assert.equal(outputVerdict({ ...i, input: "go test ./..." }, {}, "ok  \texample.com/x\t(cached)\n"), true);
});

// The skeptic, 16 November: Claude's commands through T3 have no exit code, and one it ran in the background is
// `completed` the moment it launches, so a test run left running counted as a pass at launch.
test("receipts: a check whose clean exit only its status tells counts once its output shows it wasn't left in the background", async () => {
  const item = (ordinal: number, runId: string, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId, ordinal, status: "completed", updatedAt: "2026-11-16T09:00:00Z", ...over });
  const cmd = (ordinal: number, runId: string, input: string, status: string, over: object = {}) => item(ordinal, runId, { type: "command_execution", input, status, outputOmitted: true, ...over });
  const outputs: Record<string, string> = {
    i3: "Command running in background with ID: SECRET_ID. Output is being written to: /SECRET_PATH",
    i6: "Command did not complete within its 120s timeout and was moved to the background (ID: SECRET_ID). Output is being written to: /SECRET_PATH",
    i7: "Command running in background with ID: SECRET_ID. Output is being written to: /SECRET_PATH",
    i8: "SECRET_OUTPUT\nℹ tests 12\nℹ pass 12\nℹ fail 0\n",
    i9: "SECRET_OUTPUT\nℹ tests 12\nℹ pass 11\nℹ fail 1\n",
  };
  const projection = {
    runs: [{ id: "r1", status: "completed", completedAt: "2026-11-16T08:00:00Z" }, { id: "r2", status: "running" }],
    messages: [{ id: "m1", role: "assistant", runId: "r1", text: "All done!", streaming: false }],
    turnItems: [
      // The reply's run: its test run failed, it changed a file, then left the test run going in the background.
      cmd(1, "r1", "pnpm test", "failed", { outputIndicatesFailure: true }),
      item(2, "r1", { type: "file_change" }),
      cmd(3, "r1", "cd app && pnpm test", "completed"),
      item(4, "r1", { type: "assistant_message", text: "All done!", streaming: false }),
      // The run going: a change, then a test run moved to the background at its timeout, and one chained on.
      item(5, "r2", { type: "file_change" }),
      cmd(6, "r2", "pnpm test", "completed"),
      cmd(7, "r2", "pnpm test && git commit -m x", "completed"),
    ] as any[],
  };
  const fetched: string[] = [];
  const t3 = await fakeT3({ onRequest: (f, ws) => {
    if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1", { status: "running" })] } }] }));
    if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection);
    if (f.tag === "orchestration.getTurnItem") {
      fetched.push(f.payload.itemId);
      exit(ws, f.id, { item: { ...projection.turnItems.find((i: any) => i.id === f.payload.itemId), outputOmitted: undefined, output: outputs[f.payload.itemId] } });
    }
  } });
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  try {
    await adapter.start();
    const report = await adapter.report("t1");
    // Not "tests pass" at the launch: the failure before it stands, with the change after it.
    assert.deepEqual(report.checks, { tests: { ok: false, runs: 1, failed: 1, label: "pnpm test", stale: true } });
    assert.equal(report.running, undefined, "a test run left in the background isn't a pass for a green watch");
    // The test run finishes in the foreground and passes: that counts, once its output has been read.
    projection.turnItems.push(cmd(8, "r2", "pnpm test", "completed"));
    const next = await adapter.report("t1");
    assert.deepEqual(next.running, { tests: { ok: true, runs: 1, failed: 0, label: "pnpm test", edited: true } });
    // One whose status says it exited clean but whose output says a test failed (a script ending `|| true`): a failure.
    projection.turnItems.push(cmd(9, "r2", "pnpm test", "completed"));
    const third = await adapter.report("t1");
    assert.deepEqual(third.running, { tests: { ok: false, runs: 2, failed: 1, label: "pnpm test", edited: true } });
    assert.deepEqual(fetched.sort(), ["i3", "i6", "i7", "i8", "i9"], "each read once");
    assert.doesNotMatch(JSON.stringify([report, next, third]), /SECRET_|background/);
  } finally { await adapter.close(); t3.close(); }
});

test("receipts: reading a run back stops at its start, at T3's first item, at the page limit, or at a page that can't be read", async () => {
  const it = (ordinal: number, runId: string) => ({ id: `i${ordinal}`, runId, ordinal });
  const pages = (all: any[]) => {
    const asked: (string | null)[] = [];
    const page = async (cursor: string | null) => {
      asked.push(cursor);
      const skip = cursor === null ? 0 : Number(cursor);
      const items = all.slice(Math.max(0, all.length - skip - 3), all.length - skip);
      return { items, cursor: all.length - skip - 3 > 0 ? String(skip + 3) : null };
    };
    return { asked, page };
  };
  // The window starts before the run: nothing read.
  const before = pages([]);
  assert.deepEqual(await runItems([it(1, "r1"), it(2, "r2")], "r2", before.page), { items: [it(1, "r1"), it(2, "r2")], whole: true });
  assert.deepEqual(before.asked, []);
  // The run is the thread's first: read to T3's first item, whole.
  const first = Array.from({ length: 7 }, (_, n) => it(n + 1, "r1"));
  const f = pages(first);
  assert.equal((await runItems(first.slice(-2), "r1", f.page)).whole, true);
  assert.deepEqual(f.asked, [null, "3", "6"]);
  // Longer than the pages read: as read, neither whole nor failed (kept, not read again).
  const long = Array.from({ length: 3 * (HISTORY_PAGES + 3) }, (_, n) => it(n + 1, "r1"));
  const l = pages(long);
  const got = await runItems(long.slice(-2), "r1", l.page);
  assert.deepEqual([got.whole, got.failed, l.asked.length], [false, undefined, HISTORY_PAGES + 1]);
  // A page T3 couldn't give: failed, so it's tried again next time.
  assert.deepEqual(await runItems([it(5, "r1")], "r1", async () => null), { items: [it(5, "r1")], whole: false, failed: true });
});

// Sol on 45ec9eccdf6f (F2): a run still going was read from the projection's newest 77 items alone, so a failure read at
// one report was forgotten once it left that window, and a passing tail rang "tests pass" mid-run; a finished run whose
// history T3 refused, or longer than the pages read, passed on its tail. A run is read from its start (its items kept
// once read, and read back from T3's history where the window doesn't reach them); read only in part, its failures
// stand and nothing passes.
test("receipts: a failure that leaves T3's window still stands; a run read only in part (history refused, or past the page limit) never passes", async (t) => {
  const item = (ordinal: number, runId: string, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId, ordinal, status: "completed", updatedAt: "2026-11-20T09:00:00Z", ...over });
  const cmd = (ordinal: number, input: string, exitCode: number) => item(ordinal, "r2", { type: "command_execution", input, exitCode, status: exitCode ? "failed" : "completed" });
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, k) => item(from + k, "r2", { type: "reasoning", text: "thinking" }));
  /** A T3 holding `all` (newest last): its projection the newest 77, its bounded window 75, its history 75 a page; `refuse`, no history. */
  async function standIn(all: () => any[], run: { status: string; completedAt?: string }, refuse: () => boolean) {
    const asked: string[] = [];
    const projection = () => ({ runs: [{ id: "r1", status: "completed", completedAt: "2026-11-20T08:00:00Z" }, { id: "r2", startedAt: "2026-11-20T08:30:00Z", ...run }],
      messages: run.status === "completed" ? [{ id: "reply", role: "assistant", runId: "r2", text: "All done!", streaming: false }] : [], turnItems: all().slice(-77) });
    const t3 = await fakeT3({
      onRequest: (f, ws) => {
        if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1", { status: "running" })] } }] }));
        if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection());
        // A failing run's output, as its runner prints it (after `cd api &&`, what makes the failure its own).
        if (f.tag === "orchestration.getTurnItem") exit(ws, f.id, { item: { ...all().find((i) => i.id === f.payload.itemId), output: "ℹ tests 1\nℹ fail 1\n" } });
      },
      onHttp: (url) => {
        if (refuse()) return null;
        const items = all(), newest = (n: number, before: number) => items.slice(Math.max(0, before - n), before);
        asked.push(url.pathname.endsWith("/bounded") ? "bounded" : `history ${url.searchParams.get("cursor")}`);
        if (url.pathname.endsWith("/bounded")) return { snapshotSequence: 9, projection: { ...projection(), turnItems: newest(75, items.length) }, historyCursor: "75", hasMoreHistory: items.length > 75 };
        const skip = Number(url.searchParams.get("cursor"));
        return { snapshotSequence: 9, items: newest(75, items.length - skip).map((i, position) => ({ position, item: i })), nextCursor: String(skip + 75), hasMoreHistory: items.length - skip - 75 > 0 };
      },
    });
    const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
    t.after(async () => { await adapter.close(); t3.close(); });
    await adapter.start();
    return { adapter, asked, run };
  }
  const failing = { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } };

  await t.test("history refused: the failure read before stays as long as it's read, and nothing passes", async () => {
    let all: any[] = [item(1, "r1", { type: "assistant_message", text: "Earlier.", streaming: false }), cmd(2, "cd api && npm test", 1)];
    const s = await standIn(() => all, { status: "running" }, () => true);
    assert.deepEqual((await s.adapter.report("t1")).running, failing, "the failure, in the window");
    // 75 items later, an edit and the root's whole run passing: the failure is out of the window.
    all = [...all, ...filler(3, 75), item(78, "r2", { type: "file_change" }), cmd(79, "npm test", 0)];
    assert.equal((await s.adapter.report("t1")).running, undefined, "was { ok: true, edited: true }: api's failure may stand");
    Object.assign(s.run, { status: "completed", completedAt: "2026-11-20T09:00:00Z" });
    const done = await s.adapter.report("t1");
    assert.deepEqual([done.checks, done.checksUnread], [undefined, true], "was { ok: true }: its checks weren't read, never a pass");
  });

  await t.test("history read: the run is read from its start once, then on from what was read; a failure out of the window stands until its own folder passes", async () => {
    let all: any[] = [item(1, "r1", { type: "assistant_message", text: "Earlier.", streaming: false }), cmd(2, "cd api && npm test", 1), ...filler(3, 80)];
    const s = await standIn(() => all, { status: "running" }, () => false);
    assert.deepEqual((await s.adapter.report("t1")).running, failing, "read back to the run's start");
    const paged = s.asked.length;
    assert.ok(paged > 0);
    all = [...all, item(83, "r2", { type: "file_change" }), cmd(84, "npm test", 0)];
    assert.deepEqual((await s.adapter.report("t1")).running, { ...failing, tests: { ...failing.tests, stale: true } }, "was { ok: true, edited: true }: the root's pass leaves api's failure standing");
    assert.equal(s.asked.length, paged, "read on from what was read: no history read again");
    all = [...all, cmd(85, "cd api && npm test", 0)];
    const passed = await s.adapter.report("t1");
    assert.deepEqual(passed.running, { tests: { ok: true, runs: 2, failed: 1, label: "npm test", edited: true } });
    assert.equal(passed.runningId, "r2", "its run, as its reply will carry it (F6)");
    // More than the window's worth since the last read: read back until it meets what was read.
    all = [...all, ...filler(86, 100), item(186, "r2", { type: "file_change" }), cmd(187, "cd api && npm test", 1), ...filler(188, 100), cmd(288, "npm test", 0)];
    assert.deepEqual((await s.adapter.report("t1")).running, { tests: { ok: false, runs: 3, failed: 2, label: "npm test", edited: true } }, "the failure between two reads");
    assert.ok(s.asked.length > paged, "read back over T3's history to what was read");
  });

  await t.test("past the page limit: a passing tail is never a pass, and isn't read again", async () => {
    const all = [cmd(1, "cd api && npm test", 1), ...filler(2, 75 * (HISTORY_PAGES + 2)), item(100_000, "r2", { type: "file_change" }), cmd(100_001, "npm test", 0)];
    const s = await standIn(() => all, { status: "completed", completedAt: "2026-11-20T09:00:00Z" }, () => false);
    const done = await s.adapter.report("t1");
    assert.deepEqual([done.checks, done.checksUnread], [undefined, true], "was { ok: true, edited: true }");
    const pages = s.asked.length;
    await s.adapter.report("t1");
    assert.equal(s.asked.length, pages, "kept: a run that long won't be read whole later");
  });
});

// Sol on 45ec9eccdf6f (F4): a check after `cd … &&` that failed may never have run (the cd failed). T3 gives its exit
// code, never its output, so the output is read once: the runner's own failure is a failure, the cd's is unknown.
test("receipts: a check that failed after a cd is a failure only when its output is the runner's", async () => {
  const item = (ordinal: number, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId: "r1", ordinal, status: "failed", exitCode: 1, type: "command_execution", updatedAt: "2026-11-20T09:00:00Z", ...over });
  const outputs: Record<string, string> = {
    i1: "bash: line 1: cd: no-such: No such file or directory\n", i2: "ℹ tests 1\nℹ pass 0\nℹ fail 1\n",
    i3: "\n> web@1.0.0 build\n> vite build\n\nvite v5.4.11 building for production...\nx Build failed in 120ms\nerror during build:\n[vite]: Rollup failed to resolve import \"./x\".\n",
  };
  const projection = {
    runs: [{ id: "r1", status: "completed", completedAt: "2026-11-20T09:00:00Z" }],
    messages: [{ id: "m1", role: "assistant", runId: "r1", text: "Done.", streaming: false }],
    turnItems: [item(0, { type: "user_message", status: "completed", exitCode: undefined, runId: "r0" }), item(1, { input: "cd no-such && npm test" })] as any[],
  };
  const t3 = await fakeT3({ onRequest: (f, ws) => {
    if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1")] } }] }));
    if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection);
    if (f.tag === "orchestration.getTurnItem") exit(ws, f.id, { item: { ...projection.turnItems.find((i) => i.id === f.payload.itemId), output: outputs[f.payload.itemId] } });
  } });
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  try {
    await adapter.start();
    const cdFailed = await adapter.report("t1");
    assert.deepEqual([cdFailed.checks, cdFailed.checksUnread], [undefined, undefined], "was { ok: false }: the cd failed, npm never ran");
    projection.runs[0] = { id: "r2", status: "completed", completedAt: "2026-11-20T09:10:00Z" };
    projection.messages[0] = { id: "m2", role: "assistant", runId: "r2", text: "Done again.", streaming: false };
    projection.turnItems = [item(0, { type: "user_message", status: "completed", exitCode: undefined, runId: "r0" }), item(2, { input: "cd api && npm test", runId: "r2" })];
    assert.deepEqual((await adapter.report("t1")).checks, { tests: { ok: false, runs: 1, failed: 1, label: "npm test" } }, "the runner's own failure");
    // The skeptic on 7717d10f3219: a build through npm that failed, npm's banner and vite's error but no summary, is a failure.
    projection.runs[0] = { id: "r3", status: "completed", completedAt: "2026-11-20T09:20:00Z" };
    projection.messages[0] = { id: "m3", role: "assistant", runId: "r3", text: "Built.", streaming: false };
    projection.turnItems = [item(0, { type: "user_message", status: "completed", exitCode: undefined, runId: "r0" }), item(3, { input: "cd web && npm run build", runId: "r3" })];
    assert.deepEqual((await adapter.report("t1")).checks, { build: { ok: false, runs: 1, failed: 1, label: "npm build" } }, "was unknown");
  } finally { await adapter.close(); t3.close(); }
});

// The review's finding on 3.10: a long run whose history T3 wouldn't give back said only what the window held, nothing
// when that was none, which the brain took for "no test ran". It says its checks weren't read (`checksUnread`).
test("receipts: a long run whose history can't be read says its checks weren't read, not that none ran", async () => {
  const at = "2026-11-16T09:00:00Z";
  const item = (ordinal: number, runId: string, over: object) => ({ id: `i${ordinal}`, threadId: "t1", runId, ordinal, status: "completed", updatedAt: at, ...over });
  const all = [
    item(1, "r2", { type: "user_message", text: "Refactor it" }),
    item(2, "r2", { type: "command_execution", input: "pnpm test", status: "failed", exitCode: 1 }),
    ...Array.from({ length: 100 }, (_, n) => item(3 + n, "r2", { type: "reasoning", text: "thinking" })),
    item(103, "r2", { type: "assistant_message", text: "All done!", streaming: false }),
  ];
  const projection = {
    runs: [{ id: "r2", status: "completed", completedAt: at }],
    messages: [{ id: "i103", role: "assistant", runId: "r2", text: "All done!", streaming: false }],
    turnItems: all.slice(-77),
  };
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: { projects: [{ id: "p1", title: "api", workspaceRoot: "/work/api" }], threads: [thread("t1")] } }] }));
      if (f.tag === "orchestration.getThreadProjection") exit(ws, f.id, projection);
    },
    // T3 refuses its history.
    onHttp: () => null,
  });
  const adapter = new T3Adapter({ baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {}, auth: { issue: async () => ({ token: "good", sessionId: "s", expiresAt: new Date(Date.now() + 86400000).toISOString() }), revoke: async () => {} } });
  try {
    await adapter.start();
    const report = await adapter.report("t1");
    assert.equal(report.text, "All done!");
    assert.equal(report.checks, undefined);
    assert.equal(report.checksUnread, true);
  } finally { await adapter.close(); t3.close(); }
});

test("T3Adapter: a thread with pendingBackgroundTasks stays running with its latest reply and safe progress, then completes when cleared", async () => {
  let push: (v: any) => void = () => {};
  const t3 = await fakeT3({
    onRequest: (f, ws) => {
      if (f.tag === "orchestration.subscribeShell") {
        push = (v) => ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [v] }));
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: f.id, values: [{ kind: "snapshot", snapshot: {
          projects: [{ id: "p1", title: "game" }],
          threads: [
            thread("parent", {
              title: "Recursive Turret Defense Game Design",
              status: "completed",
              pendingBackgroundTasks: [
                { taskId: "bg1", kind: "subagent", description: "Phase 3 combat tuning", childThreadId: "sub1" },
                { taskId: "bg2", kind: "command", awaited: true, description: "Run test suite", command: "SECRET=xyz bun test" },
              ],
            }),
            thread("sub1", { title: "Phase 3 combat tuning", status: "running", pendingBackgroundTasks: [], lineage: { parentThreadId: "parent", relationshipToParent: "subagent" } }),
            // Older T3 server (no pendingBackgroundTasks field): falls back to running subagent children.
            thread("legacy", { title: "Legacy parent", status: "completed" }),
            thread("legacy-sub", { title: "Legacy worker", status: "running", lineage: { parentThreadId: "legacy", relationshipToParent: "subagent" } }),
          ],
        } }] }));
      } else if (f.tag === "orchestration.getThreadProjection") {
        exit(ws, f.id, {
          runs: [{ id: "r1", status: "completed", completedAt: "2026-10-16T08:00:00Z" }],
          messages: [{ id: "m1", role: "assistant", text: "Kickoff posted; delegating Phase 3 now.", streaming: false, runId: "r1" }],
          turnItems: [],
        });
      }
    },
  });
  const adapter = new T3Adapter({
    baseUrl: t3.base, cli: ["t3"], label: "test", log: () => {},
    auth: { issue: async () => ({ token: "good", sessionId: "s1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }), revoke: async () => {} },
  });
  try {
    await adapter.start();
    const byId = Object.fromEntries((await adapter.list()).map((i) => [i.id, i]));
    assert.equal(byId.parent!.status, "running");
    assert.equal(byId.legacy!.status, "running");

    const rep = await adapter.report("parent");
    assert.equal(rep.text, "Kickoff posted; delegating Phase 3 now.");
    assert.equal(rep.reply?.messageId, "m1");
    assert.ok(rep.progress && /Phase 3 combat tuning/.test(rep.progress) && /Run test suite/.test(rep.progress), String(rep.progress));
    assert.doesNotMatch(rep.progress!, /SECRET=xyz/, "never leak raw shell commands into progress");

    const legacyRep = await adapter.report("legacy");
    assert.match(legacyRep.progress ?? "", /Legacy worker/);

    const changes: string[][] = [];
    adapter.watch((ids) => changes.push(ids));
    push({ kind: "thread.updated", location: "active", thread: thread("parent", { title: "Recursive Turret Defense Game Design", status: "completed", pendingBackgroundTasks: [] }) });
    push({ kind: "thread.updated", location: "active", thread: thread("legacy-sub", { title: "Legacy worker", status: "completed", lineage: { parentThreadId: "legacy", relationshipToParent: "subagent" } }) });
    await new Promise((r) => setTimeout(r, 100));
    const after = Object.fromEntries((await adapter.list()).map((i) => [i.id, i]));
    assert.equal(after.parent!.status, "completed");
    assert.equal(after.legacy!.status, "completed");
    assert.ok(changes.some((ids) => ids.includes("parent")));
    assert.ok(changes.some((ids) => ids.includes("legacy")));
  } finally {
    await adapter.close();
    t3.close();
  }
});
