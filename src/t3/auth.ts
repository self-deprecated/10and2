// The connector runs on the T3 host, so it mints its own narrowly scoped session with T3's CLI
// instead of a pairing flow. The token lives only in memory; the session is revoked on shutdown
// and expires on its own if the connector dies.
import { execFileCommand } from "../command.ts";

export type T3Session = { token: string; sessionId: string; expiresAt: string };

/** Read the thread list and run thread commands; nothing else (no provider, file or terminal access). */
export const CONNECTOR_SCOPES = ["orchestration:read", "orchestration:operate"] as const;

/** The locally installed T3 CLI, with optional leading arguments. */
export type Cli = readonly string[];

// On Windows the desktop app's `t3.cmd` starts T3 Code.exe as Node, which isn't a script command.ts can run without
// cmd.exe, so every word passed here is plain: fixed words, the connector's label, the scopes, a ttl and T3's session
// ids (UUIDs). That start is Electron's, slower cold, so it's given longer there.
const TIMEOUT_MS = process.platform === "win32" ? 60_000 : 30_000;

function t3(cli: Cli, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCommand(cli[0]!, [...cli.slice(1), ...args], { timeout: TIMEOUT_MS }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

export async function issueSession(opts: { cli: Cli; label: string; ttl: string; scopes: readonly string[] }): Promise<T3Session> {
  const args = ["auth", "session", "issue", "--json", "--ttl", opts.ttl, "--label", opts.label];
  for (const s of opts.scopes) args.push("--scope", s);
  const j = JSON.parse(await t3(opts.cli, args)) as { token?: string; sessionId?: string; expiresAt?: string };
  if (!j.token || !j.sessionId) throw new Error("t3 auth session issue returned no token");
  return { token: j.token, sessionId: j.sessionId, expiresAt: j.expiresAt ?? "" };
}

export async function revokeSession(cli: Cli, sessionId: string): Promise<void> {
  await t3(cli, ["auth", "session", "revoke", sessionId]);
}
