// Starting the connector at login, as the user (never root): a LaunchAgent on macOS, a systemd user unit on Linux.
// A revoked or replaced connector exits so that neither restarts it, and a crash is restarted.
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { run, type Runner } from "./credential.ts";

export const LABEL = "com.selfdeprecated.10and2";
/** What the service runs: this Node, this script, and the PATH setup saw, so `t3` and `claude` are found. */
export type Launch = { node: string; script: string; path: string };
/** A job at login: the connector, or a brain of your own (`10and2 brain`). */
export type Job = { label: string; unit: string; logName: string; description: string; args: string[]; launchdArgs: string[] };
export const CONNECTOR: Job = {
  label: LABEL, unit: "10and2.service", logName: "10and2.log",
  description: "10and2 connector: lets your 10 & 2 brain read and act on this machine's coding sessions",
  // Started at boot (lingering) or with the session, it can come before the login keyring opens: wait for the credential.
  args: ["run", "--wait-for-credential"],
  // launchd can't skip one exit status, so a stop that mustn't be restarted exits 0 there.
  launchdArgs: ["run", "--fatal-exit=0"],
};
export const BRAIN: Job = {
  label: `${LABEL}.brain`, unit: "10and2-brain.service", logName: "10and2-brain.log",
  description: "10and2 brain: your own 10 & 2 brain, for your phone and your computers' connectors",
  args: ["brain", "run"], launchdArgs: ["brain", "run"],
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const systemdQuote = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function systemdUnit(l: Launch, job = CONNECTOR): string {
  return `[Unit]
Description=${job.description}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${[l.node, l.script, ...job.args].map(systemdQuote).join(" ")}
Environment=${systemdQuote(`PATH=${l.path}`)}
Restart=on-failure
RestartSec=5
# 78: revoked, replaced by another copy, or a brain this version can't talk to. Restarting wouldn't help.
RestartPreventExitStatus=78
# Only the connector itself stops with the service: Claude Code runs it started (a background session, Claude's
# supervisor) carry on through a restart or an update.
KillMode=process
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function launchAgent(l: Launch, logs: string, job = CONNECTOR): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${job.label}</string>
  <key>ProgramArguments</key>
  <array>
${[l.node, l.script, ...job.launchdArgs].map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(l.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>AbandonProcessGroup</key><true/>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(logs)}</string>
  <key>StandardErrorPath</key><string>${xml(logs)}</string>
</dict>
</plist>
`;
}

export type ServiceState = { installed: boolean; running: boolean; where: string; logs: string };

export class Service {
  private readonly runner: Runner;
  private platform: NodeJS.Platform;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly job: Job;
  constructor(opts: { runner?: Runner; platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; job?: Job } = {}) {
    this.runner = opts.runner ?? run;
    this.job = opts.job ?? CONNECTOR;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.platform = opts.platform ?? process.platform;
    this.home = opts.home ?? homedir();
    this.env = opts.env ?? process.env;
    // Tests (and machines whose login services are managed some other way, such as Nix) never touch the service manager.
    if (this.env.TENANDTWO_NO_SERVICE === "1") this.platform = "none" as NodeJS.Platform;
  }
  get supported() { return this.platform === "darwin" || this.platform === "linux"; }
  private get plist() { return join(this.home, "Library", "LaunchAgents", `${this.job.label}.plist`); }
  private get logs() { return join(this.home, "Library", "Logs", this.job.logName); }
  private get unit() { return join(this.env.XDG_CONFIG_HOME || join(this.home, ".config"), "systemd", "user", this.job.unit); }
  private get domain() { return `gui/${userInfo().uid}`; }
  private get target() { return `${this.domain}/${this.job.label}`; }

  /** Polls until `done`, every 250 ms for up to `ms`; whether it got there. */
  private async until(done: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
    for (let waited = 0; ; waited += 250) {
      if (await done()) return true;
      if (waited >= ms) return false;
      await this.sleep(250);
    }
  }
  /** launchd unloads asynchronously: `bootout` returns before the job is gone, and a `bootstrap` then fails. */
  private async bootout() {
    await this.runner("launchctl", ["bootout", this.target]);
    await this.until(async () => await this.runner("launchctl", ["print", this.target]) === null);
  }

  /** Writes the service and starts it now. Throws with what went wrong. */
  async install(l: Launch): Promise<ServiceState> {
    if (this.platform === "darwin") {
      mkdirSync(join(this.home, "Library", "LaunchAgents"), { recursive: true });
      mkdirSync(join(this.home, "Library", "Logs"), { recursive: true });
      await this.bootout();
      writeFileSync(this.plist, launchAgent(l, this.logs, this.job), { mode: 0o644 });
      const loaded = await this.until(async () => await this.runner("launchctl", ["bootstrap", this.domain, this.plist]) !== null, 5000);
      if (!loaded) throw new Error("launchctl couldn't load the LaunchAgent");
    } else if (this.platform === "linux") {
      mkdirSync(join(this.unit, ".."), { recursive: true });
      writeFileSync(this.unit, systemdUnit(l, this.job), { mode: 0o644 });
      if (await this.runner("systemctl", ["--user", "daemon-reload"]) === null) throw new Error("systemctl --user isn't available (no systemd user session?)");
      if (await this.runner("systemctl", ["--user", "enable", "--now", this.job.unit]) === null) throw new Error(`systemctl --user couldn't start ${this.job.unit}`);
      await this.runner("systemctl", ["--user", "restart", this.job.unit]);
    } else throw new Error(`Starting at login isn't supported on ${this.platform}.`);
    // Both start the job asynchronously: give it a moment to be running before saying whether it is.
    let state = await this.state();
    await this.until(async () => (state = await this.state()).running);
    return state;
  }

  async uninstall(): Promise<void> {
    if (this.platform === "darwin") {
      await this.bootout();
      rmSync(this.plist, { force: true });
    } else if (this.platform === "linux") {
      await this.runner("systemctl", ["--user", "disable", "--now", this.job.unit]);
      rmSync(this.unit, { force: true });
      await this.runner("systemctl", ["--user", "daemon-reload"]);
    }
  }

  async state(): Promise<ServiceState> {
    if (this.platform === "darwin") {
      const out = existsSync(this.plist) ? await this.runner("launchctl", ["print", `${this.domain}/${this.job.label}`]) : null;
      return { installed: existsSync(this.plist), running: /\bstate = running\b/.test(out ?? ""), where: this.plist, logs: this.logs };
    }
    if (this.platform === "linux") {
      const out = existsSync(this.unit) ? await this.runner("systemctl", ["--user", "is-active", this.job.unit]) : null;
      return { installed: existsSync(this.unit), running: out?.trim() === "active", where: this.unit, logs: `journalctl --user -u ${this.job.unit}` };
    }
    return { installed: false, running: false, where: "", logs: "" };
  }

  async restart(): Promise<void> {
    if (this.platform === "darwin") await this.runner("launchctl", ["kickstart", "-k", `${this.domain}/${this.job.label}`]);
    if (this.platform === "linux") await this.runner("systemctl", ["--user", "restart", this.job.unit]);
  }
}
