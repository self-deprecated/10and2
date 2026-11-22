// Sends and starts held on this computer for later (src/schedules.ts; docs/launch/engine.md §5, §11 stage 4a): an
// injected clock, a gate standing for the link, and the fake work system behind the connector's Local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, Report, WorkItem } from "../src/contract.ts";
import { Ledger } from "../src/ledger.ts";
import { Local } from "../src/local.ts";
import { parsePolicy } from "../src/policy.ts";
import { endsAsking, MAX_HELD, parseSchedule, Schedules, SKEW_MS, SLEEP_GAP_MS, TICK_MS, type Held } from "../src/schedules.ts";
import { envelope, setUp } from "../src/claude/inbox.ts";
import { FakeAdapter, item } from "./fakes.ts";
import { removeDir } from "./fixtures/platform.ts";

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-20T01:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const AT = T0 + 2 * HOUR; // 03:00
const profile = { name: "Full access", workspace: "worktree", runtimeMode: "full-access", interactionMode: "default" } as const;

/** One send to thread "a" at 03:00, agreed at 01:00 while it wasn't working. */
function send(over: Record<string, unknown> = {}) {
  return {
    v: 1, id: "R-r1-1:a", action: { kind: "follow_up", itemId: "a", message: "carry on" },
    when: { at: iso(AT) }, until: iso(AT + 2 * HOUR),
    guard: { agreedAt: iso(T0 - MIN), running: false, lastRunAt: null, questionId: null },
    said: "Send “carry on” to Thread a at 03:00", zone: "Europe/Copenhagen", ...over,
  };
}
function start(over: Record<string, unknown> = {}) {
  return send({ id: "R-r2-1:start", action: { kind: "start_work", placeId: "p-proj", title: "Update the dependencies", message: "Update the dependencies", profile }, said: "Start a thread in proj at 03:00", ...over });
}

function setup(t: { after: (f: () => void | Promise<void>) => void }, o: { items?: WorkItem[]; policy?: Record<string, unknown>; retrySafe?: boolean; dir?: string; ledger?: Ledger; device?: string } = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "schedules-"));
  const fake = new FakeAdapter(o.items ?? [item("a")]);
  const policy = parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access", rules: "start", ...o.policy }));
  const local = new Local([{ prefix: "", adapter: fake, retrySafe: o.retrySafe ?? true }], policy);
  const ledger = o.ledger ?? new Ledger(dir);
  const env = { now: T0, gate: true, seq: 0 };
  const changes: number[] = [];
  const s = new Schedules({ ledger, local, policy, device: o.device ?? "device-1", gate: () => env.gate, now: () => env.now });
  s.watch(() => changes.push(env.now));
  if (!o.ledger) t.after(async () => { await ledger.close(); if (!o.dir) removeDir(dir); });
  const set = (list: unknown[], seq = ++env.seq) => s.set(seq, list, env.now);
  /** Looks every `step` (a tick, by default) until `to`, as the runner does on an awake computer. */
  const run = async (to: number, step = TICK_MS) => { while (env.now < to) { env.now = Math.min(to, env.now + step); await s.tick(); } };
  const one = (id = "R-r1-1:a") => s.view().find((h) => h.id === id);
  return { dir, fake, policy, local, ledger, env, s, set, run, one, changes };
}
const held = (a: ReturnType<Schedules["set"]>): Held[] => { assert.ok("held" in a, JSON.stringify(a)); return a.held; };

test("a send fires once at its time, never before, through the Ledger under its own id", async (t) => {
  const { s, fake, set, run, one, env, changes } = setup(t);
  const answer = held(set([send()]));
  assert.deepEqual(answer, [{ id: "R-r1-1:a", state: "waiting", at: iso(AT) }]);
  await run(AT - 1000);
  assert.equal(fake.executed.length, 0, "nothing before its time");
  env.now = AT; await s.tick();
  assert.deepEqual(fake.executed, [{ action: { kind: "follow_up", itemId: "a", message: "carry on" }, key: "R-r1-1:a" }]);
  await run(AT + 10 * MIN);
  assert.equal(fake.executed.length, 1, "once");
  const h = one()!;
  assert.equal(h.state, "sent");
  assert.equal(h.firedAt, iso(AT));
  assert.deepEqual(h.receipt, { ok: true });
  assert.equal(h.code, undefined, "on time: no reason it was late");
  assert.deepEqual(h.after, { lastRunAt: null, questionId: null }, "the target at firing, a chain's baseline");
  assert.ok(changes.includes(AT), "an outcome tells the link to notify");
});

test("asleep over its time: sent on waking inside the window, told as asleep; past the window it's missed, never sent", async (t) => {
  const late = setup(t);
  held(late.set([send()]));
  await late.run(AT - 5 * MIN);
  late.env.now = AT + 91 * MIN; // the lid shut at 02:55, opened at 04:31
  await late.s.tick();
  assert.equal(late.fake.executed.length, 1, "sent with nothing asked, inside the 2 hours");
  assert.deepEqual([late.one()!.state, late.one()!.code, late.one()!.firedAt], ["sent", "asleep", iso(AT + 91 * MIN)]);

  const missed = setup(t);
  held(missed.set([send()]));
  await missed.run(AT - 5 * MIN);
  missed.env.now = AT + 2 * HOUR + MIN; // woke after 05:00
  await missed.s.tick();
  assert.equal(missed.fake.executed.length, 0);
  assert.deepEqual([missed.one()!.state, missed.one()!.code, missed.one()!.why], ["missed", "asleep", "This computer was asleep."]);
  await missed.run(AT + 3 * HOUR);
  assert.equal(missed.fake.executed.length, 0, "never sent afterwards");
});

