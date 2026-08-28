# frontend-v2 — terminal-lobby v2 frontend (SolidJS + TypeScript)

The from-scratch rewrite of terminal-lobby's frontend (roadmap pillars #0 + #2),
and since the 2026-08-16 cutover **the lobby**. The build is one inlined HTML
file; `scripts/deploy-v2.sh` installs it as `index.html`, which `ttyd` serves
(`-I`, port 7681) at `terminal.viktorbarzin.me`.

The vanilla `frontend/` is no longer deployed. It stays in the tree as the
rollback target and as the parity reference `scripts/test_frontend_compat.py`
compares against. The `terminal-dev.viktorbarzin.me` canary that carried this
app before the cutover was retired the same day.

## What this is

A lobby shell — a sidebar of sessions and projects beside the selected
session's surface — where each session has **two views** over the same
tmux/Claude session:

- **Text mode (primary)** — a MessagesTimeline-style structured render of the
  session's normalized event stream: turn folding, collapsed tool rows with
  expand-to-raw, full-width assistant **markdown with mermaid + inline images**,
  user bubbles, and a composer that injects prompts and cancels the running turn.
- **Terminal mode (fallback)** — a live pty attach to the *same* tmux session:
  an iframe pointed at the ttyd-served `/term.html` page, navigated by
  `contentWindow.location.replace()`. The attach is **lazy** — it waits until
  this view is first shown, because attaching resizes the tmux window to the
  iframe and would squeeze a wider client already using it. The exception is a
  session the app is CREATING: that attach is what BIRTHS its tmux (via
  `new-session -A`), so it happens immediately. The `?arg=` positional
  contract — name, command, **project dir**, owner — lives in
  `lib/terminal-url.ts`. xterm stays **external** (never bundled), per the
  deploy decision.

The switch is a segmented **`[ Text | Terminal ]`** control: **full-swap XOR**,
both views **permanently mounted** (CSS-hidden, never unmounted), `Cmd/Ctrl-J`
toggles, per-session/per-device `{mode}` in localStorage, activity dot on the
inactive segment.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm run build        # → dist/ (see "Build output")
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

`?session=<id>` selects the session; `?api=<base>` points the SSE/control calls
at a remote devvm for local dev (default is same-origin); `?terminal=<url>`
overrides the terminal page the iframe frames.

### Local dev against real backends

The Vite dev server (and `vite preview`, so a built artifact can be exercised
the same way) reproduces the prod ingress's routing, so the SPA runs end-to-end
without CORS (`vite.config.ts`):

| Prefix | Target | Mapping |
|---|---|---|
| `/events`, `/prompt`, `/cancel` | **session-events** (`TL_SESSION_EVENTS`, default `http://127.0.0.1:7685`) | verbatim — the service serves these at its root |
| `/api/sessions` | **tmux-api** (`TL_TMUX_API`, default `:7684`) | strips the whole prefix |
| `/clipboard` | **clipboard-upload** (`TL_CLIPBOARD_UPLOAD`, default `:7683`) | strips the prefix |
| `/files` | **file-api** (`TL_FILE_API`, default `:7686`) | verbatim — its own routes carry `/files` |
| `/skills` | **skills-api** (`TL_SKILLS_API`, default `:7688`) | verbatim — its own routes carry `/skills` |
| `/ws`, `/token` | **ttyd** (`TL_TTYD`, default `:7681`) | the terminal attach + its token fetch |
| `/fonts` | **clipboard-upload** | the webfonts `term.html` sources |

Every backend resolves the OS user from the `X-Authentik-Username` header the
ingress injects in prod; set `TL_DEV_AUTH=<authentik-name>` and the proxy stands
in for the ingress so the dev server authenticates (injected on `proxyReq` *and*
`proxyReqWs` — the ttyd WebSocket upgrade fires only the latter).

## Build output

`npm run build` emits three kinds of file into `dist/`:

