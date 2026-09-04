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
| `/events`, `/prompt`, `/cancel`, `/earlier`, `/result`, `/pane`, `/keys`, `/commands`, `/search`, `/answer-text` | **session-events** (`TL_SESSION_EVENTS`, default `http://127.0.0.1:7685`) | verbatim — the service serves these at its root. The list is the prod IngressRoute's, prefix for prefix; a prefix missing here reaches ttyd's `location /` and answers 200 with the SPA's own index.html, so `res.json()` throws and the caller's catch returns an empty fallback with nothing logged |
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
  speaks ttyd's binary WS protocol. The Debian package installs it beside
  `index.html` (ADR-0013; the hand-run `deploy-v2.sh` is retired).
- **`public/` verbatim** — `sw.js`, `manifest.webmanifest` and the three icons,
  which Vite copies as static assets. In production these are served by
  clipboard-upload from its exact-path whitelist, and the Debian package installs
  them **from `frontend/`, not from here** (`release/manifest.go`). The two copies
  of each are byte-identical and `test/pwa.tap.test.ts` pins `sw.js` that way:
  this directory is the one Vite serves and the tests drive, so it is the natural
  place to edit and the one that does not ship. An edit to it alone passes the
  whole suite and changes nothing in production.

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
    lobby-api.ts         tmux-api client (sessions/layout/whoami/kill/
                         retitle/title/…)
    http.ts              The transport: a deadline on every request and
                         same-origin credentials. Without a deadline a fetch on
                         a half-open connection never settles, which is what a
                         phone hands us when the radio drops a socket
    focus-trap.ts        The modal dialog contract — Tab wraps at both ends,
                         focus lands on the dialog and returns to its opener.
                         Shared by Settings, Skills and the file preview
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
    title.ts             Normalizes a display TITLE: control characters to a
                         space, whitespace runs collapsed, capped at 64 code
                         points. Mirrors Go's slug.CleanTitle, which tmux-api
                         runs on every title it stores. It used to derive a
                         session NAME from the title too; ADR-0019 ended that
                         and session-id.ts mints the name instead
    session-id.ts        Mints a session's NAME: 12 characters of lowercase
                         Crockford base32 from crypto.getRandomValues, and the
                         test that says a name is one of ours. The name is an
                         opaque id that never moves (ADR-0019), minted here
                         because creating a session reaches no server. Mirrored
                         by tmux-api/sessionid.go, which the one-time migration
                         reads to tell a migrated session from a named one
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
    models.ts            Which model a new session starts on. Applied as
                         `/model <name>` down the prompt channel rather than as
                         a launch flag: a per-model command key would miss the
                         pre-warm pool and give up Claude's ~2.4s boot on every
                         model but the default
    first-prompt.ts      Delivering the FIRST prompt of a session created a
                         moment ago. A session tmux has made is reachable
                         seconds before the Claude in it is ready to read
                         anything, and POST /prompt answers 204 either way — so
                         each attempt asks session-events to HOLD until the pane
                         can take it (503 while it cannot), on top of the
                         700/1600/3000/6000 ladder, resuming at the line that
                         did not land. The last rung asks for no hold, so a pane
                         that never draws a prompt still gets the text
    new-commands.ts      Which new-session commands this box can actually run:
                         GET /new-commands is tmux-user-attach --probe run in
                         the session's own login shell, so a key with nothing
                         installed behind it is greyed out rather than offered
                         and handing back a session that dies on open. A key
                         the server said nothing about stays enabled
    mode.ts              Which features this box has: multiUser() reads the
                         /whoami flag (an older server sends none, which reads
                         as multi-user), canActAs() requires admin AND
                         multi-user — single-user has nobody to act as
    terminal-url.ts      ttyd `?arg=` POSITIONAL contract (incl. the foreign-
                         owner 4th arg, which the act-as target defaults into)
                         — red-line-class, unit-tested
  diagnostics/
    usage.ts             Data used: what the lobby cost THIS device in wire
                         bytes, so the question the 1.83 GB/24h measurement
                         answered offline can be asked on the device itself.
                         Three buckets measured from Navigation/Resource Timing;
                         the WebSocket and SSE streams are modelled, and labelled
                         as modelled wherever they are shown
    network.ts           Which network this device is on, so Data used can say
                         where a month went. The browser cannot say (Safari ships
                         no Network Information API, where it exists a wired
                         desktop reports "4g", and WebRTC host candidates are
                         mDNS-obfuscated), so the server names it from the address
                         a request arrives from — stamped on the /sessions poll
                         the app already makes. Past the staleness bound a window
                         folds as Unknown rather than as the network last seen
    connection.ts        Measures the link (Navigation Timing bytes/time + an
                         optional tiny RTT probe — navigator.connection does not
                         exist on iOS), classifies full/slow, remembers the
                         verdict per device for the NEXT load, and answers what
                         each lever should do. A pin always wins
    usage.ts             What the lobby cost this device, in wire bytes: three
                         buckets measured from Navigation/Resource Timing, two
                         (ttyd WS, SSE) modelled by diag.js and labelled as such
    status.ts            Connection status, PURE (ADR-0016): five channels
                         (terminal, transcript, session list, notifications,
                         build) in three states, plus `unknown` — which every
                         rule skips rather than counting as health or as fault.
                         Owns worst-of, the badge's word, the panel's verdict,
                         the per-channel mappings and `readConn`, the parser for
                         the terminal frame's `tl-conn` message
    status-store.ts      The live wiring: providers push in, transitions are
                         logged in memory for the life of the page (and into
                         diag.js's flight recorder, so an incident carries the
                         connection history behind it), and `check()` drives the
                         probes. Also `ConnectionControl`, what the panel is handed
    check.ts             Run check: every probe at once, each capped at 5s,
                         each row reported the moment it lands. A probe that
                         hangs is aborted and reported, never left running
    probes.ts            The five probes themselves. All read-only — /health and
                         GET /push-subscriptions are the only server calls, and
                         nothing is ever sent to a device
  terminal/              The terminal's own logic, lifted out of frontend/term.html
                         ahead of replacing the ttyd iframe with a native xterm
                         component. Every module here is PURE — no DOM, no xterm
                         import, no fetch, no timers it owns — so the rules can be
                         tested without a socket or a browser, which is the whole
                         reason they were extracted rather than moved. term.html
                         remains the source of truth until the port lands; where a
                         module knowingly differs, the divergence is argued in a
                         comment at the site
    reconnect.ts         The backoff ladder as a reducer: attempts, generations
                         (so a late /token or session answer cannot install a
                         socket nobody is waiting for), the 30s proof that only
                         resets the ladder once a connection has held, and the
                         manual Reconnect tap, which fires from ANY phase
    liveness.ts          The half-open-socket watchdog. A black-holed socket
                         stays readyState OPEN forever, so this probes on two
                         independent signals rather than waiting for a close that
                         never comes — and a settling probe consumes any pending
                         request, or a tab-return fires a second probe on top of
                         the first
    battery.ts           Hidden-tab suspend and resume: when to take the socket
                         down on purpose, and the guard that a VISIBLE tab is
                         never suspended by a timer queued before it was shown
    keys.ts              The keyboard: which keys the terminal never sees, and
                         what an armed soft modifier does to the ones it does.
                         Ctrl+C is gated on the selection RANGE, not on the text
                         it yields, because xterm right-trims rows (ADR-0003)
    mirror.ts            The compose mirror. A visible textarea kept as a
                         transparent mirror of the pty's input line, so a phone
                         keyboard's autocorrect, dictation and swipe typing can
                         reach a terminal. PASSIVE by construction: it forwards a
                         delta and never clears its own value, because clearing
                         is what kills predictive text
    touchscroll.ts       One finger's drag turned into discrete LINE wheels, and
                         the lift-off momentum. The only way to scroll a terminal
                         with a finger: a pixel delta does not make tmux enter
                         copy-mode, and a line wheel does
    wheel.ts             The desktop counterpart: a trackpad's pixel-delta stream
                         de-damped into paced one-row line wheels, with the pref
                         that detaches it
    emit.ts              The one synthetic-wheel primitive both scrollers share
                         (term.html:6105-6113), the clientY they both carry
                         (scrollLastEmitY, :6087, seeded 100 and written only by
                         the touch path), the per-frame cap at :6082 that
                         touchscroll.ts and wheel.ts each declared a copy of,
                         and the lazy-per-field .xterm-screen read that lets one
                         measurement serve both worlds without measuring a field
                         nobody read. Takes a MeasureScreen callback rather than
                         querying the DOM, so the block's PURE claim above still
                         holds and the querySelector stays in TerminalNative
    viewport.ts          How much of the terminal's box a soft keyboard covers,
                         and therefore what height the host should have. NOT
                         src/mobile/viewport.ts, which is the lobby's own; this
                         one's header says which owns what
    attention.ts         Bell and output-while-hidden: what deserves the lobby's
                         notice, and the one-shot per hidden period that stops
                         ten frames behind a hidden view becoming ten signals.
                         NOT src/notify/attention.ts, which consumes the signal
    held.ts              Offline typing — what happens to a keystroke while the
                         socket is down, as a reducer over the verdicts term.html
                         names (held, popped, closed, reopened). Rendering the
                         glyphs stays with the component; only the decisions live
                         here
    wire.ts              The ttyd frame format, bytes in and bytes out, with the
                         input choke point that drops a watcher's keystrokes
                         before they reach the pty. Red-line class: its tests
                         assert actual byte layouts
    font.ts              Font-step arithmetic and pinch-scale classification, DOM
                         free
    fit.ts               Whether xterm may be re-fitted to its host right now.
                         A CSS-hidden session's host measures 0x0, and fitting
                         into that drags the real tmux window down to 13
                         columns, so a zero-size fit is skipped and recorded as
                         OWED, then replayed when the view comes back
    selection.ts         What copy does with a selection, and why Ctrl+C must be
                         gated on the selection RANGE rather than on the text it
                         yields — xterm right-trims rows, so a drag into trailing
                         whitespace otherwise sends SIGINT with a highlight on
                         screen (ADR-0003)
    dragselect.ts        Plain-drag text selection inside a pane that is
                         reporting mouse events. Wiring `term.onBinary` is what
                         turns reporting on, and xterm then selects only when
                         Shift, or Option on a Mac, is held; so a plain left
                         press over `.xterm-screen` is swallowed at document
                         capture and re-dispatched as a clone carrying that
                         modifier. Pure: pointer facts in, actions out
    attach.ts            The one IMPURE module here: it owns the socket, the
                         timers and nothing else. Every edge decision it takes it
                         asks reconnect.ts for — an event goes into reduce(), and
                         this carries out the actions that come back. The
                         generation check on each socket handler is what stops an
                         abandoned attempt's close from knocking its replacement
                         off the ladder
    theme.ts             The app's CSS custom properties mapped to an xterm
                         ITheme, plus the two re-read triggers a component owes
                         it (an explicit pick, and an OS light/dark flip while the
                         stored theme is "system")
  sse/client.ts          Resumable SSE client (Last-Event-ID, backoff+jitter,
                         instant-retry on visible/online) — DOM-free, testable.
                         Resyncs when `ready` names a log it was not reading:
                         ids are per-transcript, so a session whose transcript
                         was replaced would otherwise resume above the new log
                         and freeze on the old conversation
  store/
    session.ts           SSE → Solid store of events + prompt/cancel control
    catalogue.ts         Reads GET /commands into {commands, ok}. `ok` exists
                         because an empty list means two different things — a
                         user with no skills, or a route that answered with
                         index.html — and the `/` menu has to say which it got
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
    prompt-line.ts       Per-browser first-lines (tl:session-prompt-line:v1):
                         what a card reads between being created and Claude's
                         summary landing. Deliberately not stamped as @title —
                         the auto-title rule only fires while @title is unset,
                         so stamping it would freeze the placeholder in place
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
    TerminalNative.tsx   The terminal rendered by this app instead of by the
                         ttyd iframe, behind `?native=1`. Mounts xterm (a lazy
                         import, so it lands in its own immutable chunk), wires
                         terminal/attach.ts to it, and reports the ladder's phase
                         into the connection badge. Attaches, reconnects, types,
                         pastes through `term.paste`, reports the mouse, fits
                         through the guard, says why a keystroke was refused,
                         and takes the forwarded soft-keyboard height off its
                         own host (`__tlKeyboardOffset`). The rest of that
                         viewport work is still term.html's: its `syncViewport`
                         also reads the page's own visualViewport and subtracts
                         the toolbar and compose-bar heights, and none of that
                         is ported. Nor are the compose mirror, selection, touch
                         scroll, pinch-zoom, links, the bell or the held-key
                         overlay, so term.html stays the shipped terminal until
                         parity is proven. Sixel is not on that list: it was
                         deprecated in the same change (ADR-0004), so it is
                         nobody's to port
    StatusDot.tsx        The connection badge (ADR-0016). Dot always, a word
                         only when something is wrong. One component in two
                         places, each SCOPED to the channels its surface can
                         honestly report — the session bar has all five, the
                         sidebar header the three a list screen can answer for.
                         Tapping it opens Settings → Network
    ToolIcon.tsx         Which command the session runs (tmux-api `tool`)
    NewSessionComposer.tsx
                         The new-session composer: a prompt field plus the three
                         choices a create makes — project, command, model. What
                         you type becomes the session's first prompt; the name
                         is a minted id and the title is Claude's own summary of
                         the conversation. Choosing `shell` turns it back into a
                         name box, because a shell has no prompt to receive
    OrderMenu.tsx        The header's ordering picker (manual / created / active)
    menu.ts              The ⋯ popup: poll hold + Escape/outside-press dismiss
    lobby.logic.ts       PURE sidebar derivation + layout transforms (unit-tested)
    order.logic.ts       PURE session ordering: newest-first by created or by
                         last DRIVEN time (never session_activity, which a
                         read-only attach bumps), and the capture that freezes
                         the visible order into the layout when a drag hands the
                         list back to manual
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
    Composer.tsx         The LIVE session's composer: the permission panel,
                         queued-prompt chips, the mode chip, the context meter
                         and Stop, docked around PromptField
    PromptField.tsx      The writing surface both composers share: multi-line
                         with Enter to send and Shift+Enter for a newline, `/`
                         and `@` completion, the attachment tray, the unsent
                         draft, ↑ history, and the mobile input attributes that
                         restore QuickType and swipe typing
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
    SettingsPanel.tsx    Settings overlay: the shell only — the category
                         rail, which page is showing, and the dialog contract
                         (aria-modal, a wrapping Tab trap, Escape, focus back
                         to the opener). Every page is a file under settings/
    settings/
      rail.ts            The rail's model: which pages exist, in what order,
                         which of them start a group, and which page a
                         remembered id resolves to (an admin-only entry read
                         back by a non-admin falls to the first)
      stepper.ts         − / value / + arithmetic for the three text controls:
                         step-index maths so 0.05 steps do not drift, and an
                         off-grid value moves to the next grid point
      RightNow.tsx       The connection panel (ADR-0016), rendered as the
                         Network page's first group: a verdict sentence, one row
                         per channel with its state, what it dropped since this
                         page loaded and the last check's timing, Run check, and
                         a repair on any row that has one. Nothing here
                         reconnects anything on its own
      controls.tsx       The row grammar every page is built from — Row (label
                         left, control right, ⓘ that expands in place, a
                         "this device" chip on what does not roam), Toggle,
                         Stepper, Segmented, Readout, Group
      pages/
        AppearancePage.tsx    The nine themes as swatch cards painting their own
                              colours; "System" follows the OS live
        TerminalPage.tsx      Font size, line height, letter spacing, bold
                              weight, cursor, scrolling, link copy chip, and
                              flow control
        SessionsPage.tsx      New-session command, session-list last-active time
        KeyboardPage.tsx      The app-shortcut layer's opt-out, and the four
                              chords that outlive it
        NotificationsPage.tsx The two roamed toggles, this device's permission /
                              subscription / bell readouts, and the two tests
        NetworkPage.tsx       The Full/Auto/Light link pin and which network you
                              are on, then "Data used" — this device's wire
                              bytes by period, by named network, by feature
        PrivacyPage.tsx       Send diagnostics, and Clear local data with the
                              roamed-settings opt-in
        ActAsPage.tsx         The admin act-as picker; renders for an admin only
        SkillsPage.tsx        The Skills surface (docs/adr/0011), a rail page
                              since 2026-08-30: a tab per list — this account's
                              skills, each other account's with a same/differs
                              verdict, the marketplace plugins, the live
                              sessions — a name/description filter, and the
                              install / replace-with-backup / disable / remove /
                              update / restart actions, plus the two permanent
                              ones — Delete (the skill and every backup of it)
                              and Uninstall (a plugin and its files). Every
                              action is ON the row for both lists; expanding one
                              shows that skill's SKILL.md — your own in an
                              editor that writes it back, a peer's read-only.
                              Also the owner/repo field: one read-only look
                              decides whether a repo offers skills, a plugin
                              marketplace or both, then the ecosystem's own
                              installer runs as you (docs/adr/0012). It was a
                              group inside the old 420px Settings column,
                              outgrew it into its own overlay in August 2026,
                              and came back as a rail page with the room that
                              overlay was for
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
    appbadge.ts          PWA icon badge — how many sessions are waiting
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
    softkeys-reserve.ts  body.has-soft-keys, the height both views reserve for
                         the toolbar and the keyboard. Installed once per APP:
                         SessionView is mounted once per kept session, so a
                         writer there let the first session closed take the
                         reservation from every other one
    viewport.ts          visualViewport → CSS var so the keyboard can't cover
    reveal.ts            Re-scrolls the focused field into view once the
                         keyboard STOPS moving. The browser's own attempt runs
                         against the geometry from before it opened, which is
                         how a project's new-session box ended up under it
    textzoom.ts          Pinch to size the TEXT view, the way it sizes the
                         terminal. Both recognizers ported from term.html —
                         Chromium measures the two-finger span itself, WebKit
                         gets the ratio from GestureEvent — so one gesture, the
                         same 7%-per-step arithmetic, in both views. It scales
                         FONT SIZES: every font-size in app.css multiplies by
                         --tl-text-scale, set on .tl-textview, so transcript,
                         answer card and composer move together
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
    attach-files.ts      Upload files into a session's store and hand back the
                         tray chips. Shared by the two composers, which do it at
                         different moments: the live one when a file is picked,
                         the new-session one after the create, because until
                         then there is no session to own the file
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
- **Notifications** — tab-title, favicon and **app-icon** badges, attention
  latches from the terminal iframe, foreground OS notifications on state edges,
  and background **Web Push** via `/sw.js` + `/api/sessions/push/*` when the
  browser and the server's VAPID key allow it. A tap routes to the session that
  called (ADR-0014).