test("awake with the link down at its time and past the window: missed, said as not reached; a gap only counts as sleep past a minute", async (t) => {
  const { fake, set, run, one, env } = setup(t);
  held(set([send()]));
  env.gate = false;
  await run(AT + 2 * HOUR + MIN, SLEEP_GAP_MS); // looks a minute apart: never a gap
  assert.equal(fake.executed.length, 0, "not synced, nothing fires");
  assert.deepEqual([one()!.state, one()!.code], ["missed", "unreached"]);
  assert.equal(SLEEP_GAP_MS, 60_000, "a minute apart is awake");
});

test("held while the link is down at its time, then sent when it's back: told as not reached", async (t) => {
  const { fake, set, run, one, env } = setup(t);
  held(set([send()]));
  env.gate = false;
  await run(AT + 20 * MIN);
  assert.deepEqual([one()!.state, one()!.code], ["waiting", "unreached"], "Watching can say why it hasn't gone");
  env.gate = true;
  await run(AT + 21 * MIN);
  assert.equal(fake.executed.length, 1);
  assert.deepEqual([one()!.state, one()!.code], ["sent", "unreached"]);
});

test("two sets out of order: the older is refused and the newer kept; the clock off by more than 5 minutes refuses the whole set", async (t) => {
  const { s, fake, set, run, one, env } = setup(t);
  held(set([send()], 2));
  assert.deepEqual(set([], 1), { refused: "stale", error: "An older set (1) than one already applied (2); nothing was changed." });
  assert.deepEqual(set([], 2), { refused: "stale", error: "An older set (2) than one already applied (2); nothing was changed." }, "a seq at the last applied is stale too");
  assert.equal(one()!.state, "waiting");
  const skewed = s.set(3, [], env.now - 7 * MIN);
  assert.deepEqual(skewed, { refused: "clock", minutes: 7, error: "This computer's clock is 7 minutes off, so it won't send anything until that's fixed." });
  assert.equal(one()!.state, "waiting", "a refused set changes nothing");
  assert.ok("held" in s.set(3, [send()], env.now + 4 * MIN), "4 minutes is within");
  await run(AT);
  assert.equal(fake.executed.length, 1, "the newer set's schedule fires");
  assert.throws(() => s.set(0, [], env.now), /seq/);
  assert.throws(() => s.set(5, {}, env.now), /schedules/);
  assert.throws(() => s.set(5, [], undefined), /clock/);
});

test("a set without an id cancels it; one already sent stays and is reported as it is", async (t) => {
  const { fake, set, run, one } = setup(t);
  held(set([send(), send({ id: "R-r3-1:a", when: { at: iso(AT + HOUR) }, until: iso(AT + 3 * HOUR) })]));
  await run(AT);
  assert.equal(one()!.state, "sent");
  const answer = held(set([]));
  assert.deepEqual(answer.map((h) => [h.id, h.state]), [["R-r1-1:a", "sent"], ["R-r3-1:a", "cancelled"]], "too late for the first; the second stopped");
  await run(AT + 2 * HOUR);
  assert.equal(fake.executed.length, 1);
  assert.equal(one("R-r3-1:a")!.state, "cancelled");
  assert.deepEqual(held(set([send({ id: "R-r3-1:a", when: { at: iso(AT + HOUR) }, until: iso(AT + 3 * HOUR) })])).find((h) => h.id === "R-r3-1:a")?.state, "cancelled", "a cancelled id can't come back");
});

test("the same id and content again is left as it is; the same id with other content is refused", async (t) => {
  const { set, one, s } = setup(t);
  held(set([send()]));
  const again = held(set([send()]));
  assert.deepEqual(again[0], { id: "R-r1-1:a", state: "waiting", at: iso(AT) });
  const other = held(set([send({ action: { kind: "follow_up", itemId: "a", message: "stop" } })]));
  assert.deepEqual(other[0], { id: "R-r1-1:a", state: "refused", code: "conflict", why: "That id was already used for something else." });
  assert.equal(one()!.state, "waiting", "the one held is kept, not cancelled");
  assert.equal(s.view().length, 1);
  assert.deepEqual(held(set([send(), send()]))[1], { id: "R-r1-1:a", state: "refused", code: "conflict", why: "That id is in the set twice." });
});

test("Stop while it's held for its work system not running cancels it, and nothing goes when it's back", async (t) => {
  const { fake, set, run, one } = setup(t);
  held(set([send()]));
  fake.live = false; // T3 Code not running
  await run(AT + MIN);
  assert.deepEqual([one()!.state, one()!.code, one()!.app], ["waiting", "app", "fake"]);
  held(set([]));
  fake.live = true;
  await run(AT + 5 * MIN);
  assert.equal(fake.executed.length, 0);
  assert.equal(one()!.state, "cancelled");
});

