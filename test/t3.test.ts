import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { answersFor, folderOf, mapStatus, snoozedUntil, T3Adapter, titleFrom, toCommand, toLaunch, type ShellThread } from "../src/t3/adapter.ts";
import { worktreeStart } from "../src/work.ts";
import type { LaunchProfile } from "../src/contract.ts";
import { ConnectionError, RpcClient, RpcError } from "../src/t3/rpc.ts";

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

/** A fake T3: ticket endpoint plus a socket that speaks the captured Effect RPC frames. */
async function fakeT3(handlers: { onRequest: (frame: any, ws: WebSocket) => void; tokens?: Set<string> }) {
  const tokens = handlers.tokens ?? new Set(["good"]);
  const frames: any[] = [];
  const sockets: WebSocket[] = [];
  const http = createServer((req, res) => {
    if (req.url === "/api/auth/websocket-ticket" && req.method === "POST") {
      const ok = tokens.has(String(req.headers.authorization).replace("Bearer ", ""));
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify(ok ? { ticket: "tk" } : { error: "no" }));
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
  return { base, frames, sockets, close: () => { for (const s of sockets) s.terminate(); wss.close(); http.close(); } };
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
          runs: [{ id: "r1", status: "completed", completedAt: "2026-10-16T07:30:00Z" }, { id: "r3", status: "failed", completedAt: "2026-10-16T07:40:00Z" }, { id: "r2", status: runStatus }],
          messages: [
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
    const kid = { text: "Done: it builds.", progress: "Next I'll run the tests.", question: null, reply: { runId: "r1", messageId: "m1", at: "2026-10-16T07:30:00Z" } };
    assert.deepEqual(await adapter.report("kid"), kid, "the reply is r1's, finished when r1 did: r3 failed without one");
    runStatus = "waiting";
    assert.deepEqual(await adapter.report("kid"), kid, "waiting notes are still progress, not a finished reply");
    assert.deepEqual(await adapter.replies("kid"), [{ ...kid.reply, text: "Done: it builds.", prompt: null }], "only finished runs with a reply; r3 failed without one");

    assert.deepEqual(await adapter.execute({ kind: "settle", itemId: "a" }, "P-1:a"), { ok: true });
    assert.deepEqual(await adapter.markRead("a", "2026-10-16T08:05:00Z", "driver-visit:m1"), { ok: true });
    // "a" is asking which host: a follow-up answers it rather than queueing behind it. "kid" asks nothing.
    assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: "a", message: "Quartz" }, "P-2:a"), { ok: true });
    assert.deepEqual(await adapter.execute({ kind: "follow_up", itemId: "kid", message: "Go on." }, "P-3:kid"), { ok: true });
    assert.deepEqual(commands.slice(2).map((c) => [c.type, c.answers]), [["runtime-request.respond", { q1: "Quartz" }], ["message.dispatch", undefined]]);
    assert.deepEqual(commands[2], { type: "runtime-request.respond", commandId: "P-2:a", threadId: "a", requestId: "r1", answers: { q1: "Quartz" } });
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
    assert.deepEqual(await rejected.execute({ kind: "settle", itemId: "a" }, "k"), { ok: false, error: "Driver's access to T3 was revoked." });
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
  const message = "(Dictated by voice in Driver and transcribed on my phone.)\n\nAdd gift cards to checkout, with a balance page and tests for every edge case.";
  const launch = toLaunch({ kind: "start_work", placeId: "p1", message, profile: build }, "P-2:start", {}) as any;
  assert.deepEqual([launch.title, launch.generateTitle, launch.initialMessage.text], ["Add gift cards to checkout, with a balance page…", true, message]);
  assert.equal(titleFrom("Fix the login."), "Fix the login");
});

test("a new worktree starts from the policy's branch where the repository has it, HEAD where it doesn't, and nowhere outside a repository", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worktree-start-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  const repo = (name: string, branch: string) => {
    const r = join(dir, name);
    git(dir, "init", "-q", "-b", branch, r);
    git(r, "commit", "-q", "--allow-empty", "-m", "first");
    return r;
  };
  const main = repo("main", "main"), master = repo("master", "master");
  const notes = join(dir, "notes");
  execFileSync("mkdir", [notes]);
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
    assert.deepEqual(adapter.places(), [{ id: "p1", name: "nix", activeAt: "2026-10-16T08:00:00Z", folder: "mono/nix", repo: "mono-nix" }, { id: "p2", name: "driver", activeAt: null }]);
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
    assert.equal((await adapter.execute({ kind: "archive", itemId: "hidden" }, "hidden")).ok, false);
    assert.equal((await adapter.markRead("hidden", "2026-10-30T12:00:00Z", "read-hidden") as any).ok, false);
    assert.equal((await adapter.execute({ kind: "start_work", placeId: "p2", title: "Hidden", message: "Go", profile: { name: "Build", workspace: "worktree", runtimeMode: "full-access", interactionMode: "default" } }, "launch-hidden")).ok, false);
    assert.deepEqual(projections, []);
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
});
