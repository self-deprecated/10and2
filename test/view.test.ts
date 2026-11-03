import { test } from "node:test";
import assert from "node:assert/strict";
import { Sent, type View } from "../src/view.ts";
import { item } from "./fakes.ts";

const view = (items = [item("a"), item("b")], over: Partial<View> = {}): View => ({ items, places: [], connections: [{ prefix: "", name: "t3", connected: true }], refusals: {}, ceiling: "auto", ...over });

test("a read is a delta only since the last rev this link was given; anything else is the whole view", () => {
  const sent = new Sent();
  const first = sent.read(view(), null);
  assert.equal(first.full, true);
  assert.deepEqual(first.items.map((i) => i.id), ["a", "b"]);
  const delta = sent.read(view([{ ...item("a"), updatedAt: "2099-01-01T00:00:00Z" }, item("c")]), first.rev);
  assert.equal(delta.full, false);
  assert.deepEqual(delta.items.map((i) => i.id), ["a", "c"]);
  assert.deepEqual(delta.removed, ["b"]);
  // An older rev (the brain missed a read, or restored a stale one) gets the whole view.
  const again = sent.read(view(), first.rev);
  assert.equal(again.full, true);
  assert.deepEqual(again.removed, []);
  // Revs from another connector run never match.
  assert.equal(new Sent().read(view(), again.rev).full, true);
});

test("the brain is told to read when something it diffs on changed, not for updatedAt alone", () => {
  const sent = new Sent();
  assert.deepEqual(sent.changed(view()), { any: true, urgent: false }, "nothing read yet");
  sent.read(view(), null);
  assert.deepEqual(sent.changed(view()), { any: false, urgent: false });
  assert.equal(sent.changed(view([{ ...item("a"), updatedAt: "2099-01-01T00:00:00Z" }, item("b")])).any, false);
  assert.equal(sent.changed(view([{ ...item("a"), status: "running" }, item("b")])).any, true);
  assert.equal(sent.changed(view([item("a")])).any, true, "an item went");
  assert.equal(sent.changed(view(undefined, { refusals: { a: { follow_up: "busy" } } })).any, true);
  assert.equal(sent.changed(view(undefined, { ceiling: "full-access" })).any, true);
  assert.deepEqual(sent.changed(view([{ ...item("a"), pendingQuestion: true, questionId: "q" }, item("b")])), { any: true, urgent: true });
});

test("ids a work system announced are in the next delta even when no listed field changed", () => {
  const sent = new Sent();
  const first = sent.read(view(), null);
  sent.touch(["b"]);
  assert.equal(sent.changed(view()).any, true);
  assert.deepEqual(sent.read(view(), first.rev).items.map((i) => i.id), ["b"]);
});