test("Stop landing while the checks at firing are awaited wins: nothing is dispatched or recorded", async (t) => {
  const { fake, set, s, env, one, ledger } = setup(t);
  held(set([send()]));
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  // The second look at the work system is the Ledger's refuse, last thing before dispatch.
  (fake as any).check = async () => { if (++calls === 2) await blocked; return null; };
  env.now = AT;
  const firing = s.tick();
  for (let i = 0; calls < 2 && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(calls, 2, "the Ledger's refuse is being awaited");
  held(set([]));
  release();
  await firing;
  assert.equal(fake.executed.length, 0);
  assert.equal(one()!.state, "cancelled");
  assert.equal(ledger.handle.prepare("SELECT COUNT(*) AS n FROM actions").get()!.n, 0, "no dispatch recorded against its key");
});

test("the link no longer synced while the checks at firing are awaited (a set answered busy, the link closing): nothing goes then, it waits for the next look", async (t) => {
  const { fake, set, s, env, one, ledger } = setup(t);
  held(set([send()]));
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  (fake as any).check = async () => { if (++calls === 2) await blocked; return null; };
  env.now = AT;
  const firing = s.tick();
  for (let i = 0; calls < 2 && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(calls, 2, "the Ledger's refuse is being awaited");
  env.gate = false; // a set_schedules frame came in and was answered busy: synced is cleared, the Stop not yet applied
  release();
  await firing;
  assert.equal(fake.executed.length, 0, "nothing dispatched");
  assert.equal(ledger.handle.prepare("SELECT COUNT(*) AS n FROM actions").get()!.n, 0, "nothing recorded against its key");
  assert.equal(one()!.state, "waiting", "still Stop's to cancel");
  // The set then applied without it: cancelled, never sent.
  env.gate = true;
  held(set([]));
  await s.tick();
  assert.deepEqual([one()!.state, fake.executed.length], ["cancelled", 0]);
});

test("a restart while firing for T3 Code is sent again only as any send goes: in its window, synced, still allowed; Stop or its end first and it's never sent", async (t) => {
  /** A connector killed after the claim and the dispatch's record (`firing`, `dispatching`), and started again. */
  const crashed = async (over: { policy?: Record<string, unknown>; items?: WorkItem[] } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "schedules-"));
    let ledger = new Ledger(dir);
    const first = setup(t, { dir, ledger });
    held(first.set([send()]));
    first.fake.execute = () => new Promise(() => {});
    first.env.now = AT;
    void first.s.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(first.one()!.state, "firing");
    (ledger as any).pending.clear(); ledger.handle.close();
    ledger = new Ledger(dir);
    const after = setup(t, { dir, ledger, ...over });
    // Its store closed first: Windows won't remove a folder with a file open in it.
    t.after(async () => { await ledger.close(); removeDir(dir); });
    return after;
  };
  // T3 not running until 3 days past its end, the link down meanwhile: never sent, it may have gone.
  const late = await crashed();
  late.fake.live = false;
  late.env.gate = false;
  await late.run(AT + 3 * 24 * HOUR, HOUR);
  late.fake.live = true; late.env.gate = true;
  await late.run(AT + 3 * 24 * HOUR + MIN);
  assert.equal(late.fake.executed.length, 0, "never sent after its end");
  assert.deepEqual([late.one()!.state, late.one()!.why], ["unknown", "The connector stopped while it was being sent."]);
  // T3 running, the link not yet synced: it waits; the reconnect's first set leaves it out (Stop): never sent.
  const stopped = await crashed();
  stopped.env.gate = false;
  await stopped.run(AT + MIN);
  assert.deepEqual([stopped.one()!.state, stopped.fake.executed.length], ["firing", 0], "nothing sent before the link is synced");
  held(stopped.set([], 10));
  stopped.env.gate = true;
  await stopped.run(AT + 2 * MIN);
  assert.equal(stopped.fake.executed.length, 0, "Stop always wins");
  assert.equal(stopped.one()!.state, "unknown");
  // Synced and kept in the set: sent again with the same key, as before.
  const kept = await crashed();
  kept.env.gate = false;
  await kept.run(AT + MIN);
  held(kept.set([send()], 10));
  kept.env.gate = true;
  await kept.run(AT + 2 * MIN);
  assert.deepEqual([kept.one()!.state, kept.fake.executed.map((e) => e.key)], ["sent", ["R-r1-1:a"]]);
  // The policy lowered over the restart (nothing set up for later now): never sent.
  const lowered = await crashed({ policy: { rules: "off" } });
  await lowered.run(AT + MIN);
  assert.deepEqual([lowered.one()!.state, lowered.fake.executed.length], ["unknown", 0]);
  // §5's checks at firing, as any send goes (stage 4's review): written in, asking something else, run again or holding a
  // command since the yes, it's never sent again, and since the first may have gone, its outcome isn't known.
  for (const [name, over] of [
    ["you wrote in it", { typed: { at: iso(AT + 5 * MIN), desk: iso(AT + 5 * MIN) } }],
    ["asking something else", { status: "waiting", pendingQuestion: true, questionId: "q-new" }],
    ["it ran again", { lastRunAt: iso(AT + 5 * MIN) }],
    ["holding a command", { status: "waiting", pendingQuestion: true, questionId: "g-1", gate: { command: "terraform apply", matched: "terraform apply", since: iso(AT + 5 * MIN) } }],
  ] as [string, Partial<WorkItem>][]) {
    const changed = await crashed({ items: [item("a", over)] });
    await changed.run(AT + 20 * MIN);
    assert.deepEqual([changed.one()!.state, changed.one()!.why, changed.fake.executed.length], ["unknown", "The connector stopped while it was being sent.", 0], name);
  }
  // Still on the run it was on at the yes: it waits, and goes once that run has ended.
  const busy = await crashed({ items: [item("a", { status: "running" })] });
  const g = { agreedAt: iso(T0 - MIN), running: true, lastRunAt: null, questionId: null };
  busy.ledger.handle.prepare("UPDATE schedules SET body = ? WHERE id = 'R-r1-1:a'").run(JSON.stringify(send({ guard: g })));
  await busy.run(AT + 10 * MIN);
  assert.deepEqual([busy.one()!.state, busy.fake.executed.length], ["firing", 0], "held by the run going on");
  const refused = () => readFileSync(join(busy.dir, "audit.jsonl"), "utf8").split("\n").filter((l) => l.includes('"state":"refused"')).length;
  assert.equal(refused(), 0, "asked first outside the Ledger, so a resend held for minutes doesn't write the audit log at every look");
  busy.fake.items[0] = item("a", { status: "completed", lastRunAt: iso(AT + 10 * MIN) });
  await busy.run(AT + 11 * MIN);
  assert.deepEqual([busy.one()!.state, busy.fake.executed.map((e) => e.key)], ["sent", ["R-r1-1:a"]]);
  // Stop landing while the resend's last check (the Ledger's refuse) is awaited wins: unknown, nothing sent.
  const racing = await crashed();
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  (racing.fake as any).check = async () => { if (++calls === 2) await blocked; return null; };
  const going = racing.s.tick();
  for (let i = 0; calls < 2 && i < 2000; i++) await new Promise((r) => setTimeout(r, 1));
  assert.equal(calls, 2, "the Ledger's refuse is being awaited");
  held(racing.set([], 10));
  release();
  await going;
  assert.deepEqual([racing.one()!.state, racing.fake.executed.length], ["unknown", 0]);
});

