import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { gitBash, hooksUnavailable, installHooks, uninstallHooks, hooksStatus, relayHook, ascii } from "../src/claude/hooks.ts";
import { hookSocket } from "../src/paths.ts";
import { proof, randomHex } from "../src/util.ts";
import { harness, until, pause } from "./fixtures/claude/helpers.ts";
import { assertPrivate, ipcPath, WINDOWS } from "./fixtures/platform.ts";

/** A test's own socket (a pipe on Windows), closed after the test; a failure to listen fails the test, not the file. */
async function listen(t: TestContext, server: Server, path: string) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  t.after(() => server.close());
}

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
  await uninstallHooks(h.config); assertPrivate(path);
});

test("a settings.json that's a link (stow, home-manager, chezmoi) stays one, and every save keeps one backup, not one more", { skip: WINDOWS && "symlinks need privileges on Windows" }, async (t) => {
  const h = harness(t), path = join(h.config, "settings.json");
  const dotfiles = join(h.root, "dotfiles"); mkdirSync(dotfiles, { recursive: true });
  const target = join(dotfiles, "claude-settings.json");
  writeFileSync(target, JSON.stringify({ theme: "dark" }));
  symlinkSync(target, path);
  await installHooks(h.config, "driver-connector");
  assert.equal(lstatSync(path).isSymbolicLink(), true, "still a link");
  assert.equal(JSON.parse(readFileSync(target, "utf8")).theme, "dark");
  assert.equal((await hooksStatus(h.config)).installed, true, "written through the link, to its target");
  await uninstallHooks(h.config); await installHooks(h.config, "other-connector"); await uninstallHooks(h.config);
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(h.config).filter((n) => n.includes("driver")), ["settings.json.driver-backup"], "one backup, however many saves");
  assert.deepEqual(readdirSync(dotfiles), ["claude-settings.json"], "nothing left beside the target");
  assert.ok(JSON.parse(readFileSync(join(h.config, "settings.json.driver-backup"), "utf8")).hooks, "the backup is what was there before the last save");
  assertPrivate(target);
});

test("a settings.json linked into a read-only store (Home Manager /nix/store) falls back cleanly on install and uninstall", { skip: (WINDOWS || process.getuid?.() === 0) && "needs POSIX non-root chmod" }, async (t) => {
  const { chmodSync } = await import("node:fs");
  const h = harness(t), path = join(h.config, "settings.json");
  const roDir = join(h.root, "nix-store"); mkdirSync(roDir, { recursive: true });
  const target = join(roDir, "settings.json");
  writeFileSync(target, JSON.stringify({ theme: "dark" }));
  chmodSync(target, 0o444);
  chmodSync(roDir, 0o555);
  try {
    symlinkSync(target, path);
    await installHooks(h.config, "driver-connector");
    assert.equal(lstatSync(path).isSymbolicLink(), false, "replaced the immutable symlink in place");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).theme, "dark");
    assert.equal((await hooksStatus(h.config)).installed, true);
    assert.equal(JSON.parse(readFileSync(join(h.config, "settings.json.driver-backup"), "utf8")).theme, "dark");
    await uninstallHooks(h.config);
    assert.equal((await hooksStatus(h.config)).installed, false);
  } finally {
    chmodSync(roDir, 0o755);
    chmodSync(target, 0o644);
  }
});

