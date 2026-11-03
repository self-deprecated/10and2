// Where the connector keeps its files: configuration (the policy, which device this is) and state (ledgers, logs).
import { homedir } from "node:os";
import { join } from "node:path";

export const APP = "10and2";
export const configDirectory = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP);
export const stateDirectory = (env: NodeJS.ProcessEnv = process.env) => join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), APP);
/** The private socket Claude Code's hooks write to; the adapter listens there, so both agree without configuration. */
export const hookSocket = (env: NodeJS.ProcessEnv = process.env) => env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, APP, "hooks.sock") : join(stateDirectory(env), "claude", "hooks.sock");