test("each check at firing: what holds it, and what means it's never sent (engine.md §5's table)", async (t) => {
  const finals: [string, Partial<WorkItem> | null, Record<string, unknown>, string, string][] = [
    ["gone", null, {}, "gone", "The thread is gone."],
    ["settled", { settled: true }, {}, "settled", "The thread is settled."],
    ["you wrote in it after the yes", { typed: { at: iso(T0 + MIN), desk: iso(T0 + MIN) } }, {}, "wrote", "You wrote in it after this was set up."],
    ["it ran after a yes given while it wasn't working", { status: "running" }, {}, "ran", "It ran again after this was set up."],
    ["its last run moved since a yes given while it wasn't working", { lastRunAt: iso(T0 + 30 * MIN) }, {}, "ran", "It ran again after this was set up."],
    ["asking a question other than at the yes", { status: "waiting", pendingQuestion: true, questionId: "q2" }, { guard: { agreedAt: iso(T0 - MIN), running: false, lastRunAt: null, questionId: "q1" } }, "asking", "It's asking something else now."],
  ];
  for (const [name, over, sched, code, why] of finals) {
    const x = setup(t, { items: over ? [item("a", over)] : [item("b")] });
    held(x.set([send(sched)]));
    await x.run(AT);
    assert.equal(x.fake.executed.length, 0, name);
    assert.deepEqual([x.one()!.state, x.one()!.code, x.one()!.why], ["not_sent", code, why], name);
  }
  // Holds: tried again at each look until its end, and sent once it can go.
  const typedBefore = setup(t, { items: [item("a", { typed: { at: iso(T0 - 2 * MIN), desk: null }, wroteAt: iso(T0 + MIN) })] });
  held(typedBefore.set([send()]));
  await typedBefore.run(AT);
  assert.equal(typedBefore.fake.executed.length, 1, "10 & 2's own send after the yes (wroteAt, not typed) isn't you writing");

  const busy = setup(t, { items: [item("a", { status: "running", lastRunAt: iso(T0 - HOUR) })] });
  held(busy.set([send({ guard: { agreedAt: iso(T0 - MIN), running: true, lastRunAt: iso(T0 - HOUR), questionId: null } })]));
  await busy.run(AT + 10 * MIN);
  assert.deepEqual([busy.one()!.state, busy.one()!.code], ["waiting", "busy"], "still the run it was on at the yes");
  busy.fake.items[0] = item("a", { status: "completed", lastRunAt: iso(AT + 10 * MIN) });
  await busy.run(AT + 11 * MIN);
  assert.deepEqual([busy.one()!.state, busy.one()!.code], ["sent", "busy"], "sent once that run ended, told why it was late");

  const sub = setup(t, { items: [item("a"), item("s", { parentId: "a", status: "running" })] });
  held(sub.set([send()]));
  await sub.run(AT + MIN);
  assert.deepEqual([sub.one()!.state, sub.one()!.code, sub.one()!.why], ["waiting", "busy", "Its subagents are still working."]);
  sub.fake.items[1] = item("s", { parentId: "a", status: "completed", lastRunAt: iso(AT + MIN) });
  await sub.run(AT + 3 * MIN);
  assert.equal(sub.one()!.state, "waiting", "a subagent that finished under 3 minutes ago is about to be answered");
  await sub.run(AT + 5 * MIN);
  assert.equal(sub.one()!.state, "sent");

  const same = setup(t, { items: [item("a", { status: "waiting", pendingQuestion: true, questionId: "q1" })] });
  held(same.set([send({ guard: { agreedAt: iso(T0 - MIN), running: false, lastRunAt: null, questionId: "q1" } })]));
  await same.run(AT);
  assert.equal(same.one()!.state, "sent", "the question it asked at the yes: the words answer it");
  assert.deepEqual(same.one()!.after, { lastRunAt: null, questionId: "q1" });

  // The work system's own refusal, and 2a's questionId guard, are final.
  const own = setup(t);
  (own.fake as any).check = async () => "It's open in a terminal, so 10 & 2 can't send to it.";
  held(own.set([send()]));
  await own.run(AT);
  assert.deepEqual([own.one()!.state, own.one()!.code, own.one()!.why], ["not_sent", "refused", "It's open in a terminal, so 10 & 2 can't send to it."]);
  const tap = setup(t);
  held(tap.set([send({ action: { kind: "follow_up", itemId: "a", message: "Yes", questionId: "q9" } })]));
  await tap.run(AT);
  assert.deepEqual([tap.one()!.state, tap.one()!.code, tap.one()!.why], ["not_sent", "refused", "Already answered, so nothing was sent."]);

  // A start whose project is gone.
  const place = setup(t);
  held(place.set([start()]));
  place.fake.placeList = [];
  await place.run(AT);
  assert.deepEqual([place.one("R-r2-1:start")!.state, place.one("R-r2-1:start")!.code], ["not_sent", "place"]);
});

