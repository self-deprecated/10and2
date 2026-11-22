// What the tests need to run alike on Linux, macOS and Windows, and under `node --test` and `bun test`: where a test's
// local socket goes, how a private file is checked, how long to wait, and how a fake command is run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { which } from "../../src/command.ts";

export const WINDOWS = process.platform === "win32";
const BUN = process.versions.bun !== undefined;

/**
 * The Node that runs what a test starts (the connector, its runners, a fake command): this one, or under `bun test`
 * the `node` on PATH. The connector ships for Node, so what it starts runs on Node whichever runner runs the tests.
 */
export const NODE = BUN ? nodeOnPath() : process.execPath;
function nodeOnPath() {
  const node = which("node");
  // Without a Node, `bun run` puts a `node` of its own on PATH: Bun again.
  if (!node || realpathSync(node) === realpathSync(process.execPath)) throw new Error("bun test starts the connector and its fakes on Node: put Node 22.13 or newer on PATH");
  return node;
}

/**
 * The Pi and ACP adapters' `nodeBin`, the Node their detached runners start on: under `node --test` none, so their
 * default (this Node) is what's tested; under `bun test` NODE, since their default there would be Bun.
 */
export const nodeBin = BUN ? NODE : undefined;

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

/** A fake command, as the adapters take one: run by Node (NODE), since Windows can't start a script by itself. */
export const nodeCommand = (script: string) => [NODE, script];
