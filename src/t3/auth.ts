// The connector runs on the T3 host, so it mints its own narrowly scoped session with T3's CLI
// instead of a pairing flow. The token lives only in memory; the session is revoked on shutdown
// and expires on its own if the connector dies.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type T3Session = { token: string; sessionId: string; expiresAt: string };

/** Read the thread list and run thread commands; nothing else (no provider, file or terminal access). */
export const CONNECTOR_SCOPES = ["orchestration:read", "orchestration:operate"] as const;

/** The locally installed T3 CLI, with optional leading arguments. */
export type Cli = readonly string[];

export async function issueSession(opts: { cli: Cli; label: string; ttl: string; scopes: readonly string[] }): Promise<T3Session> {
  const args = ["auth", "session", "issue", "--json", "--ttl", opts.ttl, "--label", opts.label];
  for (const s of opts.scopes) args.push("--scope", s);
  const { stdout } = await run(opts.cli[0], [...opts.cli.slice(1), ...args], { timeout: 30_000 });
  const j = JSON.parse(stdout) as { token?: string; sessionId?: string; expiresAt?: string };
  if (!j.token || !j.sessionId) throw new Error("t3 auth session issue returned no token");
  return { token: j.token, sessionId: j.sessionId, expiresAt: j.expiresAt ?? "" };
}

export async function revokeSession(cli: Cli, sessionId: string): Promise<void> {
  await run(cli[0], [...cli.slice(1), "auth", "session", "revoke", sessionId], { timeout: 30_000 });
}