test("its work system refusing it as it goes is final, and an outcome lost as it went is unknown, never resent", async (t) => {
  const failed = setup(t);
  failed.fake.failFor.add("a");
  held(failed.set([send()]));
  await failed.run(AT + 5 * MIN);
  assert.deepEqual([failed.one()!.state, failed.one()!.code, failed.one()!.why], ["not_sent", "refused", "disk is full"]);
  assert.equal(failed.fake.executed.length, 1);

  const lost = setup(t, { retrySafe: false });
  lost.fake.unknownFor.add("a");
  held(lost.set([send()]));
  await lost.run(AT + 5 * MIN);
  assert.deepEqual([lost.one()!.state, lost.one()!.why], ["unknown", "T3 socket closed (1006)"]);
  assert.equal(lost.fake.executed.length, 1, "never sent again");
});

test("a start fires with the profile agreed, and reports its new thread", async (t) => {
  const { fake, set, run, one } = setup(t);
  held(set([start()]));
  await run(AT);
  assert.deepEqual(fake.executed.map((e) => [e.action, e.key]), [[{ kind: "start_work", placeId: "p-proj", title: "Update the dependencies", message: "Update the dependencies", profile }, "R-r2-1:start"]]);
  assert.deepEqual([one("R-r2-1:start")!.state, one("R-r2-1:start")!.receipt], ["sent", { ok: true, itemId: "new-1" }]);
});

test("the policy's rules, actions and ceiling: refused when it's set, and again when it fires if they changed since", async (t) => {
  const refusals = (policy: Record<string, unknown>, s: object) => held(setup(t, { policy }).set([s]))[0];
  assert.deepEqual(refusals({ rules: "off" }, send()), { id: "R-r1-1:a", state: "refused", code: "policy", why: "This computer isn't set to send messages for later." });
  assert.deepEqual(refusals({}, start()), { id: "R-r2-1:start", state: "waiting", at: iso(AT) }, "start turned on here");
  assert.deepEqual(refusals({ rules: "send" }, start()), { id: "R-r2-1:start", state: "refused", code: "policy", why: "This computer isn't set to start threads for later." });
  assert.deepEqual(refusals({ rules: undefined }, start()), { id: "R-r2-1:start", state: "refused", code: "policy", why: "This computer isn't set to start threads for later." }, "send, on every install that hasn't chosen");
  assert.deepEqual(refusals({ actions: ["settle"] }, send()), { id: "R-r1-1:a", state: "refused", code: "policy", why: "10 & 2 isn't allowed to send messages on this computer." });
  assert.deepEqual(refusals({ maxRuntimeMode: "auto" }, start()), { id: "R-r2-1:start", state: "refused", code: "ceiling", why: "This computer doesn't allow that much access for a thread started later." });

  // Changed after it was handed over (10and2 agents restarts the connector with the new policy): final at firing.
  for (const [policy, code] of [[{ rules: "send" }, "policy"], [{ rules: "off" }, "policy"], [{ maxRuntimeMode: "auto" }, "ceiling"], [{ actions: ["follow_up"] }, "policy"]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "schedules-"));
    const ledger = new Ledger(dir);
    t.after(async () => { await ledger.close(); removeDir(dir); });
    held(setup(t, { dir, ledger }).set([start()]));
    const later = setup(t, { dir, ledger, policy });
    await later.run(AT);
    assert.equal(later.fake.executed.length, 0, JSON.stringify(policy));
    assert.deepEqual([later.one("R-r2-1:start")!.state, later.one("R-r2-1:start")!.code], ["not_sent", code], JSON.stringify(policy));
  }
  // A ceiling raised since doesn't raise what was agreed: it launches with the profile agreed.
  const dir = mkdtempSync(join(tmpdir(), "schedules-"));
  const ledger = new Ledger(dir);
  t.after(async () => { await ledger.close(); removeDir(dir); });
  const ask = { ...profile, runtimeMode: "approval-required" };
  held(setup(t, { dir, ledger, policy: { maxRuntimeMode: "approval-required" } }).set([start({ action: { kind: "start_work", placeId: "p-proj", message: "Go", profile: ask } })]));
  const raised = setup(t, { dir, ledger });
  await raised.run(AT);
  assert.deepEqual((raised.fake.executed[0]?.action as Extract<Action, { kind: "start_work" }>).profile, ask);
});