test("malformed settings are preserved, and missing settings can be installed", async (t) => {
  const h = harness(t), path = join(h.config, "settings.json");
  await installHooks(h.config, "'/path with spaces/driver'"); assert.equal((await hooksStatus(h.config)).events.length, 5);
  writeFileSync(path, "{broken"); await assert.rejects(installHooks(h.config, "driver")); assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("relay sends only session/event/notification metadata, socket has mode 0600, hook payload is never state", async (t) => {
  const h = harness(t), f = h.completed(); await h.adapter.start();
  // A pipe has no mode: on Windows its name, and the secret the adapter proves itself with, are kept for `10and2 hook`
  // in the state folder.
  if (WINDOWS) assert.deepEqual(readFileSync(join(h.options.stateDir, "hooks.pipe"), "utf8").split("\n"), [h.adapter.socketPath, h.adapter.hookSecret, ""]);
  else { assertPrivate(h.adapter.socketPath); assert.equal(existsSync(join(h.options.stateDir, "hooks.pipe")), false); }
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "Notification", notification_type: "permission_prompt", message: "PRIVATE_INPUT", last_assistant_message: "FORGED_REPLY" }), h.adapter.socketPath);
  await pause(50); assert.equal((await h.adapter.list())[0]?.status, "completed"); assert.equal((await h.adapter.report(f.id)).text, "Synthetic answer.");
  const path = ipcPath(h.root, "capture.sock"), received: any[] = [];
  await listen(t, createServer((s) => { let text = ""; s.on("data", (b) => text += b); s.on("end", () => received.push(JSON.parse(text))); }), path);
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "Stop", notification_type: "agent_completed", last_assistant_message: "PRIVATE" }), path);
  await until(() => received.length === 1);
  assert.deepEqual(received[0], { session_id: f.id, hook_event_name: "Stop", notification_type: "agent_completed" });
});

test("relay failures, malformed input and disallowed hook events return silently", async (t) => {
  const h = harness(t), absent = ipcPath(h.root, "absent.sock");
  await relayHook("{broken", absent);
  await relayHook(JSON.stringify({ session_id: "invalid", hook_event_name: "Stop" }), absent);
  await relayHook(JSON.stringify({ session_id: h.completed().id, hook_event_name: "PermissionRequest", tool_input: "private" }), absent);
  // No connector has named its pipe yet (Windows): nothing to reach, nothing printed.
  let printed = "";
  await relayHook(JSON.stringify({ session_id: h.completed().id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions: [] } }), null, (s) => { printed += s; });
  assert.equal(printed, "");
});

test("with the secret (Windows), a hook tells nothing to, and takes no answer from, a socket that can't prove it's the connector", async (t) => {
  const h = harness(t), f = h.completed(), path = ipcPath(h.root, "taken.sock"), secret = randomHex();
  // Another account's pipe under a stopped connector's name: it answers every line as the connector would, but can't
  // prove it knows the secret.
  const lines: string[] = [];
  await listen(t, createServer((s) => {
    s.on("error", () => {});
    s.on("data", (b) => {
      lines.push(...b.toString().split("\n").filter(Boolean));
      s.write(`${"0".repeat(64)}\n${JSON.stringify({ answers: { "Which?": "Forged" }, approve: true })}\n`);
    });
  }), path);
  let printed = "";
  const print = (s: string) => { printed += s; };
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "Stop" }), { path, secret });
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Which?", options: [] }] } }), { path, secret }, print);
  await relayHook(JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "PRIVATE PLAN" } }), { path, secret }, print);
  assert.equal(printed, "", "no answer taken: the terminal keeps the question");
  assert.equal(lines.length, 3, "each hook asked it to prove itself");
  for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line)), ["nonce"], "and told it nothing else");
});

