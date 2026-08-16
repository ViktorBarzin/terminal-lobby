# tl-t3-bridge + tl-t3-sync — deploy & per-user enablement

Two binaries make a tmux session and a T3 Code thread the same conversation.
**tl-t3-bridge** is what T3 spawns in place of `claude`: it speaks the Agent
SDK's stdio protocol upward and attaches to a tmux session downward, so no
second Claude starts. **tl-t3-sync** is a per-user daemon that keeps the thread
list in step with the session list. Design and the 14 decisions:
`docs/plans/2026-08-15-t3-code-bridge-design.md`; the wire and the module
boundaries: `t3-bridge/CONTRACT.md`.

**Status:** not yet enabled for any user. What follows is the procedure for the
first enablement and for the two ways out — the escape hatch and a full
rollback.

Nothing here is enabled by installing it. The bridge only runs if a user's own
T3 names it in `providerInstances`, and the syncer only runs if an operator
wrote that user's env file and enabled their unit. A box with both binaries
installed and no user enabled behaves exactly as it did before.

## Release path

`./scripts/deploy-services.sh` cross-builds and installs both, alongside
session-events and file-api. Presence-claim the devvm before any install.

```bash
./scripts/deploy-services.sh                  # cross-build + install everything
SKIP_BUILD=1 ./scripts/deploy-services.sh     # reuse ./out/ binaries
SKIP_T3=1 ./scripts/deploy-services.sh        # the two services only, no bridge
```

| Source | Destination | Mode |
|---|---|---|
| `t3-bridge/` (built) | `/usr/local/bin/tl-t3-bridge` | 0755 |
| `t3-sync/` (built) | `/usr/local/bin/tl-t3-sync` | 0755 |
| `devvm/tl-t3-sync@.service` | `/etc/systemd/system/tl-t3-sync@.service` | 0644 |
| `devvm/tl-t3-sync.env.example` | `/etc/tl-t3-sync/tl-t3-sync.env.example` | 0644 |

The script installs, reloads systemd, and restarts the `tl-t3-sync@` instances
that are **already** enabled — only when a file actually changed. It never
enables a user, because enabling one needs a hand-written env file carrying that
user's port allocation. Replacing the bridge mid-flight is safe: `install(1)`
unlinks before it writes, so a bridge T3 is running right now keeps the inode it
started from until it exits, and the next spawn picks up the new build.

## Enabling a user

Six steps, in this order. Steps 1–3 are reversible with `rm`; step 4 is the
first one that changes what T3 does.

**1. Allocate a notify port.** One per user, from the 7695–7699 block (7684–7687
and 7690–7691 are taken on the devvm). Confirm it is free:

```bash
ss -ltn | grep -E ':769[5-9]\b' || echo "block is free"
```

**2. Write `/etc/tl-t3-sync/<user>.env`,** from
`/etc/tl-t3-sync/tl-t3-sync.env.example`. Every key is required — systemd
expands an unset variable to an empty argument, so a missing key fails the unit
at start rather than falling back to a default nobody chose. `T3_PORT` is that
user's own t3-serve port, the same value as in `/etc/t3-serve/<user>.env`.
Install it `0644 root:root`: it carries no secret, and tmux-api (running as
`wizard`) reads `TL_T3_SYNC_NOTIFY_PORT` out of it to deliver the kill-notify.

```bash
sudo install -m 0644 -o root -g root /tmp/wizard.env /etc/tl-t3-sync/wizard.env
```

**3. Dry-run the first pass.** Set `TL_T3_SYNC_ARGS=-dry-run` in the env file
first. Against a user who already has threads — wizard has ~386 — the first
reconcile is the one worth reading before it runs:

```bash
sudo systemctl start tl-t3-sync@wizard
journalctl -u tl-t3-sync@wizard -n 100 --no-pager
```

Expect one adoption per live-Claude session that is not on the ignore list, and
no kills. When the plan reads right, clear `TL_T3_SYNC_ARGS` and continue.

**4. Enable the unit.**

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tl-t3-sync@wizard
systemctl status tl-t3-sync@wizard
```

The syncer merges the two provider instances into that user's `settings.json` on
its first tick (see the next section), so there is no separate registration
step. T3 watches the file and invalidates its provider cache, so it needs no
restart.

**5. Verify** — the next section.

**6. Use it.** Open T3; the user's sessions appear as threads. A new thread lands
on the bridge instance by default and gets a real tmux session, visible in the
lobby on its next poll.

## Verifying the provider instance registered

The settings file is `<base-dir>/userdata/settings.json` — T3 derives it as
`join(baseDir, "userdata")` for a served instance (a `--dev-url` instance uses
`dev/` instead). For a devvm user that is `/home/<user>/.t3/userdata/settings.json`.
Read it as that user:

```bash
jq '.providerInstances | {claudeAgent, claudeStock}' /home/wizard/.t3/userdata/settings.json
```

Both instances should be present, both on driver `claudeAgent`:

```json
{
  "claudeAgent": { "driver": "claudeAgent", "config": { "binaryPath": "/usr/local/bin/tl-t3-bridge" } },
  "claudeStock": { "driver": "claudeAgent", "displayName": "Claude (stock)",
                   "config": { "binaryPath": "/home/wizard/.local/bin/claude" } }
}
```

`claudeAgent` is the one that must carry the bridge: T3's
`defaultInstanceIdForDriver(driver)` returns the instance whose id equals the
driver name, so that is where a new thread lands without anyone choosing
anything.

Three more checks, cheapest first:

```bash
# 1. The provider health probe — T3 runs exactly this and parses the output.
#    The bridge hands --version to the real claude, so a version string means
#    the delegation path works for THIS user (claude resolves per-user).
/usr/local/bin/tl-t3-bridge --version        # → 2.1.233 (Claude Code)

