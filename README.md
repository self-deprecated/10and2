# 10and2

The connector for [10 & 2](https://10and2.app), the iPhone app that lets you talk to your coding agents on the drive.

Install it on the Mac or Linux computer where your coding agents work: Claude Code, Codex, Pi, OpenCode or T3 Code. Then Driver, the voice in the app, can tell you what they did and what's waiting on you, and follow up when you say yes.

```sh
npm install -g 10and2
10and2 setup
```

Setup finds the coding agents on this computer and lets you switch off any you don't want Driver to reach, and choose what Driver may do: follow up, steer a session that's open, answer an agent's questions, start new work, and settle, snooze or archive. Each applies to every agent, and you can narrow it for one. Then setup opens your browser so you can approve this computer while signed in to your 10 & 2 account. It stays connected from then on. The connector dials out and nothing dials in, so your code stays on your computer.

```sh
10and2 status    # whether it's connected, and what Driver can see and do
10and2 agents    # choose again which agents to connect, and what Driver may do
10and2 revoke    # disconnect this computer
10and2 help      # everything else
```

Needs Node 22.13 or newer.

Without a terminal (a script, Nix), every agent found is connected with everything allowed, and flags narrow it: `--agents=claude,pi` (only these), `--off=codex`, `--no-steer`, `--no-answer`, `--no-start`, `--no-tidy`, `--read-only`. Given names, as in `--no-steer=codex`, a flag narrows only those agents.

## Claude Code

Driver works with the Claude Code sessions you run yourself, including ones open in a terminal: what you tell it reaches the session between its steps, or as its next turn, and shows there as `Message from @10-2`. Work Driver starts for you runs as a background session: `claude agents` lists it and `claude attach` opens it. When a session asks you a question or wants to go ahead with a plan, Driver reads it out and can answer it for you, while the terminal can still answer it too. That part needs 10and2's Claude Code hooks, which setup offers to add (`10and2 hooks install` adds them later, `10and2 hooks uninstall` removes them). Needs Claude Code 2.1.224 or newer to reach open sessions, and 2.1.321 or newer for background sessions.

## Codex

Driver works with your Codex sessions through the Codex app-server that a Codex terminal uses: what you tell it reaches a session that's running between its steps, or starts its next turn, and it can answer Codex's questions, but never approves a command for it. A closed session is continued within what this computer allows, and new work starts in the project or a fresh worktree inside it. Nothing to install.

## Pi

Driver works with your Pi sessions too. What you tell it reaches a session open in Pi as if you'd typed it there, between its steps when it's busy. A closed session, or new work, runs in Pi in the background. Reaching open sessions needs 10and2's Pi extension, which setup offers to add (`10and2 pi install` adds it later, `10and2 pi uninstall` removes it). Pi runs its tools without asking, so Driver only continues a closed session, or starts new work, when this computer allows full access.

## OpenCode

Driver works with your OpenCode sessions: what you tell it reaches a session open in OpenCode, and waits there if it's busy; it can answer OpenCode's questions, but never grants it a permission. A closed session, or new work, runs in an OpenCode server of Driver's own on this computer, within what this computer allows. Reaching open sessions needs 10and2's OpenCode plugin, which setup offers to add (`10and2 opencode install` adds it later, `10and2 opencode uninstall` removes it). The first OpenCode you start after adding it needs the internet once, to fetch what plugins use.

## Your own brain

Driver's brain (what keeps track of your threads and talks with you) normally runs in your 10 & 2 account. You can run it on your own computer instead, with your own AI API key. Your computer then keeps track of your threads and holds your conversations, not 10 & 2's servers. It's for people comfortable running a small server. It needs no account, and nothing is billed through 10 & 2.

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