test("a set's entries are checked: its end in the past or more than 74 hours and the clock difference allowed on, more than 50 held, unknown fields, a newer version", async (t) => {
  const { set, env } = setup(t);
  const one = (s: object) => held(set([s]))[0];
  assert.deepEqual(one(send({ id: "x1", when: { at: iso(env.now - 2 * MIN) }, until: iso(env.now - 1) })), { id: "x1", state: "refused", code: "time", why: "Its time has passed." });
  assert.deepEqual(one(send({ id: "x2", when: { at: iso(env.now + 70 * HOUR) }, until: iso(env.now + 74 * HOUR + SKEW_MS + 1) })), { id: "x2", state: "refused", code: "time", why: "It's more than 3 days ahead." });
  assert.equal(one(send({ id: "x3", when: { at: iso(env.now + 72 * HOUR) }, until: iso(env.now + 74 * HOUR) })).state, "waiting");
  // At the brain's limit (72 hours and its window), handed to a computer whose clock is 4 minutes behind: still taken.
  assert.equal(one(send({ id: "x3b", when: { at: iso(env.now + 72 * HOUR + 4 * MIN) }, until: iso(env.now + 74 * HOUR + 4 * MIN) })).state, "waiting");
  assert.deepEqual(one(send({ id: "x4", extra: 1 })), { id: "x4", state: "refused", code: "invalid", why: "Unknown schedule fields aren't supported." });
  assert.deepEqual(one(send({ id: "x5", v: 2 })), { id: "x5", state: "refused", code: "version", why: "It needs a newer 10and2 on this computer." });
  assert.deepEqual(one(send({ id: "x6", action: { kind: "settle", itemId: "a" } })), { id: "x6", state: "refused", code: "invalid", why: "Only a message or new work can be set up for later." });
  assert.deepEqual(one(send({ id: "x7", action: { kind: "follow_up", itemId: "a", message: "x", ttl: 1 } })), { id: "x7", state: "refused", code: "invalid", why: "Unknown action fields aren't supported." });
  assert.deepEqual(one(send({ id: "x8", when: { at: iso(AT + 3 * HOUR) } })), { id: "x8", state: "refused", code: "invalid", why: "It's due after its own end." });
  assert.equal(parseSchedule({ ...send(), id: "" }).refusal?.code, "invalid");

  const full = setup(t);
  const many = Array.from({ length: MAX_HELD + 1 }, (_, i) => send({ id: `R-r${i}-1:a` }));
  const answer = held(full.set(many));
  assert.equal(answer.filter((h) => h.state === "waiting").length, MAX_HELD);
  assert.deepEqual(answer[MAX_HELD], { id: `R-r${MAX_HELD}-1:a`, state: "refused", code: "full", why: "This computer holds at most 50 for later." });
});

test("a row written by a newer 10and2 is left as written, reported as needing one, and never fired or cancelled", async (t) => {
  const { s, ledger, fake, set, run } = setup(t);
  // A newer connector's row, otherwise in this one's shape and due: this one must neither fire nor touch it.
  const body = JSON.stringify({ ...send({ id: "R-new-1:a", v: 2 }), newer: "a field this connector doesn't know" });
  ledger.handle.prepare("INSERT INTO schedules (id, v, device, hash, body, state, extra, set_at) VALUES ('R-new-1:a', 2, 'device-1', 'h', ?, 'waiting', '{}', 1)").run(body);
  assert.deepEqual(s.view(), [{ id: "R-new-1:a", state: "refused", code: "version", why: "It needs a newer 10and2 on this computer." }]);
  held(set([]));
  await run(AT + 30 * MIN);
  s.revoke();
  await run(AT + 3 * HOUR);
  assert.equal(fake.executed.length, 0);
  const row = ledger.handle.prepare("SELECT body, state FROM schedules WHERE id = 'R-new-1:a'").get() as { body: string; state: string };
  assert.deepEqual({ ...row }, { body, state: "waiting" }, "byte for byte");
});

test("rows given to another pairing (set up again for another account) are cancelled at start and never reported", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "schedules-"));
  const ledger = new Ledger(dir);
  t.after(async () => { await ledger.close(); removeDir(dir); });
  held(setup(t, { dir, ledger, device: "old" }).set([send()]));
  const now = setup(t, { dir, ledger, device: "new" });
  assert.deepEqual(now.s.view(), []);
  assert.equal((ledger.handle.prepare("SELECT state FROM schedules WHERE id = 'R-r1-1:a'").get() as { state: string }).state, "cancelled");
  await now.run(AT);
  assert.equal(now.fake.executed.length, 0);
  assert.ok("held" in now.set([], 1), "the new pairing's seq starts again");
});

test("revoked: every waiting row is cancelled", async (t) => {
  const { s, set, run, fake, one } = setup(t);
  held(set([send()]));
  s.revoke();
  await run(AT + MIN);
  assert.equal(fake.executed.length, 0);
  assert.equal(one()!.state, "cancelled");
});

