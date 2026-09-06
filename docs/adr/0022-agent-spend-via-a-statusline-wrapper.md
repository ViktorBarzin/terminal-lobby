# Agent spend is recorded by a statusLine wrapper, not a hook or a provider API

Settings → **Agent spend** and the figure beside the gear are fed by
`devvm/tl-usage-record`, a small script that takes Claude Code's statusLine
slot. Claude Code pipes a JSON payload to that command on every render, and it
is the only place the CLI hands out its own cost arithmetic
(`cost.total_cost_usd`, plus tokens, the model, and a `rate_limits` object on
seats that have one). The script posts the payload to
`POST /hooks/usage` on session-events (loopback, plus the check that the calling
process belongs to the user it claims), which writes it into
`/var/lib/tmux-api/spend/<user>.json` through `spendstore/`. Then it runs
whatever statusLine the user already had, with the same JSON on stdin, so their
own prompt keeps drawing exactly as before. `tmux-api`'s `GET /agent-spend`
reads that store back for the Claude half and reads Codex's rollout files
directly for the Codex half, which needs nothing installed.

The wiring is the same split ADR-0001 established for the state dot: the script
lives in this repo, and the `/etc/claude-code/managed-settings.json` entry that
points Claude Code at it lives in infra. Managed settings win over a user's own,
which is what leaves `~/.claude/settings.json` still holding THEIR statusLine
for the wrapper to read back and run.

Measured against Claude Code 2.1.263 and Codex CLI 0.153.4 on 2026-09-06.
Design: `docs/plans/2026-09-06-agent-spend-panel-design.md`.

## Considered Options

- **Claude Code hooks**, which is where every other integration here gets its
  facts. No hook payload carries cost. `SessionEnd` delivers `{reason}` and
  `Stop` delivers `last_assistant_message` and no numbers; the only
  money-shaped field anywhere in the hook surface is
  `estimated_cache_write_usd`, a forward-looking cache-rebuild estimate on
  `SessionStart` and the model-switch pair. A hook would have to price tokens
  itself, which is the last option below.
- **Asking the provider for the totals.** `GET /api/oauth/usage` answers `429`
  with `retry-after: 3582`, a one-hour budget per account, and is gated on a
  `user:profile` scope that service tokens lack. The endpoint that does return
  dollars, `/v1/organizations/cost_report`, answers `403` to an OAuth token and
  wants an `sk-ant-admin…` key. OpenAI's `/v1/organization/costs` wants an
  `sk-admin-…` key. Someone installing this app from the public image will have
  neither, so spend has to accumulate locally.
- **Loki.** `cost_usd` per `api_request` is already there, keyed by
  `tmux_session`, which is exactly the session key this app uses. It is homelab
  infrastructure though, so an install anywhere else would ship a panel that
  never fills. Worth revisiting later as an optional backend, where it would add
  the retroactive history the local recorder cannot have.
- **`~/.claude/stats-cache.json`.** The write path is current in 2.1.263, but
  the file is only recomputed when someone opens `/usage`. The copy on this box
  was last computed on 2026-03-08 and its token data was empty, so a panel
  reading it would have shown a six-month-old figure with no way to tell.
- **Pricing the transcript ourselves.** Transcripts carry tokens and the model
  but no cost, so this means maintaining a price table that has to be updated
  whenever a rate changes, with nothing to signal when it has gone stale. The
  statusLine number is Claude Code's own arithmetic and needs no table.

## Consequences

- **The recorder runs on the render path, so it is built to add one fork and
  nothing else.** The entire recording side, tmux lookups included, runs in a
  background subshell with its output discarded, and every failure is a silent
  no-op: session-events down, `jq` missing, no inner command, no tmux. A
  statusline that breaks somebody's prompt would be worse than not having the
  feature. It also drops a render where the running total has not moved, which
  is most of them, by comparing against a pane-scoped tmux option. `jq` is one
  of the things it needs and is not a declared dependency of the package: it is
  present on the devvm, `claude-se-hook` already assumes it, and a box without
  it loses the recording and keeps the prompt.
- **A reading is the conversation's running total, not a delta**, which is what
  makes a dropped POST harmless: a later one carries the same cumulative figure,
  and the last reading of a session carries its final one. The store relies on
  the same property, replacing a session row and moving the day's rollup by the
  difference rather than adding.
- **The wiring lives in infra and the script lives here**, so both sides
  tolerate the other being absent. No managed-settings entry means the recorder
  never runs and the Claude section of the page is simply absent; a missing
  script means Claude Code's statusLine slot points at nothing and the CLI draws
  its own default.
- **Nothing outside tmux is recorded.** The script no-ops when `$TMUX` is unset,
  because headless and T3 Claude instances read the same managed settings and
  have no lobby session to attribute spend to. They still get their statusline.
- **An enterprise seat reports no `rate_limits`**, so its Claude section shows
  spend and no windows, while a Pro or Max seat shows both. Codex reports up to
  two windows on every turn and no cost at all on a ChatGPT plan, which is why
  the page keeps the two tools in separate sections using each tool's own words
  rather than flattening them into one shape.
- **There is no history before the recorder was installed.** The store starts
  empty and All time means "all time we were recording". Loki, above, is the
  option that could backfill a devvm install if that ever matters enough.
- **The container image does not wire this, deliberately.** The image owns no
  Claude configuration: it installs a pinned `claude` binary outside the home
  and leaves `~/.claude` to the volume the user mounts, so there is no
  managed-settings file or `settings.json` here to add a statusLine to. Writing
  one would make the image the first install shape that edits a user's Claude
  configuration on their behalf. So the image ships neither the recorder nor a
  statusLine entry, and its Agent spend page stays empty until an operator
  points Claude Code's statusLine at `tl-usage-record` themselves and installs
  `jq`, which the recorder needs and silently no-ops without (the image has
  `curl` and `tmux` but not `jq`). Codex is not installed in the image either.
  `docs/deployment.md` carries that note where an operator will meet it. The
  `.deb` ships the script to `/usr/local/bin/tl-usage-record` for the devvm,
  where infra owns the managed-settings entry that uses it.
