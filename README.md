# 10and2

The connector for [10 & 2](https://10and2.app), the iPhone app that lets you talk to your coding agents on the drive.

Install it on the Mac, Windows or Linux computer where your coding agents work: Claude Code, Codex, Copilot CLI, Gemini CLI, Cursor, OpenCode, Pi or T3 Code. Then the voice in the app can tell you what they did and what's waiting on you, and follow up when you say yes.

```sh
npm install -g 10and2
10and2 setup
```

Setup finds the coding agents on this computer and lets you switch off any you don't want 10 & 2 to reach, and choose what 10 & 2 may do: follow up, steer a session that's open, answer an agent's questions, start new work, and settle, snooze or archive. Each applies to every agent, and you can narrow it for one. Then setup opens your browser so you can approve this computer while signed in to your 10 & 2 account. It stays connected from then on. The connector dials out and nothing dials in, so your code stays on your computer.

```sh
10and2 status    # whether it's connected, and what 10 & 2 can see and do
10and2 agents    # choose again which agents to connect, and what 10 & 2 may do
10and2 revoke    # disconnect this computer
10and2 uninstall # remove everything 10and2 added: its service, hooks, extensions, settings and key
10and2 help      # everything else
```

New work in T3 Code, Claude Code, Codex, Gemini CLI, Copilot CLI and Cursor can start on a coding model you name (in T3 Code, on the provider you name too), or the one you choose in the app's Settings → New threads → Coding model; otherwise, and in Pi and OpenCode, on the agent's own default.

On a Mac, if your projects are in Documents, Desktop, Downloads or iCloud Drive, macOS asks whether “node” may open them once 10and2 runs at login: choose Allow, or turn it on later in System Settings, Privacy & Security, Files & Folders. `10and2 status` says when it's still off.

Needs Node 22.13 or newer. Setup and `10and2 status` say when one of your agents is too old for something 10 & 2 does, and how to update it.

Without a terminal (a script, Nix), every agent found is connected with everything allowed, and flags narrow it: `--agents=claude,pi` (only these), `--off=codex`, `--no-steer`, `--no-answer`, `--no-start`, `--no-tidy`, `--read-only`. Given names, as in `--no-steer=codex`, a flag narrows only those agents.

## Installing

- **Node:** `node --version` should say 22.13 or newer. The Node Ubuntu and Debian ship is older. Install a current Node for yourself with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 24`), fnm, Volta or Homebrew; none of them needs sudo.
- **`npm install -g` fails with EACCES:** your npm installs into a folder only root can write, usually because Node came from the system. Don't use sudo: everything 10and2 does afterwards would need it too. Use a Node from nvm (above), or point npm at a folder of your own: `npm config set prefix ~/.local`, with `~/.local/bin` on your PATH.
- **PowerShell:** Windows' default script policy blocks the `10and2.ps1` npm installs, so PowerShell says running scripts is disabled. Type `10and2.cmd` instead, or allow your own scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Command Prompt and Git Bash aren't affected.
- **pnpm, Volta, fnm:** `pnpm add -g 10and2` and `volta install 10and2` work too, and the login service keeps working through their upgrades. With npx it can run, but not start at login.
- **Behind a company proxy:** set `HTTPS_PROXY` (and `NO_PROXY`) before setup; the login service is given them. Node 24.14 or newer uses them by itself; Node 22.21 to 24.13 only with `NODE_USE_ENV_PROXY=1` set as well, which setup says. A proxy address with a password in it isn't written into the login service.
- **TLS inspection:** 10and2 trusts the certificates your computer trusts (the Keychain, Windows' certificate store, or Linux's bundle in `/etc/ssl/certs`) besides Node's own, with Node 22.19 or newer. On an older Node, point `NODE_EXTRA_CA_CERTS` at your company's root certificate.
- **Where your agents keep their files:** setup reads `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `T3CODE_HOME` and the `XDG_*` folders from your terminal, and the login service is given the same, so run setup (or `10and2 autostart on`, after changing them) from a terminal that has them.

## Starting at login

On a Mac it's a LaunchAgent; on Windows, an entry in the apps it starts at sign-in (Task Manager's Startup apps), with its log in `%USERPROFILE%\.local\state\10and2\10and2.log`; on Linux, a systemd user service. Logged in over SSH (a server, a VM), setup turns on systemd's lingering for your account so it keeps running after you log out and starts at boot; where that needs an administrator, it says to run `sudo loginctl enable-linger $USER`. `10and2 autostart off` turns it off again.

Without systemd (a container, WSL without systemd, Alpine), nothing starts it for you: keep `10and2 run` going some other way, for example in a tmux session, as your init system's service, or with a crontab line such as `@reboot 10and2 run --wait-for-credential >> ~/.local/state/10and2/10and2.log 2>&1` (give cron your PATH, so it finds `node` and your agents).

## Claude Code

