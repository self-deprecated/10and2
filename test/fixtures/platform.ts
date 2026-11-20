// What the tests need to run alike on Linux, macOS and Windows: where a test's local socket goes, how a private file
// is checked, how long to wait, and how a fake command is run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const WINDOWS = process.platform === "win32";

/** A local socket for a test: a file in `dir`, or on Windows (where Node's local sockets are named pipes) a fresh pipe. */
export const ipcPath = (dir: string, name: string) => WINDOWS ? `\\\\.\\pipe\\10and2-test-${randomUUID()}-${name}` : join(dir, name);

/**
 * That a file (or folder) only its owner can read: mode 0600 (0700). Windows has no such modes (Node reports 0666 for
 * every writable file); there the profile's own permissions keep it private, so there's nothing to check.
 */
export function assertPrivate(path: string, mode = 0o600) {
  if (WINDOWS) return;
  assert.equal(statSync(path).mode & 0o777, mode, `${path} should be mode ${mode.toString(8)}`);
}

/** How much longer to wait for a process to start: Windows starts them several times slower, and scans each. */
export const SLOW = WINDOWS ? 3 : 1;

/** Removes a test's folder, retrying while a process that just ended still holds a file in it (Windows). */
export const removeDir = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** A fake command, as the adapters take one: run by this Node, since Windows can't start a script by itself. */
export const nodeCommand = (script: string) => [process.execPath, script];
