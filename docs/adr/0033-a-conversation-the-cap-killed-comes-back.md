# A conversation the cap killed comes back

Each tmux pane on the devvm has a 6 GiB memory cap. What fills a pane is mostly
what claude starts and writes: dev servers, `tsc`, test workers, MCP servers,
and files in the RAM-backed `/tmp`. Claude itself held 367 to 527 MB at every
cap kill measured. When the pane fills, the kernel kills its largest processes,
and sometimes that is the claude. A lobby pane runs `zsh -lic "claude …"`, so
the tmux session ends with it.

Between 2026-09-13 and 2026-09-25 the cap killed a claude five times. Each time
the session vanished 7 to 35 seconds later, mid-turn with background agents
running, and none of the five came back on its own. The conversation was not
lost: it is in the transcript on disk, and `claude --resume` brings it back,
the same way a suspended session returns (ADR-0030).

So tl-session-watch brings it back. It reads the kernel's kill records from
`/dev/kmsg`, remembers the claude pids it saw in each session, and when a
session's death (`session_died`, or `claude_died` where the shell survived)
matches a kill under a cgroup memory limit, it runs
`tmux-persist restore-one <user> <session> <message>`. The message is the
resumed claude's first prompt: it says the session was killed by the pane cap
mid-turn and resumed automatically, that background work is gone and leftovers
may still be running, and asks it to check what finished and carry on.

Viktor's calls, 2026-09-26:

- Only pane cap kills. A box-wide OOM or an earlyoom kill means the machine is
  short of memory, and restarting conversations into that invites the next
  kill. Neither writes a `CONSTRAINT_MEMCG` record, so neither matches.
- At most once per session per hour. A second cap kill inside the hour is left
  dead and logged as `resume_skipped`, since whatever filled the pane is likely
  to fill it again.
- The resumed claude continues on its own rather than waiting at the prompt.
- Alerts are unchanged: `ClaudeOOMKilled` and `ClaudeSessionDied` still fire.

## Consequences

- The watcher reads `/dev/kmsg` continuously in its own goroutine. Each OOM kill
  prints a task dump into a kernel ring buffer of about 280 KB, and a burst of
  kills can overwrite a record within one 30-second tick. A drill on 2026-09-26
  lost a record that way when read once per tick, and caught it through 1,168
  OOM-killer runs in 5 seconds when read continuously. journald rate-limits
  kernel messages, so the journal kept no record of that burst at all.
- tmux-persist restores from the newest snapshot holding the session, taken
  every 5 minutes. A session younger than its first snapshot cannot be
  restored, and one that ran `/clear` since its last snapshot resumes the
  conversation the snapshot recorded.
- Processes the killed pane started can outlive it. With `OOMPolicy=continue`
  the old pane's scope stays, and its leftover test workers keep running until
  they exit or the cap kills them. The message tells the resumed claude to
  check before starting more. The watcher does not stop them.
- A resume needs the user's tmux server running. With none up, tmux-persist
  would start one as a child of the watcher, inside its sandbox and its 128M
  memory cap, so the watcher logs `resume_failed` instead. Each user's prewarm
  slot session keeps a server alive, so this is rare.
- Restored sessions are now stamped `@tl_origin user` (infra `ca8de2f9`).
  Before, every restore came back unstamped and was treated as a system
  session everywhere in the lobby, including by this watcher.
- The once-an-hour record is in memory, so a watcher restart forgets it.
