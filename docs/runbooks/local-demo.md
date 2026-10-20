# Keeping the demo running on your own machine

The goal is a bookmark. You open `http://localhost:3000`, the system is there,
and nothing in between involves remembering a command or noticing that you are
looking at last week's build.

```bash
pnpm host start      # build it and run it in the background
pnpm host status     # is it up, on what commit, is there anything newer
pnpm host update     # pull, reinstall, rebuild, restart
pnpm host stop
pnpm host logs       # follow it when something looks wrong
```

`pnpm host start` runs the same stack `pnpm preview` runs — PostgreSQL, the
migrations, the demo data, the web app, the background worker — with two
differences: it detaches, so closing the terminal leaves it running, and it
builds for production rather than serving in development mode, so pages come
back in milliseconds instead of compiling on first visit.

The first start takes a few minutes for that build. Starts after it are quick.
If you would rather not wait, `pnpm host start --dev` skips the build and starts
in seconds, at the cost of a slow first visit to each page.

## The two commands you will actually use

**`pnpm host update`** is the whole of "put the latest work in front of me". It
stops the running copy, pulls, installs, throws away the build cache if the code
changed, rebuilds, and starts again. It refuses to pull over local changes
rather than destroying them, and it says which commits arrived.

**`pnpm host status`** answers the question that has cost the most time so far:
*am I looking at the current build?* It prints the commit being served and
whether origin has anything newer.

```
● Running on http://localhost:3000
  commit   76ff22f  Show a replaced logo in the portal straight away
  updates  3 newer commit(s) on origin — pnpm host update
  log      .local/host.log
```

Everything it keeps — the log, the pid, the port — is in `.local/`, which git
ignores.

## Signing in

| Account | What it is |
| --- | --- |
| `admin@demo.invalid` | the landlord console; asks for a code |
| `finance@demo.invalid` | the finance role; asks for a code |
| `thandiwe@demo.invalid` | the resident portal; no code |

The password for every demo account is `DemoPassword123!`.

When it asks for a six-digit code:

```bash
pnpm db:mfa code admin@demo.invalid
```

A code works **once**. Signing in twice as the same account inside the same
30-second window will see the second code refused — that is the replay
protection, not a fault. Eight wrong passwords or codes for one address inside
15 minutes locks that address for the rest of the window.

## Starting it when you log in

Optional, and it makes the bookmark true even after a restart. On macOS, write
this to `~/Library/LaunchAgents/com.spike.propertyos.plist`, replacing the path
with your checkout and `YOURNAME` with your account:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.spike.propertyos</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd /Users/YOURNAME/PropertyOS && ./scripts/host.sh start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/propertyos-login.log</string>
  <key>StandardErrorPath</key><string>/tmp/propertyos-login.log</string>
</dict>
</plist>
```

Then `launchctl load ~/Library/LaunchAgents/com.spike.propertyos.plist`, and
`launchctl unload` the same path to undo it.

Two honest caveats. This has not been run — the development container these
scripts were written in is Linux, with no `launchctl` to test it against, so
treat it as a starting point rather than something verified. And it needs
PostgreSQL to be running at login, which is what `brew services start
postgresql@16` arranges; the host script starts a stopped local cluster when it
can, but a cluster Homebrew has not been told to run at login is a race.

## When something is wrong

| What you see | What it is |
| --- | --- |
| `pnpm host start` says it is already running | It is. `pnpm host status` for which commit, `pnpm host update` to move it on |
| A page 404s that you know exists | A build cache written by a server killed mid-compile. `pnpm host update` clears it; `rm -rf apps/web/.next` is the same thing by hand |
| Sign-in rejects a code you just read | It was already used, or the 30 seconds expired. Ask for another |
| An admin signs in and the console is nearly empty | Correct, and the point: elevated permissions are withheld without a second factor |
| The log ends at a database error | The local cluster is not running. `brew services start postgresql@16`, then `pnpm host start` |
| Something answers on port 3000 and will not stop | `lsof -ti tcp:3000` names it. A copy started before this script existed is not in its pid file |
| `pnpm host update` refuses to pull | You have local changes in the checkout. `git stash` keeps them, `git checkout .` drops them |

## What this is not

It is one machine's demo, with synthetic data, reachable only from that machine.
No email is delivered: messages are queued, attempted, and recorded as
undelivered with the reason, which is what the product does without an email
provider configured, and every screen says so. Uploads are quarantined because
no scanner is configured. `docs/runbooks/staging.md` is the plan for a URL you
can open from a phone, and `docs/deployment.md` is the production checklist;
this is neither.