- **`index.html`** — the whole SPA. `vite-plugin-singlefile` inlines **all** JS +
  CSS into it, so there are no `.js`/`.css`/`.wasm`/worker sidecars and ttyd can
  serve it from a single `-I <file>`, exactly as it serves the vanilla page (the
  point of the single-file build). The build id is
  injected via Vite `define` (`__TL_BUILD__`) as a literal placeholder that
  `deploy-v2.sh` substitutes, so the artifact is a pure function of the source
  (ADR-0007).
- **`term.html`** — the terminal-mode page the iframe frames, copied from
  `../frontend/term.html` by the `copyTermHtml` plugin and stamped with the same
  build id. It is deliberately outside the bundle: it pulls xterm from a CDN and
  speaks ttyd's binary WS protocol. `deploy-v2.sh` ships it beside `index.html`.
- **`public/` verbatim** — `sw.js`, `manifest.webmanifest` and the three icons,
  which Vite copies as static assets. In production these are served by
  clipboard-upload from its exact-path whitelist and installed by
  `scripts/deploy.sh` from the identical copies in `frontend/`.

## Layout

```
src/
  index.tsx              App entry: mounts <App>, installs slow-request tracking
  global.d.ts            Vite `define` + theme-boot-script global declarations
  app.css                App chrome + timeline styles (theme tokens only)
  sidebar.css            Lobby shell grid + sidebar styles
  types/events.ts        Wire contract — mirrors sessionio/event.go EXACTLY
  types/lobby.ts         tmux-api shapes (Session/Layout/Project/Whoami)
  lib/
    config.ts            Endpoints: /events,/prompt,/cancel (session-events),
                         apiUrl() for /api/sessions, clipboardUrl(),
                         file read/list/write, TERMINAL_BASE + build id;
                         also ACT_AS (?as=) and the appendActAs() every
                         builder applies — push is deliberately excluded
    lobby-api.ts         tmux-api client (sessions/layout/whoami/kill/rename/
                         retitle/title/…)
    ownwhile.ts          Hold a window.__tl* handle only while a view is the one
                         on screen. With several sessions mounted, mount order
                         stopped meaning anything; handover is order-independent
    baseline-polyfills.ts  AbortSignal.timeout (Safari 16) and URL.canParse
                         (Safari 17), filled in for the oldest engine we serve.
                         Installed from index.tsx before anything else runs,
                         because the first is read on the way into EVERY lobby
                         request — its absence threw before fetch, so no request
                         left the device and the sidebar read "Failed to load"
    markdown-plugins.ts  Which remark plugins THIS ENGINE can run. remark-gfm's
                         autolink extension builds an email pattern with a
                         lookbehind on every render, and lookbehind is Safari
                         16.4 — so on iPadOS 15.8 it is dropped and the message
                         still renders, minus tables/task lists/strikethrough
    slug.ts              Display TITLE → tmux session NAME: romanize, lowercase,
                         collapse, cap at 32. Mirrors Go's terminal-lobby/slug
                         against the shared slug/vectors.json — the browser has
                         to derive a name unaided, since creating a session
                         reaches no server at all
    file-api.ts          file-api client (list/read/write; maps 404/413/400).
                         contentUrl() re-exports the resolver below, so a read
                         of a clipboard-store path goes to clipboard-upload
                         instead of the home-confined file-api
    attachments.ts       PURE text-view attachments: which paths in a message are
                         files worth drawing (store paths always; images and
                         document formats anywhere — never source paths), and
                         which of the two backends serves each one
    skills-api.ts        skills-api client (inventory/view/diff/install/toggle/
                         remove/delete/plugin-update/plugin-uninstall/restart,
                         plus source inspect + install from a GitHub repo). Maps each status the
                         panel says something different about: 409 is a name
                         collision with a diff to show, 404 a list drawn before
                         someone else removed that skill
    act-as.ts            Admin act-as switch: the URL to navigate to in order
                         to act as a user (or return) — switching is a load —
                         plus lensTarget(), the one answer for "whose account
                         is this tab looking at": it makes a session open
                         WATCHING and namespaces the Watch choice per target
    terminal-url.ts      ttyd `?arg=` POSITIONAL contract (incl. the foreign-
                         owner 4th arg, which the act-as target defaults into)
                         — red-line-class, unit-tested
  diagnostics/
    connection.ts        Measures the link (Navigation Timing bytes/time + an
                         optional tiny RTT probe — navigator.connection does not
                         exist on iOS), classifies full/slow, remembers the
                         verdict per device for the NEXT load, and answers what
                         each lever should do. A pin always wins
  sse/client.ts          Resumable SSE client (Last-Event-ID, backoff+jitter,
                         instant-retry on visible/online) — DOM-free, testable.
                         Resyncs when `ready` names a log it was not reading:
                         ids are per-transcript, so a session whose transcript
                         was replaced would otherwise resume above the new log
                         and freeze on the old conversation
  store/
    session.ts           SSE → Solid store of events + prompt/cancel control
    lobby.ts             Lobby store: poll + optimistic layout PUT + session CRUD
    transcript-cache.ts  Client-side transcript store (IndexedDB): seeds the
                         timeline from what this device already holds and resumes
                         the stream from that cursor, so re-opening a session you
                         have read costs the difference rather than the whole
                         window. Keyed on the server's ready.epoch, so a rewritten
                         log takes the existing resync path. Policy is pure and
                         tested; the backend is injected
    viewmode.ts          Per-session/per-device {mode} persistence. The default
                         is TERMINAL on every device (2026-08-19); storage holds
                         only the sessions that chose text
    keepalive.ts         PURE rules for which sessions stay MOUNTED behind the
                         one on screen (every session visited, one-day TTL).
                         Appends only and hands back stable entries: moving or
                         replacing a slot reloads its iframe, which is the
                         1,797 ms cover this exists to remove
    watchmode.ts         Per-session/per-device Watch mode (attach read-only).
                         A lens (acting as another user) defaults to watching
                         and keeps its choices under the target's own keys, so
                         driving THEIR `code` decides nothing about yours
    dock.logic.ts        PURE Ctrl+J dock decisions (shell naming, create→hide→
                         show, sidebar hiding, split clamp)
    dock.ts              Ctrl+J scratch-shell dock state (roamed via layout.dock)
    collapse.ts          Per-browser group-collapse (tmux-collapsed-<user>)
    visits.ts            Per-browser seen/visit tracking (tl:session-visits:v1)
                         → the unseen-done predicate behind the tab-title (N✓)
                         badge and the favicon's green tick
    drafts.ts            Per-browser composer drafts (tl:session-drafts:v1): the
                         unsent text AND its attachment tray, pruned to the live
                         session list the way visits.ts prunes
    prefs.ts             Roamed prefs (whole-doc GET/PUT /prefs, last-writer-wins)
    device-prefs.ts      Per-BROWSER switches the roamed doc must not carry:
                         terminal flow control (tl-flow-control — the iframe
                         picks a flip up live via a storage event) and the
                         Clear-local-data wipe
    toast.ts             Toast stack + the slow-request health coordinator
    gallery.logic.ts     PURE gallery sort / badge / step-back rules
    gallery.ts           Gallery store (re-fetches /clipboard/list on open)
    preview.logic.ts     PURE file-type → renderer + transcript → file-path
    preview.ts           File-preview store (open file, raw|rendered, browse)
    skills.logic.ts      PURE skill-row rules: what a row says about itself
                         (own / from X / update / edited), what a peer's skill
                         offers (install / replace / nothing), and which sessions
                         may be restarted
    skills.tabs.ts       PURE Skills-panel shape: the tab strip (own, one per
                         other account, plugins, sessions), which tab survives an
                         inventory that no longer has it, the name/description
                         filter, and which empty state a list has earned
    skills.ts            Skill-manager store (lazy: the group asks on first
                         render, and every action reloads rather than patching
                         the list, so the verdicts stay the server's to compute)
    editor.logic.ts      PURE edit mode: ext → CodeMirror language, dirty/save
  components/
    App.tsx              Lobby shell (sidebar + selected SessionView + overlays)
    Sidebar.tsx          Identity, new-session row, groups, Shared-with-me
    ProjectGroup.tsx     One project group header + its cards (DnD, menu)
    SessionCard.tsx      One session row: dot, tool mark, timer, inline rename
    StateDot.tsx         Claude state dot (running / awaiting / done)
    ToolIcon.tsx         Which command the session runs (tmux-api `tool`)
    CreateSessionRow.tsx New-session input + the Claude/Codex/shell picker
    menu.ts              The ⋯ popup: poll hold + Escape/outside-press dismiss
    lobby.logic.ts       PURE sidebar derivation + layout transforms (unit-tested)
    SessionView.tsx      The per-session two-view surface (text | terminal)
    ViewSwitch.tsx       Segmented Text|Terminal + activity dot
    TextView.tsx         Text mode: timeline above the composer
    canonicalize.ts      Tool call → canonical item (ported from T3, MIT)
    compose.logic.ts     PURE `/` and `@` completion + the mode cycle
    rows.tsx             One view per canonical item (diff, output, todo, …)
    timeline.logic.ts    PURE transcript→rows derivation (unit-tested, no DOM)
    MessagesTimeline.tsx Rows-as-data renderer (fold / tool / working / …)
    Markdown.tsx         solid-markdown + remark-gfm + rehype-sanitize, plus a
                         rehype pass turning bare absolute paths in Claude's
                         prose into attachments (code subtrees skipped)
    Attachment.tsx       One attachment as the chat draws it: an image preview, a
                         document chip, or the path when nothing can serve it —
                         and MessageSegments, which substitutes in place
    Mermaid.tsx          Lazy mermaid render (dynamic import; folds into 1 file)
    Composer.tsx         Prompt input + Send↔Stop morph + mobile submit split
    context.logic.ts     PURE reading of the `/context` meter (newest reading,
                         staleness in settled turns, category breakdown).
                         Nothing runs the command — no reading, no chip
    answer.logic.ts      PURE plan for answering an AskUserQuestion — the keys
                         each question needs, and what the pane must show
                         afterwards — plus the runner that checks between steps
    QuestionCard.tsx     The docked answer card: walks the questions, reviews,
                         then sends. Nothing is typed until Send, so abandoning
                         the walk leaves the dialog untouched
    find.logic.ts        PURE hit labelling + how far back a jump may reach
    FindInSession.tsx    Find-in-session overlay. The search runs on the SERVER
                         over the whole transcript — the window here is 20 turns
                         — and a hit jumps by loading earlier turns until its
                         row exists (Alt+Shift+F, or the bar menu on a phone)
    ContextMeter.tsx     How full the context is, beside the mode chip, with the
                         breakdown behind a tap. Figures are the CLI's own — the
                         ceiling is not on the wire and is not a constant
    PermissionPanel.tsx  INERT. Approve/Deny UI kept for a future gated
                         re-enable; its server side was removed in 575d4f5, so
                         Composer still mounts it but it always renders nothing
                         — no `permission_request` can arrive (header comment)
    TerminalView.tsx     Terminal mode: the ttyd iframe + lazy attach (eager
                         only for the session being created)
    Gallery.tsx          Session image-gallery overlay + shared lightbox
    FilePreview.tsx      File-preview overlay (markdown/HTML/image/code/binary)
    CodeView.tsx         Read-only highlighted code (lazy highlight.js)
    CodeEditor.tsx       CodeMirror 6 host (uncontrolled; onChange/onSave)
    codemirror-view.ts   The lazy-imported EditorView factory
    CommandPalette.tsx   Command-palette overlay (view over PaletteController)
    ShortcutsHelp.tsx    Keyboard-shortcuts help overlay
    RestorePicker.tsx    Restore overlay: pick a session snapshot, see what it
                         would recreate, choose which rows to bring back
    SettingsPanel.tsx    Settings overlay: theme, font size, session-list
                         last-active time, new-session command, keyboard,
                         notifications, and the admin act-as picker
    SkillsPanel.tsx      The Skills overlay (docs/adr/0011), its own dialog off
                         the shell bar beside Settings: a tab per list — this
                         account's skills, each other account's with a
                         same/differs verdict, the marketplace plugins, the live
                         sessions — a name/description filter, and the install /
                         replace-with-backup / disable / remove / update / restart
                         actions, plus the two permanent ones — Delete (the
                         skill and every backup of it) and Uninstall (a plugin
                         and its files). Every action is ON the row for both
                         lists; expanding one shows that skill's SKILL.md —
                         your own in an editor that writes it back, a peer's
                         read-only.
                         Also the owner/repo field: one read-only look decides
                         whether a repo offers skills, a plugin marketplace or
                         both, then the ecosystem's own installer runs as you
                         (docs/adr/0012) It started as a group INSIDE Settings and
                         outgrew it: 38 own skills and a peer's 21 do not read as
                         one 420px column
    SoftKeys.tsx         Mobile soft-key toolbar (coarse-pointer only)
    Dock.tsx             The Ctrl+J scratch shell in a resizable bottom panel
    BellIcon.tsx         Header notification-bell glyph (on/off)
    Icons.tsx            Chrome icons as inline Lucide SVG (image, camera,
                         clipboard, file-text, rotate-cw) — never emoji
    Toaster.tsx          Top-right toast stack
  keybindings/
    chords.logic.ts      PURE layout-proof chord parse/match
    bindings.logic.ts    PURE binding table + resolve/normalize
    engine.ts            One capture-phase keydown + Alt-hold tracker + storage
    commands.ts          The lobby command dispatcher (also serves tl-command
                         forwarded up from the terminal iframe)
    navigation.logic.ts  PURE Alt+1..9/0 attach-Nth + next/prev/next-awaiting
    palette.logic.ts     PURE palette ranking / filtering / recents-first
    palette-controller.ts Reactive palette state (open, query, selection)
    refocus.ts           Hand the keyboard back to the terminal iframe when a
                         lobby overlay closes (window.__tlFocusTerminal)
  notify/
    transitions.ts       PURE poll→poll state edges that deserve a notification
    fire.ts              Show ONE foreground OS notification per session edge
    title.ts             Tab-title state badge
    favicon.ts           Canvas-rendered favicon badge
    attention.ts         Bell / output-while-hidden latches from the iframe
    opt-in.ts            Per-browser notification opt-in flag
    notifications.ts     Wires the above + push into the running app
  pwa/
    register.ts          Registers /sw.js + the notification-tap handoff
    push.ts              Web Push subscribe/heal (best-effort)
    vapid.ts             VAPID base64url → Uint8Array
  mobile/
    pointer.ts           Coarse-pointer gate for every mobile affordance
    keybytes.ts          Pre-baked terminal byte sequences for the soft keys
    softmods.ts          PURE one-shot/latched soft Ctrl+Alt machine
    compose.ts           PURE bracketed-paste + trailing-submit split
    viewport.ts          visualViewport → CSS var so the keyboard can't cover
    swipe.ts             PURE swipe classification + the session-switch gesture
    reorder.ts           PURE geometry for dragging a session row with a
                         finger (which side of the row under it, how fast
                         the list scrolls itself at its edges)
  clipboard/
    paste-into-terminal.ts  Clipboard -> terminal, READ IN THE LOBBY (the frame
                         has no focus, so it cannot read it) — text via tl-paste,
                         images via the shared upload intake
    paste.ts             PURE paste image-vs-text discrimination
    drop.ts              PURE drag-payload detection
    upload.ts            clipboard-upload client + field routing
    attach.ts            The DOM glue (window listeners + drop overlay)
  deploy/
    healer.logic.ts      PURE self-update kernel (ADR-0007)
    healer.ts            Its controller: poll own served bytes, TOP-owned reload
  telemetry/track.ts     Batched usage events → tmux-api /telemetry (ADR-0006)
  telemetry/diag.ts      Typed seam onto the shared frontend/diag.js core (ADR-0008)
  theme/theme.css        The 9-theme CSS-var token layer (ported verbatim)
  theme/theme.ts         Live theme switch + xterm ITheme derivation
public/                  sw.js (push-only — a fetch listener is FORBIDDEN),
                         manifest.webmanifest, three icons
test/                    logic, store, sidebar render, SSE client, event-parse,
  integration/             + a REAL session-events SSE integration test
```