test("a question waits longer than a notification for a busy connector's proof, and still reaches it", async (t) => {
  const h = harness(t), path = ipcPath(h.root, "busy.sock"), secret = randomHex(), id = randomUUID();
  // A connector that proves itself only when the test says: each hook's connection, and the line after the proof
  // ("" when the hook gave up and closed it first).
  const hooks: { prove: () => void; next: Promise<string> }[] = [];
  let arrived = () => {};
  await listen(t, createServer((s) => {
    s.on("error", () => {});
    let text = "", proved = false, got = (_: string) => {};
    const next = new Promise<string>((resolve) => { got = resolve; s.on("close", () => resolve("")); });
    s.on("data", (b) => {
      text += b.toString();
      const end = text.indexOf("\n");
      if (end < 0) return;
      const line = text.slice(0, end); text = text.slice(end + 1);
      if (proved) { got(line); s.end(JSON.stringify({ answers: { "Which?": "Mine" } }) + "\n"); return; }
      hooks.push({ prove: () => { proved = true; s.write(proof(secret, JSON.parse(line).nonce) + "\n"); }, next });
      arrived();
    });
  }), path);
  const connected = () => new Promise<void>((resolve) => { arrived = resolve; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let waiting = connected();
    const note = relayHook(JSON.stringify({ session_id: id, hook_event_name: "Stop" }), { path, secret });
    await waiting;
    t.mock.timers.tick(5000);
    await note;
    assert.equal(await hooks[0]!.next, "", "a notification gives up after 5 s");
    waiting = connected();
    let printed = "";
    const ask = relayHook(JSON.stringify({ session_id: id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which?", options: [] }] } }), { path, secret }, (s) => { printed += s; });
    await waiting;
    t.mock.timers.tick(30_000);
    hooks[1]!.prove();
    const question = await hooks[1]!.next;
    assert.notEqual(question, "", "a question still waits after 30 s");
    assert.equal(JSON.parse(question).tool, "AskUserQuestion");
    await ask;
    assert.equal(JSON.parse(printed).hookSpecificOutput.decision.updatedInput.answers["Which?"], "Mine");
  } finally { t.mock.timers.reset(); }
});

test("with the adapter's secret, as hooks.pipe gives it on Windows, a hook reaches the adapter and takes its answer; with another, nothing", async (t) => {
  const h = harness(t), f = h.completed(undefined, h.cwd, "auto");
  const questions = [{ question: "Should lap times show seconds or milliseconds?", header: "Lap format", multiSelect: false,
    options: [{ label: "Seconds", description: "12.3 s" }, { label: "Milliseconds", description: "12345 ms" }] }];
  f.append({ type: "user", uuid: "prompt-2", promptId: "turn-2", permissionMode: "auto", message: { content: "Ask me about the format." } });
  h.registry(f.id, "waiting", { messagingSocketPath: ipcPath(h.root, "unused.sock") });
  await h.adapter.start();
  const event = JSON.stringify({ session_id: f.id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } });
  let printed = "";
  await relayHook(event, { path: h.adapter.socketPath, secret: randomHex() }, (s) => { printed += s; });
  assert.equal(printed, "");
  assert.equal((h.adapter as any).asks.size, 0, "the adapter was never told what's asked");
  const hook = relayHook(event, { path: h.adapter.socketPath, secret: h.adapter.hookSecret }, (s) => { printed += s; });
  await until(async () => (h.adapter as any).asks.has(f.id));
  assert.deepEqual(await h.adapter.execute({ kind: "follow_up", itemId: f.id, message: "Milliseconds, please." }, "answer"), { ok: true });
  await hook;
  assert.equal(JSON.parse(printed).hookSpecificOutput.decision.updatedInput.answers["Should lap times show seconds or milliseconds?"], "Milliseconds");
});

test("on Windows the hooks are added only where Claude Code has Git Bash to run them, and are the same as elsewhere", async (t) => {
  const h = harness(t), path = join(h.config, "settings.json");
  const none = { PATH: join(h.root, "empty") };
  assert.match(hooksUnavailable(h.config, none, "win32") ?? "", /Install Git for Windows/);
  await assert.rejects(installHooks(h.config, "10and2", false, undefined, undefined, "win32", none), /Git Bash/);
  assert.equal((await hooksStatus(h.config)).installed, false, "nothing is written");
  // Git for Windows: git.exe in cmd\, bash.exe in bin\.
  const git = join(h.root, "Git");
  mkdirSync(join(git, "cmd"), { recursive: true }); mkdirSync(join(git, "bin"), { recursive: true });
  writeFileSync(join(git, "cmd", "git.exe"), ""); writeFileSync(join(git, "bin", "bash.exe"), "");
  const withGit = { PATH: join(git, "cmd") };
  assert.equal(gitBash(withGit, "win32"), join(git, "bin", "bash.exe"));
  assert.equal(gitBash({ PATH: "", CLAUDE_CODE_GIT_BASH_PATH: join(git, "bin", "bash.exe") }, "win32"), join(git, "bin", "bash.exe"));
  await installHooks(h.config, "10and2", false, undefined, undefined, "win32", withGit);
  const windows = readFileSync(path, "utf8");
  await uninstallHooks(h.config);
  await installHooks(h.config, "10and2", false, undefined, undefined, "linux", none);
  assert.equal(readFileSync(path, "utf8"), windows, "the same hooks as on macOS and Linux");
  assert.equal(hooksUnavailable(h.config, none, "linux"), null);
});

test("on Windows the gate's entry names no socket: the pipe is new at each start, found with its secret in hooks.pipe", async (t) => {
  const h = harness(t), bash = join(h.root, "Git", "bin", "bash.exe");
  mkdirSync(join(h.root, "Git", "bin"), { recursive: true }); writeFileSync(bash, "");
  await installHooks(h.config, "10and2", true, "C:\\Users\\a\\connector.json", undefined, "win32", { PATH: "", CLAUDE_CODE_GIT_BASH_PATH: bash });
  const entry = JSON.parse(readFileSync(join(h.config, "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
  assert.match(entry, /^10and2 hook --policy 'C:\\Users\\a\\connector\.json' --settings '/);
  assert.doesNotMatch(entry, /--socket/);
});

test("on Windows Git Bash is looked for only where Claude Code looks for it", (t) => {
  const h = harness(t);
  const install = (root: string) => {
    mkdirSync(join(root, "Git", "cmd"), { recursive: true }); mkdirSync(join(root, "Git", "bin"), { recursive: true });
    writeFileSync(join(root, "Git", "cmd", "git.exe"), ""); writeFileSync(join(root, "Git", "bin", "bash.exe"), "");
    return join(root, "Git", "bin", "bash.exe");
  };
  const programs = install(join(h.root, "Program Files")), x86 = install(join(h.root, "Program Files (x86)"));
  const user = install(join(h.root, "AppData", "Local", "Programs"));
  const empty = { PATH: "" };
  assert.equal(gitBash({ ...empty, ProgramFiles: join(h.root, "Program Files") }, "win32"), programs);
  assert.equal(gitBash({ ...empty, "ProgramFiles(x86)": join(h.root, "Program Files (x86)") }, "win32"), x86);
  // A per-user Git for Windows that isn't on PATH: Claude Code doesn't find it, and would run the hooks in PowerShell.
  assert.equal(gitBash({ ...empty, LOCALAPPDATA: join(h.root, "AppData", "Local") }, "win32"), null);
  assert.equal(gitBash({ PATH: join(h.root, "AppData", "Local", "Programs", "Git", "cmd") }, "win32"), user, "on PATH it is found");
  // CLAUDE_CODE_GIT_BASH_PATH only when it names a bash or sh that's there.
  const sh = join(h.root, "tools", "SH.EXE");
  mkdirSync(join(h.root, "tools")); writeFileSync(sh, "");
  assert.equal(gitBash({ ...empty, CLAUDE_CODE_GIT_BASH_PATH: sh }, "win32"), sh);
  assert.equal(gitBash({ ...empty, CLAUDE_CODE_GIT_BASH_PATH: join(h.root, "Program Files", "Git", "cmd", "git.exe") }, "win32"), null, "not a shell");
  assert.equal(gitBash({ ...empty, CLAUDE_CODE_GIT_BASH_PATH: join(h.root, "tools", "bash.exe") }, "win32"), null, "not there");
});

test("on Windows CLAUDE_CODE_GIT_BASH_PATH in Claude Code's settings.json env counts, over its own environment, as Claude Code reads it", async (t) => {
  const h = harness(t), path = join(h.config, "settings.json"), empty = { PATH: "" };
  const bash = join(h.root, "Git", "bin", "bash.exe"), other = join(h.root, "Other", "bash.exe");
  mkdirSync(join(h.root, "Git", "bin"), { recursive: true }); writeFileSync(bash, "");
  mkdirSync(join(h.root, "Other")); writeFileSync(other, "");
  writeFileSync(path, "﻿" + JSON.stringify({ env: { CLAUDE_CODE_GIT_BASH_PATH: bash } }));
  assert.equal(hooksUnavailable(h.config, empty, "win32"), null);
  await installHooks(h.config, "10and2", false, undefined, undefined, "win32", empty);
  assert.equal((await hooksStatus(h.config)).installed, true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).env, { CLAUDE_CODE_GIT_BASH_PATH: bash }, "the user's env is kept");
  // One there that isn't a shell sends Claude Code on to look for Git for Windows, not to its environment's.
  await uninstallHooks(h.config);
  writeFileSync(path, JSON.stringify({ env: { CLAUDE_CODE_GIT_BASH_PATH: join(h.root, "Git", "cmd", "git.exe") } }));
  assert.match(hooksUnavailable(h.config, { ...empty, CLAUDE_CODE_GIT_BASH_PATH: other }, "win32") ?? "", /Git Bash/);
  assert.equal(hooksUnavailable(h.config, { ...empty, CLAUDE_CODE_GIT_BASH_PATH: other, ProgramFiles: h.root }, "win32"), null);
  writeFileSync(path, JSON.stringify({ theme: "dark" }));
  assert.equal(hooksUnavailable(h.config, { ...empty, CLAUDE_CODE_GIT_BASH_PATH: other }, "win32"), null, "none there: its environment's");
});

test("settings saved with a byte-order mark (Windows PowerShell's UTF-8) are read, and the user's own kept", async (t) => {
  const h = harness(t), path = join(h.config, "settings.json");
  writeFileSync(path, "\uFEFF" + JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
  assert.equal((await hooksStatus(h.config)).installed, false);
  await installHooks(h.config, "10and2");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.theme, "dark"); assert.equal(saved.hooks.Stop[0].hooks[0].command, "mine");
  assert.equal((await hooksStatus(h.config)).installed, true);
});

test("the decision printed for Claude is ASCII, and reads back as the user's own words", async (t) => {
  const h = harness(t), path = ipcPath(h.root, "answer.sock"), words = "Blåbærgrød, “please” 🦆";
  await listen(t, createServer((s) => s.once("data", () => s.end(JSON.stringify({ answers: { "Hvad hedder den?": words } }) + "\n"))), path);
  let printed = "";
  await relayHook(JSON.stringify({ session_id: h.completed().id, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "Hvad hedder den?", options: [] }] } }), path, (s) => { printed += s; });
  assert.match(printed, /^[\x00-\x7f]+$/);
  assert.equal(JSON.parse(printed).hookSpecificOutput.decision.updatedInput.answers["Hvad hedder den?"], words);
  assert.equal(ascii(JSON.stringify("\u007f é")), '"\\u007f \\u00e9"');
});

test("10and2 hook finds the adapter's socket: a file elsewhere, on Windows the pipe and secret in hooks.pipe (none until named)", async (t) => {
  const h = harness(t), env = { XDG_STATE_HOME: h.root };
  assert.deepEqual(hookSocket(env, "linux"), { path: join(h.root, "10and2", "claude", "hooks.sock"), secret: null });
  assert.deepEqual(hookSocket({ ...env, XDG_RUNTIME_DIR: join(h.root, "run") }, "linux"), { path: join(h.root, "run", "10and2", "hooks.sock"), secret: null });
  assert.equal(hookSocket(env, "win32"), null);
  mkdirSync(join(h.root, "10and2", "claude"), { recursive: true });
  const named = join(h.root, "10and2", "claude", "hooks.pipe"), secret = randomHex();
  writeFileSync(named, "\\\\.\\pipe\\10and2-hooks-0123abcd\r\n");
  assert.equal(hookSocket(env, "win32"), null, "a name with no secret to check it by isn't used");
  writeFileSync(named, `\\\\.\\pipe\\10and2-hooks-0123abcd\r\n${secret}\r\n`);
  assert.deepEqual(hookSocket(env, "win32"), { path: "\\\\.\\pipe\\10and2-hooks-0123abcd", secret });
  writeFileSync(named, `${join(h.root, "not-a-pipe")}\n${secret}\n`);
  assert.equal(hookSocket(env, "win32"), null, "only a pipe's name is taken");
});

test("on Windows a stopped adapter takes its pipe's name away, but not a newer connector's", { skip: !WINDOWS && "Windows only: the adapter names a pipe there" }, async (t) => {
  const h = harness(t), named = join(h.options.stateDir, "hooks.pipe");
  await h.adapter.start(); assert.equal(readFileSync(named, "utf8").split("\n")[0], h.adapter.socketPath);
  await h.adapter.close(); assert.equal(existsSync(named), false);
  const next = h.reopen(); await next.start();
  writeFileSync(named, "\\\\.\\pipe\\10and2-hooks-newer\n"); await next.close();
  assert.equal(readFileSync(named, "utf8").trim(), "\\\\.\\pipe\\10and2-hooks-newer");
});
