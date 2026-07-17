---
title: "Ctrl+J shell → persistent bottom dock (terminal-lobby)"
status: executing
---

# Ctrl+J shell → persistent bottom dock

**Repo:** `terminal-lobby` · **File:** `frontend/index.html` · **Supersedes** the
swap behavior shipped in `12985ab` (the shell no longer replaces the window; it
docks below it).

`Ctrl+J` / `Cmd+J` opens a plain shell in a **persistent bottom panel** that
slides up under the current session and stays docked as you navigate. Drag it to
the sidebar to promote it to a normal session. VS-Code / T3-Code-style.

## Decisions (agreed)

| # | Decision |
|---|----------|
| Split model | Separate session shown in a **frontend split** (two live terminals: top + dock) |
| Persistence | **Persistent** dock — survives top-session switch + reload; roamed server-side |
| Toggle/close | `Ctrl+J` toggles the panel (create → hide → show); `✕` un-docks to a card; kill = existing `⋯` |
| Drag | **Out only** — drag the dock to the sidebar to promote (project header → joins; else Ungrouped) |
| Mobile | **Desktop / fine-pointer only**; coarse pointers ignore the dock (top fullscreen) |
| Shell | Reuse `12985ab`: plain `shell` command, first-free name (`shell`/`shell-2`…), active session's project dir |

## Layout

