// The Pi adapter against synthetic session files, a synthetic registry and socket for 10 & 2's Pi extension, and a fake
// `pi` run through the headless runner. No real Pi, no model, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sessionForKey, shortTitle } from "../src/pi/adapter.ts";
import { installPiExtension, MARKER, piExtensionStatus, uninstallPiExtension, extensionSource } from "../src/pi/extension.ts";
import { promptText } from "../src/pi/turn.ts";
import type { Action, LaunchProfile } from "../src/contract.ts";
import { fakePi, harness, until } from "./fixtures/pi/helpers.ts";

const build: LaunchProfile = { name: "Build", runtimeMode: "full-access", workspace: "worktree", interactionMode: "default" };
const plan: LaunchProfile = { name: "Plan", runtimeMode: "full-access", workspace: "worktree", interactionMode: "plan" };
const normal: LaunchProfile = { name: "Normal", runtimeMode: "auto", workspace: "root", interactionMode: "default" };
const follow = (itemId: string, message: string): Action => ({ kind: "follow_up", itemId, message });
chmodSync(fakePi, 0o755);

test("sessions at both folder levels are listed with their state, title and group; hidden, old and foreign files aren't", async (t) => {
  const h = harness(t);
  const done = h.completed();
  const named = h.session(); named.add({ type: "session_info", name: "Lap timer polish" }); named.user("Make it faster"); named.assistant("Done, it's faster.");
  const failed = h.session(); failed.user("Break"); failed.assistant("", "error", { errorMessage: "Provider error" });
  const aborted = h.session(); aborted.user("Stop me"); aborted.assistant("Partial", "aborted");
  const pending = h.session(undefined, h.cwd, true); pending.user("A very long first message that goes on and on about what the lap timer should do next, and more");
  const tool = h.session(); tool.user("Run it"); tool.assistant("", "toolUse"); tool.add({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });
  const elsewhere = join(h.root, "other"); mkdirSync(elsewhere); h.completed(undefined, elsewhere);
  const old = h.completed(); utimesSync(old.path, new Date(h.clock.now - 20 * 86_400_000), new Date(h.clock.now - 20 * 86_400_000));
  writeFileSync(join(h.agent, "sessions", "notes.jsonl"), "not json\n");
  await h.adapter.start();
  const items = new Map((await h.adapter.list()).map((i) => [i.id, i]));
  assert.equal(items.size, 6);
  assert.deepEqual([done, named, failed, aborted, pending, tool].map((s) => items.get(s.id)?.status), ["completed", "completed", "failed", "cancelled", "idle", "idle"]);
  assert.equal(items.get(done.id)!.title, "Synthetic request.");
  assert.equal(items.get(named.id)!.title, "Lap timer polish");
  assert.equal(items.get(pending.id)!.title, shortTitle("A very long first message that goes on and on about what the lap timer should do next, and more"));
  assert.match(items.get(pending.id)!.title, /…$/);
  assert.equal(items.get(done.id)!.group, "project");
  assert.equal(items.get(done.id)!.pendingQuestion, false);
  assert.ok(items.get(done.id)!.lastRunAt);
  assert.equal(h.adapter.places().length, 1);
  assert.deepEqual(h.adapter.places()[0]!.name, "project");
});

test("the reply is the active branch's: the parent chain up from the file's last entry", async (t) => {
  const h = harness(t), s = h.session();
  s.user("Pick a database");
  const answered = s.assistant("Postgres, then.");
  s.user("Use Postgres", s.add({ type: "custom", customType: "x", data: {} }));
  s.assistant("Done with Postgres.");
  // Back up the tree (`/tree`): a new branch from the first reply.
  s.add({ type: "branch_summary", summary: "tried Postgres" }, answered);
  s.user("Use SQLite instead"); s.assistant("Done with SQLite.");
  await h.adapter.start();
  const report = await h.adapter.report(s.id);
  assert.equal(report.text, "Done with SQLite.");
  assert.equal(report.question, null);
  const replies = await h.adapter.replies(s.id);
  assert.deepEqual(replies.map((r) => [r.text, r.prompt]), [["Done with SQLite.", "Use SQLite instead"], ["Postgres, then.", "Pick a database"]]);
  assert.equal(report.reply?.messageId, replies[0]!.messageId);
});

