# frontend-v2 — terminal-lobby v2 frontend (SolidJS + TypeScript)

The from-scratch rewrite of terminal-lobby's frontend (roadmap pillars #0 + #2).
This directory is the **foundation**: the build pipeline, the shared wire
contract, the resumable event stream, the two-view app shell, and the structured
text-mode renderer. It lives **alongside** the vanilla `frontend/` — the existing
app is untouched and still ships until v2 reaches cutover.

## What this is

A **two-view app** over a single tmux/Claude session:

- **Text mode (primary)** — a MessagesTimeline-style structured render of the
  session's normalized event stream: turn folding, collapsed tool rows with
  expand-to-raw, full-width assistant **markdown with mermaid + inline images**,
  user bubbles, a composer, and a composer-docked permission panel.
- **Terminal mode (fallback)** — a stub today; it will host the existing ttyd
  iframe (a live pty attach to the *same* tmux session). xterm stays **external**
  (never bundled), per the deploy decision.

The switch is a segmented **`[ Text | Terminal ]`** control: **full-swap XOR**,
both views **permanently mounted** (CSS-hidden, never unmounted), `Cmd/Ctrl-J`
toggles, per-session/per-device `{mode}` in localStorage, activity dot on the
inactive segment.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm run build        # → dist/index.html (ONE inlined file, no sidecars)
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

`?session=<id>` selects the session; `?api=<base>` points the SSE/control calls
at a remote devvm for local dev (default is same-origin).

### Local dev against real backends

The Vite dev server proxies to the two devvm services so the SPA runs end-to-end
without CORS (`vite.config.ts`):

- `/events`, `/prompt`, `/cancel`, `/permission` → **session-events** (default
  `http://127.0.0.1:7685`, override `TL_SESSION_EVENTS`).
- `/api/*` → **tmux-api** root, stripping the `/api` prefix (default
  `http://127.0.0.1:7684`, override `TL_TMUX_API`).

Both services resolve the OS user from the `X-Authentik-Username` header the
ingress injects in prod; set `TL_DEV_AUTH=<authentik-name>` and the proxy stands
in for the ingress so the dev server authenticates.

## Build output

`npm run build` uses `vite-plugin-singlefile` to inline **all** JS + CSS into a
single `dist/index.html` — verified: `dist/` contains exactly one file, no
`.js`/`.css`/`.wasm`/worker sidecars. Serving stays byte-identical to the vanilla
app (ttyd `-I index.html`). The build id is injected via Vite `define`
(`__TL_BUILD__`), replacing the old `sed` token.

## Layout

```
src/
  types/events.ts        Wire contract — mirrors session-events/event.go EXACTLY
  types/lobby.ts         tmux-api shapes (Session/Layout/Project/Whoami)
  lib/config.ts          Endpoints: /events,/prompt,/cancel,/permission (session-
                         events) + apiUrl() for the /api tmux-api prefix + build id
  lib/lobby-api.ts       tmux-api client (sessions/layout/whoami/kill/rename/…)
  sse/client.ts          Resumable SSE client (Last-Event-ID, backoff+jitter,
                         instant-retry on visible/online) — DOM-free, testable
  store/session.ts       SSE → Solid store of events + prompt/cancel control
  store/viewmode.ts      Per-session/per-device {mode} persistence
  store/lobby.ts         Lobby store: poll + optimistic layout PUT + session CRUD
  store/collapse.ts      Per-browser group-collapse (tmux-collapsed-<user>)
  theme/theme.css        The 9-theme CSS-var token layer (ported verbatim)
  theme/theme.ts         Live theme switch + xterm ITheme derivation
  components/
    lobby.logic.ts       PURE sidebar derivation + layout transforms (unit-tested)
    Sidebar / ProjectGroup / SessionCard / StateDot / CreateSessionRow
    App.tsx              Lobby shell (sidebar + selected SessionView + toast)
    SessionView.tsx      The per-session two-view surface (text | terminal)
    timeline.logic.ts    PURE transcript→rows derivation (unit-tested, no DOM)
    MessagesTimeline.tsx  Rows-as-data renderer (fold / tool / working / …)
    Markdown.tsx          solid-markdown + remark-gfm + rehype-sanitize
    Mermaid.tsx           Lazy mermaid render (dynamic import; fold into 1 file)
    Composer.tsx          Prompt input + Send↔Stop morph + number-key approvals
    PermissionPanel.tsx   Composer-docked Approve/Deny → POST /permission/<id>
    ViewSwitch.tsx        Segmented Text|Terminal + activity dot
    TerminalView.tsx
test/                    logic, store, sidebar render, SSE client, event-parse,
  integration/             + a REAL session-events SSE integration test
```

## Wire contract

`src/types/events.ts` mirrors the Go `Event` struct in
`session-events/event.go` field-for-field (`id, kind, session, turnId, body,
tool, toolId, reqId, isError, at`) and the 11 `kind` discriminators. The renderer
only ever sees this normalized shape, never raw transcript JSONL.

## Lobby sidebar (pillar #2)

The sidebar is a pure view over the lobby store (`store/lobby.ts`), which polls
`/api/sessions` + `/api/layout` (5s), derives the render model (`lobby.logic.ts`),
and pushes every mutation back as a whole-document `PUT /api/layout` (optimistic,
with a 4s grace window so a stale poll can't revert an in-flight change):

- session list with Claude **state dots** (running pulses / awaiting glows / done
  dims-or-rings-while-unseen), a live working timer for running sessions;
- **project grouping + Ungrouped** at its movable slot (hides while empty);
- **session CRUD** — create (optimistic + dup guard), rename (inline, POST
  `/api/sessions/{n}/rename`, 409/404 handled), kill (DELETE), move-to (menu);
- **drag-reorder** session cards (across groups) and group headers (HTML5 DnD),
  plus menu move-up/down; per-browser **collapse**; **Restore** (POST `/restore`);
- read-only **Shared-with-me** section for foreign sessions.

## Foundation stubs / follow-ups

- **Terminal view** is a placeholder (ttyd iframe wiring is P2). A created
  session's tmux birth rides that terminal attach (`new-session -A`); until it's
  wired, a freshly-created card shows optimistically and reconciles on the poll.
- **Global projects / sharing (Category 3 advanced):** grouping here is driven by
  the per-user `/api/layout` (create/move at the layout level). The multi-user
  global project store (member management, attach-mode, co-ownership, minting a
  global project on create) and the dir-picker create-project modal are not yet
  wired — a follow-up on top of this sidebar.
- **Virtualization**, auto-fallback engine, mobile soft-keys, PWA/SW, gallery,
  command palette, keybinding engine — later phases (see the inventory + design).
