import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/claude/store.ts";

for (const kind of ["settle", "snooze", "archive"] as const) test(`${kind} overlay and receipt commit or roll back together`, () => {
  const store = new Store(":memory:");
  try {
    store.db.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF receipt ON claude_operations
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;`);
    assert.throws(() => store.completeOverlay("key", "hash", "session", kind, "now", "later"), /injected/);
    assert.equal(store.operation("key"), undefined);
    assert.deepEqual(store.overlay("session"), { settledAt: null, snoozedAt: null, snoozedUntil: null, archived: 0 });
    store.db.exec("DROP TRIGGER fail_receipt");
    assert.deepEqual(store.completeOverlay("key", "hash", "session", kind, "now", "later"), { ok: true });
    assert.equal(store.operation("key")?.receipt, '{"ok":true}');
    const committed = store.overlay("session");
    assert.equal(kind === "settle" ? committed.settledAt : kind === "snooze" ? committed.snoozedUntil : committed.archived, kind === "settle" ? "now" : kind === "snooze" ? "later" : 1);
    assert.equal(store.completeOverlay("key", "hash", "session", kind, "changed", "changed"), null);
    assert.deepEqual(store.overlay("session"), committed);
  } finally { store.close(); }
});

test("unsettle and unsnooze clear what settle and snooze kept", () => {
  const store = new Store(":memory:");
  try {
    store.completeOverlay("k1", "h1", "session", "settle", "now");
    store.completeOverlay("k2", "h2", "session", "unsettle", "then");
    assert.deepEqual({ ...store.overlay("session") }, { sessionId: "session", settledAt: null, snoozedAt: null, snoozedUntil: null, archived: 0 });
    store.completeOverlay("k3", "h3", "session", "snooze", "now", "later");
    store.completeOverlay("k4", "h4", "session", "unsnooze", "then");
    assert.deepEqual({ ...store.overlay("session") }, { sessionId: "session", settledAt: null, snoozedAt: null, snoozedUntil: null, archived: 0 });
  } finally { store.close(); }
});
