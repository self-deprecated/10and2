import { test } from "node:test";
import assert from "node:assert/strict";
import { Sent, type View } from "../src/view.ts";
import { item } from "./fakes.ts";
import { createHash } from "node:crypto";

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

test("places go with their models packed: each list once, in `catalogs`, under a key that changes only with it", async () => {
  const { pack } = await import("../src/view.ts");
  const claude = [{ id: "opus", name: "Claude Opus 5.5" }, { id: "sonnet", name: "Claude Sonnet 5.5" }];
  const places = [
    { id: "claude:a", name: "a", activeAt: null, models: claude },
    { id: "claude:b", name: "b", activeAt: null, folder: "x/b", models: [...claude] },
    { id: "pi:c", name: "c", activeAt: null, models: [] },
    { id: "d", name: "d", activeAt: null },
  ];
  const wire = pack(places);
  const key = createHash("sha256").update(JSON.stringify(claude)).digest("hex").slice(0, 12);
  assert.deepEqual(wire, {
    places: [{ id: "claude:a", name: "a", activeAt: null, catalog: key }, { id: "claude:b", name: "b", activeAt: null, folder: "x/b", catalog: key },
      { id: "pi:c", name: "c", activeAt: null }, { id: "d", name: "d", activeAt: null }],
    catalogs: { [key]: claude },
  });
  assert.notEqual(pack([{ ...places[0]!, models: claude.slice(1) }]).places[0]!.catalog, key, "another list, another key");
  // T3's models carry their provider, as given, and a list that differs only in a provider (renamed in T3) is another.
  const t3 = (provider: string) => pack([{ id: "p", name: "p", activeAt: null, models: [{ id: "claude-proxy:opus", name: "Claude Opus 5.5", provider }] }]);
  assert.deepEqual(Object.values(t3("Claude Proxy").catalogs), [[{ id: "claude-proxy:opus", name: "Claude Opus 5.5", provider: "Claude Proxy" }]]);
  assert.notEqual(t3("Work Proxy").places[0]!.catalog, t3("Claude Proxy").places[0]!.catalog);
  assert.deepEqual(pack([]), { places: [], catalogs: {} });

  // As the link reads it: no models on a place, the catalogs beside them, and a change in any list is a change.
  const sent = new Sent();
  const read = sent.read(view(undefined, { places }), null);
  assert.deepEqual([read.places, read.catalogs], [wire.places, wire.catalogs]);
  assert.equal(sent.changed(view(undefined, { places })).any, false);
  assert.equal(sent.changed(view(undefined, { places: [places[0]!, { ...places[1]!, models: claude.slice(0, 1) }, places[2]!, places[3]!] })).any, true);
  assert.deepEqual(new Sent().read(view(), null).catalogs, {}, "always there, empty when nothing offers a model");
});
