// Starting the connector at login, as the user (never root): a LaunchAgent on macOS, a systemd user unit on Linux.
// A revoked or replaced connector exits so that neither restarts it, and a crash is restarted.
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { run, type Runner } from "./credential.ts";

export const LABEL = "com.selfdeprecated.10and2";
const UNIT = "10and2.service";
/** What the service runs: this Node, this script, and the PATH setup saw, so `t3` and `claude` are found. */
export type Launch = { node: string; script: string; path: string };

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const systemdQuote = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function systemdUnit(l: Launch): string {
  return `[Unit]
Description=10and2 connector: lets your 10 & 2 brain read and act on this machine's coding sessions
After=network-online.target
Wants=network-online.target

[Service]
# Started at boot (lingering) or with the session, it can come before the login keyring opens: wait for the credential.
ExecStart=${systemdQuote(l.node)} ${systemdQuote(l.script)} run --wait-for-credential
Environment=${systemdQuote(`PATH=${l.path}`)}
Restart=on-failure
RestartSec=5
# 78: revoked, replaced by another copy, or a brain this version can't talk to. Restarting wouldn't help.
RestartPreventExitStatus=78
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function launchAgent(l: Launch, logs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(l.node)}</string>
    <string>${xml(l.script)}</string>
    <string>run</string>
    <!-- launchd can't skip one exit status, so a stop that mustn't be restarted exits 0 here. -->
    <string>--fatal-exit=0</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(l.path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
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
  constructor(opts: { runner?: Runner; platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> } = {}) {
    this.runner = opts.runner ?? run;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.platform = opts.platform ?? process.platform;
    this.home = opts.home ?? homedir();
    this.env = opts.env ?? process.env;
    // Tests (and machines whose login services are managed some other way, such as Nix) never touch the service manager.
    if (this.env.TENANDTWO_NO_SERVICE === "1") this.platform = "none" as NodeJS.Platform;
  }
  get supported() { return this.platform === "darwin" || this.platform === "linux"; }
  private get plist() { return join(this.home, "Library", "LaunchAgents", `${LABEL}.plist`); }
  private get logs() { return join(this.home, "Library", "Logs", "10and2.log"); }
  private get unit() { return join(this.env.XDG_CONFIG_HOME || join(this.home, ".config"), "systemd", "user", UNIT); }
  private get domain() { return `gui/${userInfo().uid}`; }
  private get target() { return `${this.domain}/${LABEL}`; }

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
      writeFileSync(this.plist, launchAgent(l, this.logs), { mode: 0o644 });
      const loaded = await this.until(async () => await this.runner("launchctl", ["bootstrap", this.domain, this.plist]) !== null, 5000);
      if (!loaded) throw new Error("launchctl couldn't load the LaunchAgent");
    } else if (this.platform === "linux") {
      mkdirSync(join(this.unit, ".."), { recursive: true });
      writeFileSync(this.unit, systemdUnit(l), { mode: 0o644 });
      if (await this.runner("systemctl", ["--user", "daemon-reload"]) === null) throw new Error("systemctl --user isn't available (no systemd user session?)");
      if (await this.runner("systemctl", ["--user", "enable", "--now", UNIT]) === null) throw new Error(`systemctl --user couldn't start ${UNIT}`);
      await this.runner("systemctl", ["--user", "restart", UNIT]);
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
      await this.runner("systemctl", ["--user", "disable", "--now", UNIT]);
      rmSync(this.unit, { force: true });
      await this.runner("systemctl", ["--user", "daemon-reload"]);
    }
  }

  async state(): Promise<ServiceState> {
    if (this.platform === "darwin") {
      const out = existsSync(this.plist) ? await this.runner("launchctl", ["print", `${this.domain}/${LABEL}`]) : null;
      return { installed: existsSync(this.plist), running: /\bstate = running\b/.test(out ?? ""), where: this.plist, logs: this.logs };
    }
    if (this.platform === "linux") {
      const out = existsSync(this.unit) ? await this.runner("systemctl", ["--user", "is-active", UNIT]) : null;
      return { installed: existsSync(this.unit), running: out?.trim() === "active", where: this.unit, logs: `journalctl --user -u ${UNIT}` };
    }
    return { installed: false, running: false, where: "", logs: "" };
  }

  async restart(): Promise<void> {
    if (this.platform === "darwin") await this.runner("launchctl", ["kickstart", "-k", `${this.domain}/${LABEL}`]);
    if (this.platform === "linux") await this.runner("systemctl", ["--user", "restart", UNIT]);
  }
}