test("a big session is read incrementally, and a new entry updates it", async (t) => {
  const h = harness(t), s = h.completed();
  s.add({ type: "custom", customType: "blob", data: { pad: "x".repeat(200_000) } });
  await h.adapter.start();
  assert.equal((await h.adapter.report(s.id)).text, "Synthetic answer.");
  s.user("Again"); s.assistant("Second answer.");
  assert.equal((await h.adapter.report(s.id)).text, "Second answer.");
  assert.equal((await h.adapter.replies(s.id)).length, 2);
});

test("an open Pi's status comes from the extension's registry; dead or socketless entries are ignored", async (t) => {
  const h = harness(t);
  const busy = h.completed(), waiting = h.completed(), asking = h.completed(), dead = h.completed(), nosock = h.completed();
  await h.live(busy.id, "busy");
  await h.live(waiting.id, "waiting", { prompt: { kind: "confirm", title: "Allow rm -rf build?", since: "2026-11-10T07:00:00.000Z" } });
  await h.live(asking.id, "waiting", { questions: [{ questionId: "q1", title: "Which database?", options: ["Postgres", "SQLite"] }] });
  writeFileSync(join(h.agent, "10and2", `${dead.id}.json`), JSON.stringify({ sessionId: dead.id, cwd: h.cwd, pid: 2 ** 22 + 12345, status: "busy" }));
  writeFileSync(join(h.agent, "10and2", `${dead.id}.sock`), "");
  writeFileSync(join(h.agent, "10and2", `${nosock.id}.json`), JSON.stringify({ sessionId: nosock.id, cwd: h.cwd, pid: process.pid, status: "busy" }));
  // A fresh open Pi with nothing written yet still shows.
  const fresh = randomUUID(); await h.live(fresh, "idle", { name: "Fresh one" });
  const updates: [string[], boolean][] = [];
  h.adapter.watch((ids, urgent) => updates.push([ids, urgent]));
  await h.adapter.start();
  const items = new Map((await h.adapter.list()).map((i) => [i.id, i]));
  assert.equal(items.get(busy.id)!.status, "running");
  assert.equal(items.get(waiting.id)!.status, "waiting");
  assert.equal(items.get(waiting.id)!.pendingQuestion, true);
  assert.ok(items.get(waiting.id)!.questionId);
  assert.equal(items.get(asking.id)!.questionId, "q1");
  assert.equal(items.get(dead.id)!.status, "completed");
  assert.equal(items.get(nosock.id)!.status, "completed");
  assert.equal(items.get(fresh)!.title, "Fresh one");
  assert.equal(items.get(fresh)!.status, "idle");
  assert.equal((await h.adapter.report(waiting.id)).question, "Allow rm -rf build?");
  assert.equal((await h.adapter.report(asking.id)).question, "Which database? Options: Postgres / SQLite.");
  assert.ok(updates.some(([ids, urgent]) => urgent && ids.includes(asking.id)), "a question is urgent news");
  assert.match(h.adapter.refusals()[waiting.id]!.follow_up!, /Answer it in Pi/);
});

test("a follow-up to an open Pi goes through its socket as a steer, and counts on the extension's ack, once", async (t) => {
  const h = harness(t), s = h.completed(); const lines = await h.live(s.id, "busy");
  await h.adapter.start();
  assert.equal(await h.adapter.check(follow(s.id, "Also check the README")), null);
  assert.deepEqual(await h.adapter.execute(follow(s.id, "Also check the README"), "steer"), { ok: true });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "user"); assert.equal(lines[0].text, "Also check the README"); assert.equal(lines[0].deliverAs, "steer");
  assert.deepEqual(await h.adapter.execute(follow(s.id, "Also check the README"), "steer"), { ok: true });
  assert.equal(lines.length, 1, "the same key never sends twice");
  const reused = await h.adapter.execute(follow(s.id, "Other words"), "steer");
  assert.equal(reused.ok, false);
});