`#lobby-content` becomes a vertical stack. With nothing docked, `#session-frame`
fills 100% (today's behavior, untouched).

```
┌ sidebar ──┬───────── #session-frame (top = currentActive) ─────────┐
│ ▾ proj    │  work   (claude)                                        │
│  •work ◀  │                                                         │
│  •shell ▤ ├══════════ gutter (drag ⇕ to resize) ═════════════════════┤
│           │  ⠿ shell            [drag handle]              [–] [✕]  │  dock header
│           │  #dock-frame (bottom = layout.dock.session)             │
│           │  shell $ _                                              │
└───────────┴─────────────────────────────────────────────────────────┘
```

```mermaid
flowchart TD
    K["Ctrl+J / Cmd+J (fine pointer, lobby)"] --> D{"layout.dock exists?"}
    D -->|no| C["create shell (first-free name, plain shell,\nactive session's project dir)\n→ layout.dock = {session, visible:true} → build #dock-frame → slide up"]
    D -->|"yes, visible"| H["hide panel (visible:false, slide down)\nshell keeps running"]
    D -->|"yes, hidden"| S["show same shell (visible:true, slide up)"]
    X["✕ on dock header"] --> U["un-dock: clear layout.dock,\nshell becomes a normal sidebar card"]
    DR["drag dock header → sidebar"] --> U2["un-dock + assign project via existing card DnD"]
    KILL["session killed / process dies"] --> U3["clear layout.dock, collapse"]
```

## State & persistence

- `layout.dock = { session: "<name>", visible: bool }` — added to the roamed
  layout object (PUT/GET `/api/sessions/layout`; `fetchLayout` preserves unknown
  keys, so it round-trips + follows the user across devices). Normalize defensively.
- **Split ratio** → per-browser `localStorage` key `tl:dock-split:v1` (screens
  differ). Default top 70 / dock 30. Clamped to sane min heights.
- **Restore on load:** if `layout.dock.session` is a live session → build the
  split (visible per flag); if it's gone → clear the dock.

## Interactions

- **Gutter:** pointer-drag to resize; writes the ratio to localStorage; both
  iframes re-fit (ttyd `-W` + pixel→pty resize already handles terminal reflow).
- **Dock header:** shows the session name, a `[–]` hide, a `[✕]` un-dock, and is
  the `draggable` handle (fine-pointer only) — `dataTransfer` carries the session
  name; the existing sidebar drop targets (project headers / Ungrouped) accept it,
  extended so a drop from the dock also clears `layout.dock`.
- **Clicking the docked session's card:** focuses the dock pane (no layout change).
- **Sidebar marker:** the docked session's card shows a small dock glyph.

## Edge cases

- **No top session:** `#lobby-empty` placeholder on top, shell docked below.
- **Deep-linked bare `?arg=` tab** (no lobby): `Ctrl+J` is a **no-op** (the dock
  needs the lobby chrome) — replaces the shipped navigate-to-shell in that context.
- **Coarse pointer / mobile:** ignore the dock; show `currentActive` fullscreen.
  Keyboard chord doesn't exist there anyway.

## Implementation order (`frontend/index.html`)

1. **CSS + DOM:** restructure `#lobby-content` into a flex column: `#session-frame`
   (flex top) + `#dock-gutter` + `#dock` (holds `#dock-header` + `#dock-frame`).
   Hidden state ⇒ top fills 100%. Slide-up transition on `#dock`.
2. **Dock state module:** read/write `layout.dock` (via the layout store) +
   `tl:dock-split:v1` ratio; `dockState()`, `setDock()`, `clearDock()`.
3. **Rewire `session.new.shell`** (lobby `runAppCommand`): replace `openNewShellHere`'s
   swap with dock create/toggle/show/hide. Keep first-free naming + project dir.
   `#dock-frame` src via `frameArgs(name, {cmd:'shell', dir})`.
4. **Dock header controls:** `[–]` hide, `[✕]` un-dock, draggable handle.
5. **Gutter resize:** pointer handlers → ratio → persist.
6. **Drag-out:** extend the sidebar drop handlers to clear `layout.dock` when the
   dragged session is the docked one.
7. **Restore on load + reconcile:** build the split from `layout.dock` after the
   layout + first sessions poll; clear when the docked session vanishes; focus the
   dock when its card is clicked; add the sidebar dock marker.
8. **Guards:** coarse-pointer ⇒ no dock; unframed deep-link ⇒ `Ctrl+J` no-op.
9. **Settings tooltip:** update the `Ctrl+J` note (now "docks a shell").

## Testing (dev stub + Playwright)

Create → split appears; toggle hide/show; persist across a top-session switch +
reload (mock layout with `dock`); drag-out promotes + collapses; gutter resize
persists; coarse-pointer ⇒ no dock; killed/dead docked session clears; unframed
`Ctrl+J` no-op. No console errors.

## Revision — 2026-07-17 (hidden scratch shell + mobile)

Two refinements after the first ship (`3c1ab67`):

- **The dock shell is NOT a thread in the sidebar.** It's a hidden scratch shell
  "for this thread", filtered out of the sidebar list (and the command palette)
  while it's docked. Dragging it out still promotes it into a normal listed
  thread. Implementation: `paint()` drops `dockState().session` from the rendered
  cards (and `orderedSessionNames`, which reads the DOM, follows automatically)
  while `dockAllowed()`. On mobile (no dock) it falls through as a normal card so
  it's never lost.
- **No dock on mobile.** The dock is gated on `dockAllowed()` = fine pointer AND
  `min-width: 721px` (was just `!isCoarsePointer`), and `#dock`/`#dock-gutter` are
  `display:none` on `max-width:720px`. Fixes a bug where, in the mobile two-view
  nav, `#lobby-content` becomes `display:block` — which overrode the dock grid's
  collapse, so the dock rendered as a visible block that `✕` couldn't hide and
  the terminal lost its height. Also `#lobby-top { height:100% }` in the mobile
  block so `#session-frame` fills. Verified with Playwright (desktop hide +
  promote; mobile `#dock` display:none, terminal fills, `Ctrl+J` swap fallback).

## Revision — 2026-07-17 (dock persistence was never wired — orphan/auto-close fix)

The "roamed server-side" persistence above **never worked**: `layout.dock` was
sent on every PUT and preserved by the client's `fetchLayout`, but tmux-api's
`Layout` struct had **no `dock` field**, so the server silently dropped it on
decode and never returned it. The dock therefore lived only in client memory,
shielded by the 4s `dockGraceUntil`; the first poll after that grace overwrote
it with the server's dock-less copy. Symptoms: the panel "auto-closed" a few
seconds after opening, `Ctrl+J` then spawned a *new* `shell-N` (create branch,
no dock present), and the still-live shell un-hid into Ungrouped.

Fix (`wizard/dock-orphan-fix`):

- **Server persistence (root cause):** `Layout` gains a `Dock *DockState`
  (`{session, visible, dir}`) field — stored, returned, and validated like the
  rest. `mutateSessions` keeps it in lockstep with the session it names (a UI
  kill clears the dock; a rename follows it). This is what makes it actually
  roam + survive polls.
- **Client hardening (defence in depth):** a poll may not drop a still-live dock
  on a single stale/dock-less read — two consecutive such polls are required
  (`dockDropStreak`); `reconcileDock` fails open on an empty session list; and
  `saveLayout`'s failed-PUT re-fetch preserves a live dock.
- **Reclaim (`Ctrl+J`):** with no dock but live scratch shells stranded in the
  sidebar, re-dock the newest (`reclaimableShells`, matched by `shell`/`shell-N`
  name + unassigned) and auto-kill the rest (`killSessionSilent`). Loose `shell*`
  in Ungrouped is treated as disposable — **promote into a project to keep one.**
