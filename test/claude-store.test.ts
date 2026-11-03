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