test("a restart while firing: a work system that dedupes is sent it again with the same key; any other answers unknown and doesn't", async (t) => {
  for (const retrySafe of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "schedules-"));
    let ledger = new Ledger(dir);
    const first = setup(t, { dir, ledger, retrySafe });
    held(first.set([send()]));
    // The process dies after the claim and the dispatch's record, before any receipt: exactly what its transaction leaves.
    first.fake.execute = () => new Promise(() => {});
    first.env.now = AT;
    void first.s.tick();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(first.one()!.state, "firing");
    const dbRow = ledger.handle.prepare("SELECT state FROM actions WHERE key = 'R-r1-1:a'").get() as { state: string };
    assert.equal(dbRow.state, "dispatching");
    (ledger as any).pending.clear(); ledger.handle.close(); // the process gone
    ledger = new Ledger(dir);
    const after = setup(t, { dir, ledger, retrySafe });
    // Its store closed first: Windows won't remove a folder with a file open in it.
    t.after(async () => { await ledger.close(); removeDir(dir); });
    after.fake.live = false;
    await after.run(AT + MIN);
    if (retrySafe) {
      assert.equal(after.one()!.state, "firing", "it waits for its work system to resend");
      after.fake.live = true;
      await after.run(AT + 2 * MIN);
      assert.deepEqual(after.fake.executed.map((e) => e.key), ["R-r1-1:a"], "the same key again");
      assert.equal(after.one()!.state, "sent");
    } else {
      assert.equal(after.fake.executed.length, 0, "never resent");
      assert.deepEqual([after.one()!.state, after.one()!.why], ["unknown", "The connector lost the outcome. It won't resend this action because this work system cannot safely retry it."]);
    }
  }
});

test("after: when a thread on this computer finishes cleanly, the message goes; failed, stopped or asking, it doesn't", async (t) => {
  const chain = (over: Record<string, unknown> = {}) => send({ id: "R-c1-1:a", when: { after: { itemId: "s", lastRunAt: iso(T0 - HOUR) } }, until: iso(T0 + 4 * HOUR), ...over });
  const schema = (over: Partial<WorkItem> = {}) => item("s", { status: "running", lastRunAt: iso(T0 - HOUR), ...over });

  const clean = setup(t, { items: [item("a"), schema()] });
  held(clean.set([chain()]));
  await clean.run(T0 + 20 * MIN);
  // A run past the baseline that's still going (it went on to another): not finished yet.
  clean.fake.items[1] = schema({ status: "running", lastRunAt: iso(T0 + 19 * MIN) });
  await clean.run(T0 + 30 * MIN);
  assert.deepEqual([clean.one("R-c1-1:a")!.state, clean.one("R-c1-1:a")!.code], ["waiting", "working"]);
  assert.equal(clean.fake.executed.length, 0);
  clean.fake.items[1] = schema({ status: "completed", lastRunAt: iso(T0 + 31 * MIN) });
  clean.fake.reports.set("s", { text: "Done: the migration is in.", question: null });
  await clean.run(T0 + 32 * MIN);
  assert.equal(clean.fake.executed.length, 1);
  assert.deepEqual([clean.one("R-c1-1:a")!.state, clean.one("R-c1-1:a")!.at], ["sent", iso(T0 + 30 * MIN + 15_000)], "at: when its thread was first seen finished");

  for (const [name, over, report, code] of [
    ["failed", { status: "failed" }, null, "failed"],
    ["stopped", { status: "cancelled" }, null, "stopped"],
    ["asking", { status: "waiting", pendingQuestion: true, questionId: "q" }, null, "asked"],
    ["ends asking", { status: "completed" }, { text: "Done. Should I drop the old column?", question: null }, "asked"],
    ["gone", { settled: true }, null, "vanished"],
  ] as [string, Partial<WorkItem>, Report | null, string][]) {
    const x = setup(t, { items: [item("a"), schema()] });
    held(x.set([chain()]));
    await x.run(T0 + 10 * MIN);
    x.fake.items[1] = schema({ lastRunAt: iso(T0 + 11 * MIN), status: "completed", ...over });
    if (report) x.fake.reports.set("s", report);
    await x.run(T0 + 12 * MIN);
    assert.equal(x.fake.executed.length, 0, name);
    assert.deepEqual([x.one("R-c1-1:a")!.state, x.one("R-c1-1:a")!.code], ["not_sent", code], name);
  }

  // Still working at the rule's end: missed, said so.
  const slow = setup(t, { items: [item("a"), schema()] });
  held(slow.set([chain()]));
  await slow.run(T0 + 4 * HOUR + MIN);
  assert.deepEqual([slow.one("R-c1-1:a")!.state, slow.one("R-c1-1:a")!.code], ["missed", "working"]);

  // Finished, and not before its notBefore.
  const later = setup(t, { items: [item("a"), schema()] });
  held(later.set([chain({ when: { after: { itemId: "s", lastRunAt: iso(T0 - HOUR) }, notBefore: iso(T0 + HOUR) } })]));
  later.fake.items[1] = schema({ status: "completed", lastRunAt: iso(T0 + 5 * MIN) });
  await later.run(T0 + HOUR - 15_000);
  assert.deepEqual([later.fake.executed.length, later.one("R-c1-1:a")!.state, later.one("R-c1-1:a")!.at], [0, "waiting", iso(T0 + 15_000)], "seen finished, waiting for 02:00");
  await later.run(T0 + HOUR);
  assert.equal(later.fake.executed.length, 1);

  // API busy when Schema finishes: held, then sent once it's free; not before its notBefore.
  const busy = setup(t, { items: [item("a", { status: "running", lastRunAt: iso(T0 - 2 * HOUR) }), schema()] });
  held(busy.set([chain({ guard: { agreedAt: iso(T0 - MIN), running: true, lastRunAt: iso(T0 - 2 * HOUR), questionId: null }, when: { after: { itemId: "s", lastRunAt: iso(T0 - HOUR) }, notBefore: iso(T0 + HOUR) } })]));
  busy.fake.items[1] = schema({ status: "completed", lastRunAt: iso(T0 + 5 * MIN) });
  await busy.run(T0 + 30 * MIN);
  assert.equal(busy.fake.executed.length, 0, "not before 02:00");
  await busy.run(T0 + 70 * MIN);
  assert.deepEqual([busy.one("R-c1-1:a")!.state, busy.one("R-c1-1:a")!.code], ["waiting", "busy"]);
  busy.fake.items[0] = item("a", { status: "completed", lastRunAt: iso(T0 + 71 * MIN) });
  await busy.run(T0 + 72 * MIN);
  assert.equal(busy.fake.executed.length, 1);
  assert.equal(busy.one("R-c1-1:a")!.state, "sent");
  assert.deepEqual(busy.one("R-c1-1:a")!.after, { lastRunAt: iso(T0 + 71 * MIN), questionId: null }, "the baseline for the step after it");
});

