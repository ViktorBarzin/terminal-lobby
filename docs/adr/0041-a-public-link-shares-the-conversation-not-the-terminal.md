# A public link shares the conversation, not the terminal

Viktor, 2026-10-07, after opening a link to one of his own sessions on a wide
screen: *"it doesn't quite work well. we should share the text mode only. the
terminal is not helpful."*

ADR-0039 gave a public link a live terminal, attached through two ttyd
instances, and ADR-0040 added a read-only transcript for after the session
ends. In use, the terminal was the weaker half: a watcher is drawn at the
owner's window size, which on a wide screen is a small block in a large empty
page, and what a visitor wants to follow is the conversation. This replaces
the terminal with the conversation, live and finished alike.

## What we decided

| Question | Decision |
|---|---|
| What a link shows | The session's Claude conversation, as the Text view draws it, read-only |
| While the session runs | The same view, re-read every 3 seconds; only new events are fetched |
| After it ends | Unchanged from ADR-0040: the conversation, until the link expires or is revoked |
| Read-write links | Gone. Every link is read-only; Share… offers no access choice |
| Plain shell sessions | Cannot be shared. Share… is offered only on sessions running Claude, and tmux-api refuses the rest |
| The terminal path | Removed: both link ttyds, the attach scripts, the `tl-link` account and its sudo grant, tickets and grants, the 7692-7693 firewall and network-policy rules |
| Who serves `/s/` | clipboard-upload, which already serves the page's chunks |
| The owner's view | The session bar shows "N viewing" with Stop; Settings lists every link |

## How it works now

Redeeming a link sets its view cookie (ADR-0040) for every link, live or
ended. The page then reads `GET /link/transcript?l=<id>&after=<n>`, which
answers the events after event `n` plus the id of the last one. Event ids are
assigned in transcript order and a transcript only grows, so an event the page
holds never changes under it. A live link's current transcript is added on the
read itself, so a conversation started by `/clear` shows without waiting for
the sweep.

"N viewing" counts the view keys that read in the last 30 seconds. A live page
reads every 3 seconds, so it counts for as long as it is open; a finished
conversation's page reads once.

## What it costs

- Visitors can no longer type into a session through a link. Viktor chose to
  drop read-write rather than keep it as prompt-sending.
- A live conversation appears up to 3 seconds behind; the Text view in the
  lobby streams.
- Every live reader re-parses the session's transcripts every 3 seconds. A
  long conversation with several readers is real work for tmux-api; a parse
  cache keyed on file size is the obvious next step if it shows up in the
  rollup timings.
- The postinst removes the `tl-link` account and `/etc/sudoers.d/tl-link`
  after retiring the two units, so a box upgraded across this change is left
  with neither.