## Wire contract

`src/types/events.ts` mirrors the Go `Event` struct in
`sessionio/event.go` field-for-field (`id, kind, session, turnId, body,
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

## Beyond the two views

All of the following ship in the deployed build:

- **Keyboard** — a layout-proof chord engine with one capture-phase listener:
  Alt-hold paints numbered chips, `Alt+1…9/0` attaches the Nth session,
  `Alt+Shift+]`/`[` step forward/back, `Alt+Shift+Enter` jumps to the next
  awaiting one, `Alt+Shift+S` collapses the sidebar, `Cmd/Ctrl-J` swaps view.
  The shortcuts help opens on a bare `/` in the lobby, or `Alt+/` from anywhere
  including inside the terminal — chords pressed in the iframe are forwarded up
  over the `tl-command` channel. Bindings are user-overridable and persisted
  per-browser (`tl:keybindings:v1`).
- **Command palette** — `Ctrl+Shift+K`; type to filter sessions, `>` switches to
  action mode. The action list is selection-dependent.
- **Gallery** — the 🖼 overlay lists the session's stored images from
  `/clipboard/list` (newest-first, `show-image` badged), with a shared lightbox;
  Escape steps lightbox → grid → closed.
- **Images in** — paste, drag-and-drop and upload to clipboard-upload, which
  hands back the server path typed into the pty.
- **File preview + editor** (pillar #6) — an overlay over file-api: browse a
  directory, open a file by path or from the transcript-derived recents, render
  markdown (Markdown+Mermaid), HTML (sandboxed `srcdoc`), images, or
  syntax-highlighted code, and edit-and-save in CodeMirror 6.
- **Notifications** — tab-title and favicon badges, attention latches from the
  terminal iframe, foreground OS notifications on state edges, and background
  **Web Push** via `/sw.js` + `/api/sessions/push/*` when the browser and the
  server's VAPID key allow it.
- **Mobile** — a coarse-pointer soft-key toolbar (raw byte sequences a phone
  keyboard cannot produce), soft Ctrl/Alt modifiers, and visualViewport
  plumbing so the soft keyboard cannot cover the composer.
- **Settings** — an overlay with the 9-theme grid (per-device), terminal font
  size (roamed + dual-written for the ttyd page), the session-list last-active
  time (`sidebar.showLastActive`, roamed, **off by default** — it hides the
  relative "5m ago", never a running session's live working timer), the
  new-session command, keyboard toggles and notification prefs; roamed fields
  ride `/prefs`.
- **Self-update** (ADR-0007) — the page polls its own served bytes and reloads
  itself when the asset id changes, deferring while a terminal is attached until
  the next resume. `index.html` and `term.html` each carry their own id.
- **Telemetry** (ADR-0006) — batched usage events POSTed to tmux-api's
  `/telemetry` intake, which owns attribution; the browser never says who it is.

## Not built yet

- **Virtualization** of the timeline, and the auto-fallback engine that would
  switch views on its own when the transcript stream is unavailable.
- **Global projects / sharing (Category 3 advanced):** grouping here is driven by
  the per-user `/api/layout` (create/move at the layout level). The multi-user
  global project store (member management, attach-mode, co-ownership, minting a
  global project on create) and the dir-picker create-project modal are not yet
  wired — a follow-up on top of this sidebar.
- Roadmap pillars **#3** (app shell) and **#5** (cluster-native deploy).
