import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installHooks, uninstallHooks, hooksStatus, relayHook } from "../src/claude/hooks.ts";
import { harness, until, pause } from "./fixtures/claude/helpers.ts";

test("hooks merge idempotently, back up settings, add PermissionRequest only for AskUserQuestion, remove only their handlers", async (t) => {
  const h = harness(t), path = join(h.config, "settings.json");
  const original = { theme: "dark", permissions: { defaultMode: "auto" }, hooks: {
    Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: "someone-elses-hook" }] }],
    PermissionRequest: [{ hooks: [{ type: "command", command: "existing-permission-hook" }] }],
  } };
  writeFileSync(path, JSON.stringify(original)); await installHooks(h.config, "driver-connector");
  assert.equal((await hooksStatus(h.config)).installed, true);
  const installed = readFileSync(path, "utf8"), backups = readdirSync(h.config).filter((n) => n.includes("driver-backup"));
  assert.equal(backups.length, 1); assert.deepEqual(JSON.parse(readFileSync(join(h.config, backups[0]!), "utf8")), original);
  // The user's own PermissionRequest hook stays first and unchanged; 10 & 2's matches only AskUserQuestion.
  const permission = JSON.parse(installed).hooks.PermissionRequest;
  assert.deepEqual(permission[0], original.hooks.PermissionRequest[0]);
  assert.deepEqual(permission.slice(1).map((e: any) => e.matcher), ["AskUserQuestion|ExitPlanMode"]);
  await installHooks(h.config, "driver-connector"); assert.equal(readFileSync(path, "utf8"), installed);
  assert.equal(readdirSync(h.config).filter((n) => n.includes("driver-backup")).length, 1);
  const s = JSON.parse(installed); s.hooks.Stop[0].hooks.push({ type: "command", command: "cohabiting-hook" }); writeFileSync(path, JSON.stringify(s));
  await uninstallHooks(h.config); const uninstalled = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(uninstalled.hooks.Notification, original.hooks.Notification); assert.deepEqual(uninstalled.hooks.PermissionRequest, original.hooks.PermissionRequest);
  assert.equal(uninstalled.hooks.Stop[0].hooks[0].command, "cohabiting-hook"); assert.equal(uninstalled.theme, "dark");
  assert.equal((await hooksStatus(h.config)).installed, false);
  await uninstallHooks(h.config); assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("malformed settings are preserved, and missing settings can be installed", async (t) => {
  const h = harness(t), path = join(h.config, "settings.json");
  await installHooks(h.config, "'/path with spaces/driver'"); assert.equal((await hooksStatus(h.config)).events.length, 5);
  writeFileSync(path, "{broken"); await assert.rejects(installHooks(h.config, "driver")); assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("relay sends only session/event/notification metadata, socket has mode 0600, hook payload is never state", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  if (process.platform !== "win32") assert.equal(statSync(h.adapter.socketPath).mode & 0o777, 0o600);
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "Notification", notification_type: "permission_prompt", message: "PRIVATE_INPUT", last_assistant_message: "FORGED_REPLY" }), h.adapter.socketPath);
  await pause(50); assert.equal((await h.adapter.list())[0]?.status, "completed"); assert.equal((await h.adapter.report(f.id)).text, "Synthetic answer.");
  const path = join(h.root, "capture.sock"), received: any[] = [];
  const server = createServer((s) => { let text = ""; s.on("data", (b) => text += b); s.on("end", () => received.push(JSON.parse(text))); });
  await new Promise<void>((r) => server.listen(path, r)); t.after(() => server.close());
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "Stop", notification_type: "agent_completed", last_assistant_message: "PRIVATE" }), path);
  await until(() => received.length === 1);
  assert.deepEqual(received[0], { session_id: f.id, hook_event_name: "Stop", notification_type: "agent_completed" });
});

test("relay failures, malformed input and disallowed hook events return silently", async (t) => {
  const h = harness(t);
  await relayHook("{broken", join(h.root, "absent.sock"));
  await relayHook(JSON.stringify({ session_id: "invalid", hook_event_name: "Stop" }), join(h.root, "absent.sock"));
  await relayHook(JSON.stringify({ session_id: h.completed().id, hook_event_name: "PermissionRequest", tool_input: "private" }), join(h.root, "absent.sock"));
});
