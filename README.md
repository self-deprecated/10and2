# 10and2

The connector for [10 & 2](https://10and2.app), the iPhone app that lets you talk to your coding agents on the drive.

Install it on the Mac or Linux computer where your T3 Code or Claude Code agents work. Then Driver, the voice in the app, can tell you what they did and what's waiting on you, and follow up when you say yes.

```sh
npm install -g 10and2
10and2 setup
```

Setup opens your browser so you can approve this computer while signed in to your 10 & 2 account. It stays connected from then on. The connector dials out and nothing dials in, so your code stays on your computer.

```sh
10and2 status    # whether it's connected, and what Driver can see and do
10and2 revoke    # disconnect this computer
10and2 help      # everything else
```

Needs Node 22.13 or newer.

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
