# An ended link shows its transcript

Viktor, 2026-10-06: *"Once I kill the session, the link should still point to a
read-only transcript of the session unless I've explicitly revoked the link.
This would be helpful so that I can share it with others without having it
clutter my sessions list."*

ADR-0039 tied a public link to its session's life: a kill, crash or reboot
ended it. This amends that one decision. A link now outlives its session and
shows the conversation read-only until it expires or is revoked. Everything
else in ADR-0039 stands, and the live terminal path is unchanged.

Design: [Public links](../plans/2026-10-06-public-links-design.md), section
"After the session ends".

## What we decided

| Question | Decision |
|---|---|
| When a link switches | When its session ends, by kill or otherwise |
| While the session runs | The live terminal, as before |
| How long it lasts after | Its original expiry; "until revoked" links until revoked |
| What it shows | Everything the Text view shows, tool calls and results included |
| Which conversations | Every one the session ran while the link existed, oldest first, with a divider at each `/clear` |
| Plain shell sessions | The link ends with the session, as before |
| Pictures | Served through the link, limited to those the transcript references |
| A restored session | Does not revive the link; it stays on the transcript |

## How it works

A session's transcript path is a tmux option (`@claude_transcript`), set by
Claude Code's SessionStart hook and gone the moment the session is. So the
link records it while it can: tmux-api's 15-second sweep, the owner's link
list and the kill path each append the session's current transcript path to
the link's `transcripts` list. When the session is gone, the link is marked
`endedAt` instead of deleted. A link with no recorded transcript (a plain
shell) is deleted as before.

An ended link answers a redeem with `mode: "transcript"`, no ticket, and a
view cookie: random, bound to the link, held in tmux-api's memory for six
hours, scoped to `/s/api/link/`, HttpOnly, Secure and SameSite=Strict. The
visitor page then reads four GET routes with that cookie:

| Route | Serves |
|---|---|
| `/link/transcript?l=<id>` | Every recorded conversation as Text-view events, through sessionio's normalizer |
| `/link/result?l=<id>&tool=` | One tool result in full |
| `/link/image?l=<id>&tool=|record=&n=` | One picture block from a transcript |
| `/link/picture?l=<id>&p=` | One picture from the owner's clipboard store that a transcript names verbatim |

tmux-api reads the transcripts as the owner through session-events' existing
privileged child (`sudo -u <owner> session-events -privop`), which bounds
every path to that user's `~/.claude/projects`. No new sudo grant.

### Why a cookie and not the URL

Pictures are `<img>` GETs, so their credential cannot travel in a header, and
a credential in a URL is what access logs keep. ADR-0039 kept the link token
out of every request line for that reason, and this keeps the view key out
too.

## What it costs

- A link that once showed only what was on screen now exposes a whole
  conversation, tool output included, for as long as it lives. Viktor chose
  this over hiding tool output. An "until revoked" read-only link is a
  permanent public copy of that conversation until he revokes it.
- A conversation started less than 15 seconds before a crash can be missed.
  A kill records the transcript on the way out, so a kill never misses one.
- One transcript answer carries at most 6,000 events; older ones are dropped
  with a row saying so.
- Pictures that a transcript names elsewhere on disk (outside the clipboard
  store) are not served; the timeline shows its usual fallback for them.