- **Mobile** — a coarse-pointer soft-key toolbar (raw byte sequences a phone
  keyboard cannot produce), soft Ctrl/Alt modifiers, and visualViewport
  plumbing so the soft keyboard cannot cover the composer.
- **Settings** — one overlay, navigated by a category rail with a single page
  showing: Appearance, Terminal, Sessions, Keyboard, Notifications, Network,
  Privacy, then Skills, then Act as user for an admin. ↑↓ walk the rail, Enter
  steps into the page, and it reopens where you left it (`tl:settings:page`,
  per device). Each row is label-left/control-right; explanations sit behind a
  ⓘ that expands in place, except the three that describe a consequence
  (acting as another user, clearing local data, what diagnostics send). A
  `this device` chip marks what does not roam — everything unmarked rides
  `/prefs`. Notable rows: the nine themes as swatch cards painting their own
  colours (per-device), terminal font size (roamed + dual-written for the ttyd
  page), the session-list last-active time (`sidebar.showLastActive`, roamed,
  **off by default** — it hides the relative "5m ago", never a running
  session's live working timer), and the new-session command. **Network**
  carries **Data used** — what the lobby cost THIS browser profile in bytes
  that crossed the link, for today, the last 7 days and the last two calendar
  months, split into five feature buckets and by named network, with the
  Full/Auto/Light experience pin for this device. Counting continues while
  "Send diagnostics" is off: that toggle governs sending, and the counter never
  leaves the browser (docs/adr/0008).
- **Skills** (docs/adr/0011) — a page on that rail, reachable in one click from
  its own header button, which opens Settings straight onto it. A tab per list
  with a count — this account's skills, each other account's with a
  same/differs verdict, the marketplace plugins, the live sessions — a
  name/description filter, and install / replace-with-backup / disable /
  remove / update / restart on the row itself.
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
