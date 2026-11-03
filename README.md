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

[10and2.app](https://10and2.app) · [Privacy](https://10and2.app/privacy/) · [Terms](https://10and2.app/terms/)