test("an open Pi that doesn't ack is unknown and never resent; one that can't be reached says so", async (t) => {
  const h = harness(t, { acceptanceTimeoutMs: 200 }), s = h.completed(); const lines = await h.live(s.id, "idle", {}, { silent: true });
  await h.adapter.start();
  const first = await h.adapter.execute(follow(s.id, "Hello"), "quiet");
  assert.equal(first.ok, false); if (!first.ok) { assert.equal(first.unknown, true); assert.match(first.error, /won't send it again/); }
  assert.deepEqual(await h.adapter.execute(follow(s.id, "Hello"), "quiet"), first);
  assert.equal(lines.length, 1);

  const g = harness(t, { acceptanceTimeoutMs: 200 }), u = g.completed();
  writeFileSync(join(g.agent, "10and2", `${u.id}.json`), JSON.stringify({ sessionId: u.id, cwd: g.cwd, pid: process.pid, status: "idle" }));
  writeFileSync(join(g.agent, "10and2", `${u.id}.sock`), ""); // a socket file nobody listens on
  await g.adapter.start();
  const gone = await g.adapter.execute(follow(u.id, "Hello"), "gone");
  assert.equal(gone.ok, false); if (!gone.ok) { assert.equal(gone.unknown, undefined); assert.match(gone.error, /couldn't reach/); }
});

test("with steering off, an open Pi is refused in words and nothing is sent", async (t) => {
  const h = harness(t, { policy: { steer: false } }), s = h.completed(); const lines = await h.live(s.id, "idle");
  await h.adapter.start();
  const why = await h.adapter.check(follow(s.id, "x"));
  assert.equal(why, "It's open in Pi, and this computer doesn't let 10 & 2 send to open sessions.");
  assert.equal(h.adapter.refusals()[s.id]?.follow_up, why);
  const r = await h.adapter.execute(follow(s.id, "x"), "no-steer");
  assert.deepEqual(r, { ok: false, error: why });
  assert.equal(lines.length, 0);

  const capped = harness(t, { policy: { maxRuntimeMode: "auto" } }), c = capped.completed(); await capped.live(c.id, "idle");
  await capped.adapter.start();
  assert.deepEqual(await capped.adapter.execute(follow(c.id, "Fine"), "open-capped"), { ok: true }, "an open session is the user's own run: the ceiling doesn't stop a steer");
});

test("the extension's question is answered with the option the user named, else their words", async (t) => {
  const h = harness(t), s = h.completed();
  const lines = await h.live(s.id, "waiting", { questions: [{ questionId: "q7", title: "Which database?", options: ["Postgres", "SQLite", "Skip"] }] });
  await h.adapter.start();
  assert.deepEqual(await h.adapter.execute(follow(s.id, "SQLite, please."), "answer"), { ok: true });
  assert.deepEqual({ ...lines[0], id: undefined }, { id: undefined, type: "answer", questionId: "q7", value: "SQLite" });
  assert.deepEqual(await h.adapter.execute(follow(s.id, "Neither, use DuckDB"), "answer-2"), { ok: true });
  assert.equal(lines[1].value, "Neither, use DuckDB");

  const off = harness(t, { policy: { answer: false } }), o = off.completed();
  const none = await off.live(o.id, "waiting", { questions: [{ questionId: "q8", title: "Which?", options: ["A"] }] });
  await off.adapter.start();
  assert.match((await off.adapter.check(follow(o.id, "A")))!, /doesn't let 10 & 2 answer/);
  assert.equal(none.length, 0);
});

test("a session nothing has open is continued headless by the runner, in its own folder, counted from its file", async (t) => {
  const h = harness(t), s = h.completed();
  await h.adapter.start();
  assert.equal(await h.adapter.check(follow(s.id, "Now add tests")), null);
  assert.deepEqual(await h.adapter.execute(follow(s.id, "Now add tests"), "closed"), { ok: true });
  const call = h.calls().find((c) => c.args)!;
  assert.deepEqual(call.args, ["--mode", "rpc", "--session", s.path]);
  assert.equal(call.cwd, h.cwd);
  assert.equal(call.headless, "1");
  await until(async () => (await h.adapter.report(s.id)).text === "ACK Now add tests");
  await until(async () => (await h.adapter.list()).find((i) => i.id === s.id)!.status === "completed");
  assert.deepEqual(await h.adapter.execute(follow(s.id, "Now add tests"), "closed"), { ok: true });
  assert.equal(h.calls().filter((c) => c.args).length, 1, "the same key never runs twice");
});

test("words starting with a slash stay words in a headless turn", async (t) => {
  assert.equal(promptText("/compact now"), " /compact now");
  assert.equal(promptText("plain"), "plain");
  const h = harness(t), s = h.completed(); await h.adapter.start();
  assert.deepEqual(await h.adapter.execute(follow(s.id, "/compact now"), "slash"), { ok: true });
  assert.equal(h.calls().find((c) => c.prompt)!.prompt, " /compact now");
});

test("a headless turn with no evidence in the file is unknown and never repeated", async (t) => {
  const old = process.env.FAKE_PI_NEVER_ECHO; process.env.FAKE_PI_NEVER_ECHO = "1";
  t.after(() => { if (old === undefined) delete process.env.FAKE_PI_NEVER_ECHO; else process.env.FAKE_PI_NEVER_ECHO = old; });
  const h = harness(t, { acceptanceTimeoutMs: 300 }), s = h.completed(); await h.adapter.start();
  const first = await h.adapter.execute(follow(s.id, "Lost?"), "unknown");
  assert.equal(first.ok, false); if (!first.ok) { assert.equal(first.unknown, true); assert.match(first.error, /won't send it again/); }
  assert.deepEqual(await h.adapter.execute(follow(s.id, "Lost?"), "unknown"), first);
  await until(() => h.calls().some((c) => c.prompt));
  assert.equal(h.calls().filter((c) => c.args).length, 1);
  // A restarted connector remembers it too.
  const again = h.reopen(); await again.start();
  assert.deepEqual(await again.execute(follow(s.id, "Lost?"), "unknown"), first);
});

test("a missing pi is said plainly, and nothing counts as sent", async (t) => {
  const h = harness(t), s = h.completed();
  const a = h.reopen({ piBin: join(h.root, "no-such-pi") }); await a.start();
  assert.deepEqual(await a.execute(follow(s.id, "Hello"), "no-pi"), { ok: false, error: "Pi couldn't be started. Check that it's installed on this machine." });
});

test("continuing a closed session needs the extension, and a ceiling that allows Pi's full access", async (t) => {
  const bare = harness(t, { extension: false }), b = bare.completed(); await bare.adapter.start();
  assert.match((await bare.adapter.check(follow(b.id, "x")))!, /10and2 pi install/);

  const capped = harness(t, { policy: { maxRuntimeMode: "auto" } }), c = capped.completed(); await capped.adapter.start();
  assert.equal(await capped.adapter.check(follow(c.id, "x")), "Pi runs its tools without asking, so this computer's settings don't allow continuing it while it's closed.");
  const limited = harness(t, { policy: { limits: { pi: { maxRuntimeMode: "approval-required" } } } }), l = limited.completed(); await limited.adapter.start();
  assert.match((await limited.adapter.check(follow(l.id, "x")))!, /runs its tools without asking/);
  assert.equal(capped.calls().length + limited.calls().length + bare.calls().length, 0);
});

test("new work starts headless under a session id from its key, named, in the place's folder", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  const place = h.adapter.places()[0]!.id;
  const started = await h.adapter.execute({ kind: "start_work", placeId: place, title: "Fastest lap", message: "Show the fastest lap", profile: build }, "start-1");
  const id = sessionForKey("start-1");
  assert.deepEqual(started, { ok: true, itemId: id });
  assert.notEqual(id, sessionForKey("start-2"));
  const call = h.calls().find((c) => c.args)!;
  assert.deepEqual(call.args, ["--mode", "rpc", "--session-id", id, "--name", "Fastest lap"]);
  assert.equal(call.cwd, h.cwd);
  await until(async () => (await h.adapter.list()).some((i) => i.id === id && i.title === "Fastest lap"));
  assert.deepEqual(await h.adapter.execute({ kind: "start_work", placeId: place, title: "Fastest lap", message: "Show the fastest lap", profile: build }, "start-1"), started);
  assert.equal(h.calls().filter((c) => c.args).length, 1);

  await h.adapter.execute({ kind: "start_work", placeId: place, message: "Tidy the README", profile: build }, "start-untitled");
  assert.deepEqual(h.calls().filter((c) => c.args)[1]!.args, ["--mode", "rpc", "--session-id", sessionForKey("start-untitled")]);
});

test("new work is refused for plan mode, a profile short of full access, or a ceiling below it", async (t) => {
  const h = harness(t); h.completed(); await h.adapter.start();
  const place = h.adapter.places()[0]!.id;
  assert.match((await h.adapter.check({ kind: "start_work", placeId: place, message: "x", profile: plan }))!, /no plan mode/);
  assert.match((await h.adapter.check({ kind: "start_work", placeId: place, message: "x", profile: normal }))!, /full-access profile/);
  assert.equal((await h.adapter.execute({ kind: "start_work", placeId: place, message: "x", profile: plan }, "plan")).ok, false);

  const capped = harness(t, { policy: { maxRuntimeMode: "auto" } }); capped.completed(); await capped.adapter.start();
  const cappedPlace = capped.adapter.places()[0]!.id;
  assert.equal(await capped.adapter.check({ kind: "start_work", placeId: cappedPlace, message: "x", profile: build }), "Pi runs its tools without asking, so this computer's settings don't allow starting it.");
  assert.equal(h.calls().length + capped.calls().length, 0);

  const noStart = harness(t, { policy: { limits: { pi: { actions: ["follow_up"] } } } }); noStart.completed(); await noStart.adapter.start();
  assert.deepEqual(noStart.adapter.places(), []);
});

test("settle, snooze and archive are kept by the connector", async (t) => {
  const h = harness(t), a = h.completed(), b = h.completed(), c = h.completed(); await h.adapter.start();
  const until_ = new Date(h.clock.now + 3_600_000).toISOString();
  assert.deepEqual(await h.adapter.execute({ kind: "settle", itemId: a.id }, "s"), { ok: true });
  assert.deepEqual(await h.adapter.execute({ kind: "snooze", itemId: b.id, until: until_ }, "z"), { ok: true });
  assert.deepEqual(await h.adapter.execute({ kind: "archive", itemId: c.id }, "x"), { ok: true });
  const items = new Map((await h.adapter.list()).map((i) => [i.id, i]));
  assert.equal(items.get(a.id)!.settled, true);
  assert.equal(items.get(b.id)!.snoozedUntil, until_);
  assert.equal(items.has(c.id), false);
  // A newer run brings a settled session back.
  h.clock.now += 60_000;
  a.user("More"); a.assistant("More done.");
  assert.equal((await h.adapter.list()).find((i) => i.id === a.id)!.settled, false);
});

test("the extension is installed, updated and removed only where the file is ours", async (t) => {
  const h = harness(t, { extension: false }), path = join(h.agent, "extensions", "10and2.ts");
  assert.equal(piExtensionStatus(h.agent).state, "missing");
  assert.deepEqual(installPiExtension(h.agent), { state: "installed", path });
  assert.equal(readFileSync(path, "utf8"), readFileSync(extensionSource(), "utf8"));
  assert.equal(readFileSync(path, "utf8").split("\n")[0], MARKER);
  assert.equal(piExtensionStatus(h.agent).state, "installed");
  writeFileSync(path, `${MARKER}\n// an older copy\n`);
  assert.equal(piExtensionStatus(h.agent).state, "outdated");
  installPiExtension(h.agent);
  assert.equal(piExtensionStatus(h.agent).state, "installed");
  assert.equal(uninstallPiExtension(h.agent).state, "missing");
  assert.equal(existsSync(path), false);
  assert.equal(uninstallPiExtension(h.agent).state, "missing");

  writeFileSync(path, "// someone else's extension\n");
  assert.equal(piExtensionStatus(h.agent).state, "foreign");
  assert.throws(() => installPiExtension(h.agent), /another extension/);
  assert.equal(uninstallPiExtension(h.agent).state, "foreign");
  assert.equal(readFileSync(path, "utf8"), "// someone else's extension\n");
});

test("the extension's test command exists only when asked for", () => {
  const source = readFileSync(extensionSource(), "utf8");
  assert.match(source, /if \(process\.env\.TENANDTWO_PI_TEST === "1"\) \{\s*pi\.registerCommand\("tt-ask"/);
});