test("started, the runner looks by itself at each one's time, and again at a work system's change", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "schedules-"));
  const ledger = new Ledger(dir);
  const fake = new FakeAdapter([item("a")]);
  const policy = parsePolicy(JSON.stringify({ brain: "ws://127.0.0.1:1/connector", projects: "*", actions: ["follow_up"] }));
  const s = new Schedules({ ledger, local: new Local([{ prefix: "", adapter: fake }], policy), policy, device: "d", gate: () => true });
  t.after(async () => { s.stop(); await ledger.close(); removeDir(dir); });
  s.start();
  const soon = (ms: number, id: string) => ({ ...send({ id, when: { at: iso(Date.now() + ms) }, until: iso(Date.now() + HOUR) }), guard: { agreedAt: iso(Date.now()), running: false, lastRunAt: null, questionId: null } });
  held(s.set(1, [soon(300, "R-t-1:a")], Date.now()));
  const deadline = Date.now() + 3000;
  while (!fake.executed.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fake.executed.map((e) => e.key), ["R-t-1:a"], "at its time, with no look asked for");
  fake.live = false; // its work system stops; the next one is held for it
  held(s.set(2, [soon(0, "R-t-2:a")], Date.now()));
  const held2 = Date.now() + 3000;
  while (s.view().find((h) => h.id === "R-t-2:a")?.code !== "app" && Date.now() < held2) await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.view().find((h) => h.id === "R-t-2:a")?.code, "app");
  fake.live = true;
  fake.emit(["a"]); // a work system's change: looked at now, not at the next 15-second look
  const back = Date.now() + 3000;
  while (fake.executed.length < 2 && Date.now() < back) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fake.executed.length, 2);
});

test("the runner's summary for status.json, and what the view reports as it changes", async (t) => {
  const { s, set, run, changes, env } = setup(t);
  held(set([send(), send({ id: "R-c1-1:a", when: { after: { itemId: "a", lastRunAt: null } }, said: "Sending “x” to Thread a when Thread a finishes" })]));
  assert.deepEqual(s.summary(), [{ at: iso(AT), said: "Send “carry on” to Thread a at 03:00" }, { at: null, said: "Sending “x” to Thread a when Thread a finishes" }]);
  const before = changes.length;
  await run(AT - MIN);
  assert.equal(changes.length, before + 1, "the chain's 'still working' once, not at every look");
  env.now = AT; await s.tick();
  assert.deepEqual(s.summary().map((x) => x.at), [null]);
});

test("Claude Code's inbox says a scheduled message was set up earlier and confirmed then", () => {
  const scheduled = { agreedAt: "2026-11-19T21:14:00Z", at: "2026-11-20T02:00:00Z", zone: "Europe/Copenhagen" };
  assert.equal(setUp(scheduled), "(Your user set this up with 10 & 2 yesterday at 22:14, to be sent at 03:00, and confirmed it then.)");
  assert.equal(setUp({ ...scheduled, agreedAt: "2026-11-20T00:30:00Z" }), "(Your user set this up with 10 & 2 at 01:30, to be sent at 03:00, and confirmed it then.)");
  assert.equal(setUp({ ...scheduled, agreedAt: "2026-11-17T09:00:00Z" }), "(Your user set this up with 10 & 2 on Tuesday at 10:00, to be sent at 03:00, and confirmed it then.)");
  assert.equal(setUp({ agreedAt: "2026-11-20T00:30:00Z", zone: "Europe/Copenhagen" }).endsWith("to be sent when another thread finished, and confirmed it then.)"), true);
  assert.equal(envelope("carry on", "prompting", scheduled), `<cross-session-message from-name="10 & 2" from-mode="prompting">\ncarry on\n\n(Your user set this up with 10 & 2 yesterday at 22:14, to be sent at 03:00, and confirmed it then.)\n</cross-session-message>`);
  assert.match(envelope("carry on", "prompting"), /and confirmed it\.\)/, "a send now is as it was");
});

test("a reply ending in a question isn't a clean finish", () => {
  assert.equal(endsAsking("Done.\n\nShould I drop the old column?"), true);
  assert.equal(endsAsking("Should I? I did it anyway.\n\nAll done."), false);
  assert.equal(endsAsking("Push it?**"), true);
});