10 & 2 works with the Claude Code sessions you run yourself, including ones open in a terminal: what you tell it reaches the session between its steps, or as its next turn, and shows there as `Message from @10-2`. Work 10 & 2 starts for you runs as a background session: `claude agents` lists it and `claude attach` opens it. When a session asks you a question or wants to go ahead with a plan, 10 & 2 reads it out and can answer it for you, while the terminal can still answer it too. That part needs 10and2's Claude Code hooks, which setup offers to add (`10and2 hooks install` adds them later, `10and2 hooks uninstall` removes them). Needs Claude Code 2.1.280 or newer; 2.1.314 or newer to answer its questions, and 2.1.310 or newer for new work in a worktree. Before 2.1.321, which has background sessions, work 10 & 2 starts runs without a terminal to attach to.

## Codex

10 & 2 works with your Codex sessions through the Codex app-server that a Codex terminal uses: what you tell it reaches a session that's running between its steps, or starts its next turn, and it can answer Codex's questions, but never approves a command for it. A closed session is continued within what this computer allows, and new work starts in the project or a fresh worktree inside it. Nothing to install. Needs Codex 0.156.0 or newer to see your sessions and start work, and 0.157.0 or newer for the rest.

## Pi

10 & 2 works with your Pi sessions too. What you tell it reaches a session open in Pi as if you'd typed it there, between its steps when it's busy. A closed session, or new work, runs in Pi in the background. Reaching open sessions needs 10and2's Pi extension, which setup offers to add (`10and2 pi install` adds it later, `10and2 pi uninstall` removes it). Pi runs its tools without asking, so 10 & 2 only continues a closed session, or starts new work, when this computer allows full access. Needs Pi 0.80.5 or newer.

## OpenCode

10 & 2 works with your OpenCode sessions: what you tell it reaches a session open in OpenCode, and waits there if it's busy; it can answer OpenCode's questions, but never grants it a permission. A closed session, or new work, runs in an OpenCode server of 10 & 2's own on this computer, within what this computer allows. Reaching open sessions needs 10and2's OpenCode plugin, which setup offers to add (`10and2 opencode install` adds it later, `10and2 opencode uninstall` removes it). The first OpenCode you start after adding it needs the internet once, to fetch what plugins use. Needs OpenCode 1.14.34 or newer, and 1.14.49 or newer to reach a session open in OpenCode.

## Gemini CLI and Copilot CLI

10 & 2 works with your Gemini CLI and GitHub Copilot CLI sessions: it reads them, and continues one you've closed, or starts new work in the project or a fresh worktree inside it, through the agent's own ACP mode (`gemini --acp`, `copilot --acp`), within what this computer allows. It never grants either a permission: a tool that asks first doesn't run, so give new work full access for it to edit and run things.

What you tell it reaches a Copilot session open in a terminal as if you'd typed it there, during its turn when it's busy, and it can answer Copilot's questions. That needs 10and2's Copilot extension, which setup offers to add (`10and2 copilot install` adds it later, `10and2 copilot uninstall` removes it); Copilot loads extensions only with its experimental features on, so adding it turns them on, and only in folders you trust in Copilot. A Copilot already open needs restarting. A Gemini session open in a terminal, or a Copilot one in an editor, isn't sent to yet: say it there, or close it and 10 & 2 can continue it. Gemini CLI refuses full access in a folder you haven't trusted in it. Needs Gemini CLI 0.68.0 or newer, or Copilot CLI 1.0.112 or newer.

## Cursor

10 & 2 works with Cursor's CLI agent (`cursor-agent`): it reads your chats, continues one that's closed within what this computer allows, and starts new work in the project or a worktree inside it. A chat open in a terminal can't be sent to yet: say it there. Nothing to install. The editor's agent isn't reachable yet. Needs cursor-agent 2026.11.19 or newer.

## Your own brain

10 & 2's brain (what keeps track of your threads and talks with you) normally runs in your 10 & 2 account. You can run it on your own computer instead, with your own AI API key. Your computer then keeps track of your threads and holds your conversations, not 10 & 2's servers. It's for people comfortable running a small server. It needs no account, and nothing is billed through 10 & 2.

```sh
10and2 brain setup
```

It asks for your AI API key (the kind the app's Settings → Your own AI key takes) and keeps it in a file only you can read. It connects this computer to the brain and offers to start both at login. Then it prints an access code for your phone.

Your phone talks to the brain over HTTPS. With [Tailscale](https://tailscale.com), run `tailscale serve --bg 8790` once on that computer. In the app, open Settings → Advanced → Self-hosted brain, or tap "I run my own brain" when you sign in. Enter `https://<this computer>.<your tailnet>.ts.net` and the access code. Any other HTTPS reverse proxy to `127.0.0.1:8790` works too.

To connect another computer to it, run this on that computer:

```sh
10and2 setup --brain=https://<brain computer>.<your tailnet>.ts.net --token
```

Then run the `10and2 brain add …` line it prints on the brain's computer.

```sh
10and2 brain status    # whether it's running, and which computers it accepts
10and2 brain status --code    # the phone's address and access code again
```

[10and2.app](https://10and2.app) · [Privacy](https://10and2.app/privacy/) · [Terms](https://10and2.app/terms/)