# 2. The syncer's own view. It logs a settings-verify failure rather than
#    quietly re-merging over an operator's edit.
journalctl -u tl-t3-sync@wizard --since -10m --no-pager | grep -i settings

# 3. A live turn. Send a message in a bridged thread and look for the process
#    T3 spawned; the tmux pane should show the same prompt arriving.
pgrep -af tl-t3-bridge
```

In T3's own UI, the thread's provider picker shows two Claude entries: the
default one and "Claude (stock)".

## The escape hatch: moving a user to stock Claude

A T3 nightly can change the protocol under the bridge. The bridge implements a
subset of a spec we do not own, so the design keeps a stock instance configured
at all times (decision 5) and this is how to reach for it. Nothing about the
sessions themselves changes: the tmux sessions and their transcripts are
untouched by any of the steps below, and the conversations survive.

**Fastest, one thread:** in T3, switch that thread's provider instance to
**Claude (stock)**. It stops going through the bridge on the next turn and runs
its own `claude` instead. Good for confirming the bridge is the problem.

**A whole user.** The syncer re-merges `settings.json` on every tick, so a hand
edit to `claudeAgent.config.binaryPath` is reverted within one interval unless
the syncer stops first. Stop it, then repoint:

```bash
sudo systemctl stop tl-t3-sync@wizard          # or: add -merge-settings=false to TL_T3_SYNC_ARGS
jq '.providerInstances.claudeAgent.config.binaryPath = "/home/wizard/.local/bin/claude"' \
   /home/wizard/.t3/userdata/settings.json > /tmp/s.json && mv /tmp/s.json /home/wizard/.t3/userdata/settings.json
```

Run those two as the user, not as root: the file is theirs, and a root-owned
`settings.json` is its own outage. T3 picks the change up on its watcher; no
restart. New threads now start a normal `claude` in T3's own process, with no
tmux session behind them, and the lobby stops seeing new T3-born sessions.

**Coming back:** clear `TL_T3_SYNC_ARGS`, `sudo systemctl start
tl-t3-sync@wizard`. Its next tick re-merges the bridge path. Threads that were
switched per-thread in the UI stay on stock until switched back — that is
per-thread state T3 owns.

## Rolling the whole thing back

In this order, so nothing re-writes what a later step removed:

```bash
# 1. Stop the syncers, so nothing re-merges settings or reconciles.
sudo systemctl disable --now tl-t3-sync@wizard          # repeat per enabled user

# 2. Point every user's default Claude instance back at the real binary
#    (as that user), then optionally drop the claudeStock entry too.
jq '.providerInstances.claudeAgent.config.binaryPath = "/home/wizard/.local/bin/claude"
    | del(.providerInstances.claudeStock)' \
   /home/wizard/.t3/userdata/settings.json > /tmp/s.json && mv /tmp/s.json /home/wizard/.t3/userdata/settings.json

# 3. Remove the artefacts.
sudo rm -f /usr/local/bin/tl-t3-bridge /usr/local/bin/tl-t3-sync
sudo rm -f /etc/systemd/system/tl-t3-sync@.service
sudo rm -rf /etc/tl-t3-sync
sudo systemctl daemon-reload

# 4. Drop the per-user binding index (as each user).
rm -rf ~/.local/state/terminal-lobby/t3-bridge
```

What is deliberately left alone: the tmux sessions (never touched by a
rollback), their transcripts under `~/.claude/projects/`, and the threads in
T3 — those hold real conversations, and a rollback that deleted them would be
worse than the problem it fixes. Sessions carry a `@t3_thread` tmux option that
dies with the session; nothing needs cleaning there.

Removing `/etc/tl-t3-sync` also turns the kill-notify off by itself: tmux-api
looks up the port in that directory and makes no request when it is absent.
Deploying tmux-api is not part of a rollback.

## The kill-notify

A lobby kill is the only event that distinguishes deliberate destruction from a
process dying, so tmux-api posts one notice to the user's syncer when
`DELETE /sessions/<name>` succeeds; the syncer archives the mirrored thread
(decision 3). Everything about it is best-effort — it runs off the response
path with a 2 s timeout, and a syncer that is stopped, wedged or absent cannot
slow or fail a kill. Wire and obligations: `t3-bridge/CONTRACT.md` §8.

The producing half lives in tmux-api, which is **shared with the stable tier and
released by `scripts/deploy.sh`** — deliberately not by `deploy-services.sh`,
whose narrow blast radius is the reason it can run unattended. So the first
enablement needs a tmux-api release too, and until that lands a lobby kill
simply does not cross (the thread stays live in T3 and can be archived there).

To check it end to end: kill a session in the lobby and watch the syncer's
journal for the notice, then confirm the thread went to Archived in T3. If
nothing arrives, the three things to check are the port in
`/etc/tl-t3-sync/<user>.env`, whether the syncer is listening on it
(`ss -ltn | grep 7695`), and `journalctl -u tmux-api | grep kill-notify` for the
one line tmux-api logs when a delivery fails.

## Where the state lives

| What | Where | Lifetime |
|---|---|---|
| Provider instances | `~/.t3/userdata/settings.json` (per user) | until edited; the syncer re-merges each tick |
| Thread ↔ session binding | `@t3_thread` tmux option | dies with the tmux session, by design |
| Durable binding (uuid → name, cwd, thread) | `~/.local/state/terminal-lobby/t3-bridge/index.json`, `0600` | survives the session; the syncer prunes it |
| Which sessions to skip | `TL_T3_SYNC_IGNORE` in the env file | operator-set |
| Kill-notify port | `TL_T3_SYNC_NOTIFY_PORT` in the env file, read by both the syncer and tmux-api | operator-set |
