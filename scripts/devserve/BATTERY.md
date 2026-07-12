# Regression battery — terminal-lobby frontend

Canonical checklist for verifying `frontend/index.html` changes against a real
browser (Playwright) + real ttyd + real tmux, via the local harness. Section A
is the **red-line battery** — the untouchable mouse/wheel/selection/scroll
contracts (ADR-0003, alt-screen scrolling, OSC52, sixel, the 6px mobile
tap-vs-swipe path). Section B accumulates per-feature acceptance checks.

Run §A after **every wave** of changes and **before any deploy**. Run the §B
lines relevant to what changed; the full §B at wave gates.

## How to run

```sh
python3 scripts/dev-harness.py        # scratch mode is the default
```

- The harness proxies the production routing on `http://127.0.0.1:7997`
  (`/api/sessions/*` → tmux-api, `/clipboard/*` → clipboard-upload, everything
  else incl. the WebSocket → a local ttyd child) and serves a stamped build of
  the frontend (`terminal-lobby build: DEV-<sha>` in the console — assert it to
  know which build the browser actually loaded).
- The ttyd child attaches an **isolated scratch tmux server**
  (`tmux -L tl-dev`, session `main`), torn down when the harness exits. The
  terminal you type into never touches the real tmux server.
- Battery runs drive the **OUTER lobby page top-level**
  (`http://127.0.0.1:7997/#main` — the `#<session>` hash auto-attaches), never
  the iframe URL (`/?arg=…`) directly. That is exactly the prod shape (the
  terminal is an iframe INSIDE the lobby), so title/focus/visibility paths are
  the real ones.
- Shell commands for battery items go into the scratch pane:
  `tmux -L tl-dev send-keys -t main '<cmd>' Enter`; inspect with
  `tmux -L tl-dev capture-pane -p -t main`.
- To reach the page's closed-over `term` instance, use the init-script Proxy
  recipe in `scripts/dev-harness.md` (captures it as `window.__term` in the
  terminal iframe). Grant `clipboard-read` + `clipboard-write` in the test
  context.
- **Finding the terminal iframe (M.6 lesson):** since Task M.3 the lobby
  swaps sessions via `contentWindow.location.replace`, and Playwright's
  `frame.url` cache can stay stale (`about:blank`) across those swaps —
  identify the frame by CONTENT
  (`frame.evaluate("location.search.includes('arg=')")` + a readiness
  probe), never by `frame.url`, and re-acquire the handle after every
  session switch (the swap destroys the old execution context).
- **Golden baseline** (unmodified frontend, captured at Task 0.1):
  screenshots in `scripts/devserve/baseline/` (gitignored, local-only —
  re-capture by running §A on a clean master checkout if missing). Compare
  against them.

## PRODUCTION-SERVICE ISOLATION (read before any lobby session action)

`/api/sessions/*` and `/clipboard/*` are proxied to the **live** tmux-api
(:7684) and clipboard-upload (:7683) — production services operating on the
REAL default tmux server for real users. tmux-api cannot target the scratch
`-L tl-dev` socket without invasive changes (it shells out to plain `tmux`,
per-user via sudo), so:

- Battery steps MUST NOT create, rename, or kill lobby sessions except with
  names prefixed `tl-battery-` — and MUST clean those up before the run ends
  (kill button or `DELETE /api/sessions/sessions/<name>` — the frontend's
  SESSIONS_API base is `/api/sessions/sessions`: tmux-api's per-name route
  lives at `/sessions/<name>` UNDER the stripped `/api/sessions` proxy
  prefix, so the doubled segment is correct, not a typo).
- Never touch sessions you didn't create. The session cards in the lobby are
  real. (Merely *attaching* a card is safe: the harness ttyd command is fixed,
  ignores the URL arg, and always attaches scratch `main`.)
- Before/after every battery run: `tmux ls` (default server) must list the
  same session names.
- Settings-panel changes PUT the **live roamed `/prefs` doc** for `--user`
  (400 ms debounce) — an aborted run leaves e.g. `gestures.bottomSheet=false`
  roaming to the user's real devices (bit us 2026-07-12). Any battery leg
  that flips panel toggles must `GET /prefs` (header
  `X-Authentik-Username: <user>`) before the run and `PUT` the snapshot back
  after — or point the harness at a scratch tmux-api (Task 2.6 recipe).

## A. Red-line battery (run after EVERY wave and before deploy)

Every item asserts behavior identical to the golden baseline. Any deviation is
a stop-the-line failure.

### A.1 — 1003h any-motion mode: drag-selection survives buttonless motion

1. `tmux -L tl-dev send-keys -t main "stty -icanon -echo -isig min 1 time 0; printf '\e[?1003h\e[?1006h'; cat -v" Enter`
   (pane requests all-motion SGR mouse reports and echoes every byte it
   receives as VISIBLE text — the mouse-report leak sensor documented in
   `scripts/dev-harness.md`. Plain `cat` cannot produce a countable echo:
   canonical mode buffers input until newline and a raw ESC re-interprets
   instead of printing, so step 4's `^[` count never moves. `-isig` keeps
   Ctrl+C from killing `cat` and makes a leaked `^C` visible. Do NOT
   `clear` first: the drag-select in step 2 needs on-screen text.)
2. In Playwright, drag-select over visible text on the terminal (mouse down →
   move a few cells → up).
   **Expect:** `window.__term.hasSelection()` → `true`.
3. Move the pointer buttonless over `.xterm-screen` — a **trusted** move
   (Playwright `page.mouse.move`), NOT a JS `dispatchEvent` clone: the swallow
   guards `isTrusted` moves only and deliberately passes untrusted clones
   through (they are the frontend's own selection machinery — an untrusted
   move WILL be reported, the pane echoes it as visible `^[[<35;…` text, and
   that output clears the selection).
   **Expect:** the selection **survives** AND the `^[[<` count in
   `tmux -L tl-dev capture-pane -p -J -S -400 -t main` is unchanged across
   the move (the xterm#7378 buttonless-motion swallow: no motion report
   reaches the pane while a selection exists).
4. Press Escape.
   **Expect:** selection clears AND the key reaches the app — flow restored
   (the capture shows one more bare `^[` than before the keypress).
5. Cleanup: `tmux -L tl-dev respawn-pane -k -t main` (raw `-isig` stty means
   Ctrl+C cannot end `cat -v`; respawning the scratch pane kills it, resets
   the tty/mouse modes, and starts a fresh shell — scratch server only,
   never a real pane).

### A.2 — Alt-screen wheel scrolling

Verified reality of this tmux config (oh-my-tmux; refines the plan's draft
item): `root WheelUpPane` = forward to the app if it enabled mouse, else
`copy-mode -e`; there is NO `root WheelDownPane` binding, so wheel-down over a
non-mouse alt-screen pane is a no-op by design. Both halves below are the
contract:

1. **Mouse-enabled alt-screen app (the Claude Code-shaped path):**
   `tmux -L tl-dev send-keys -t main "less --mouse /etc/services" Enter`;
   capture-pane → snapshot BEFORE; dispatch `wheel` down ticks over the
   terminal (Playwright `mouse.wheel`); capture-pane again.
   **Expect:** the viewport **moved** — content changed (wheel reports
   forwarded to the app, which scrolls itself). Cleanup: send `q`.
2. **Non-mouse alt-screen app fallback:**
   `tmux -L tl-dev send-keys -t main "less /etc/services" Enter`; dispatch
   wheel **up** ticks over the terminal.
   **Expect:** tmux enters copy-mode
   (`tmux -L tl-dev display -p -t main '#{pane_in_mode}'` → `1`).
   Cleanup: `tmux -L tl-dev send-keys -t main -X cancel`, then `q`.

### A.3 — OSC52 copy flow

1. At the shell prompt, echo some text; drag-select part of it.
2. Trigger the copy chord: Ctrl+C (Cmd+C under Mac emulation) with the
   selection active.
   **Expect:** "Copied" toast appears (`#toast.visible` in the terminal
   iframe) and the clipboard holds the selected text.

### A.4 — Sixel image render

1. `tmux -L tl-dev send-keys -t main "clear; viu -w 20 <repo>/frontend/icon-192.png" Enter`.
2. Screenshot the terminal; crop the image region (top-left ≈250×250 px after
   `clear`).
   **Expect:** ≥100 distinct colors in the crop = real sixel render. (A
   unicode-block placeholder fallback measures ≤40 distinct colors, per stored
   calibration.)

### A.5 — Mobile tap-vs-swipe + keyboard offset plumbing

1. Emulate an iPhone-class viewport (390×844, touch). Load the lobby
   top-level, attach `#main`. Make scrollback (e.g. `seq 1 200`).
2. Dispatch a single-touch swipe over the terminal: `touchstart` →
   `touchmove`s with total ΔY well above the 6px threshold → `touchend`.
   **Expect:** the tap-vs-swipe logic converts motion to synthetic wheel
   events — tmux scrolls (`tmux -L tl-dev display -p -t main '#{pane_in_mode}'`
   → `1`, copy-mode entered) and the swipe does NOT focus/summon the keyboard.
3. Dispatch a tap (touchstart → touchend, ΔY ≤ 6 px). Three sub-legs
   since M.11 (tap FOCUS routes per `compose.tapFocus`; tap byte
   semantics — no pty bytes, no scroll — identical in all three):
   - **3a** bar hidden (`compose.show:'off'` seeded, or after ⌄):
     **Expect:** the terminal focuses (helper textarea → soft keyboard
     path) — verbatim the pre-M.11 leg.
   - **3b** bar visible + defaults (`show:'auto'`, `tapFocus:'compose'`):
     **Expect:** `#compose-input` becomes the activeElement, capture-pane
     UNCHANGED (the tap sends no bytes); a >6px swipe in the same state
     still wheels (copy-mode scrolls) with NO focus change.
   - **3c** bar visible + `tapFocus:'terminal'`:
     **Expect:** the helper textarea focuses — 3a behavior with the bar
     open.
4. Code-inspect the loaded page: the `--kb-offset` visualViewport plumbing is
   present and wired (syncViewport updates
   `documentElement.style --kb-offset` from `window.visualViewport`).
5. Cleanup: `tmux -L tl-dev send-keys -t main -X cancel` (exit copy-mode).

### A.6 — Bracketed paste

1. Desktop context, shell prompt. Write multi-line text to the clipboard,
   e.g. `echo one\necho two\necho three`.
2. Focus the terminal; press Ctrl+V (`page.keyboard`).
   **Expect:** all lines arrive as ONE bracketed paste — capture-pane shows
   the block at the prompt and NO execution of intermediate lines (no lone
   `one`/`two` output line).
3. Cleanup: C-c to discard the pending input.

## B. Feature acceptance (grows with each wave)

Each task appends its acceptance line(s) here **in the same commit** that
implements the feature. Format:
`- [Task N.M] <exact check> → <expected result>`.

- [Task 1.1] In the terminal iframe: `document.fonts.check('15px "JetBrains Mono"')`
  → `true`, AND for **each** of `✢ ✳ ✻ ✽ ⏺ ⎿ ✔ ☐ ☒ ⏵ ◼ ※ ⠋`:
  `document.fonts.check('15px "TL Symbols"', ch)` → `true`.
- [Task 1.1] Echo the glyph battery into the pty
  (`tmux -L tl-dev send-keys -t main "echo '✢ ✳ ✻ ✽ ⏺ ⎿ ✔ ☐ ☒ ⏵ ◼ ※ ⠋ ─│┌┐└┘├┤╭╮╯╰ ▀▄█░▒▓ '" Enter`),
  screenshot → **zero tofu boxes** (compare against baseline: pre-webfont
  rendering depended on OS fallbacks).
- [Task 1.1] Metrics guard (the webfont must not shrink the grid): at a
  390×844 portrait viewport record cols×rows before/after the webfont →
  cols **unchanged** (measured 41→41; JBM 'W' advance 9.000px ≤ OS-mono
  9.031px at 15px, so cols cannot regress). Rows may shrink slightly with
  JBM's taller line box (measured 27→23 — the "font metrics shift cols/rows
  slightly — intended" note in the plan's deploy heads-up). 80-col floor
  where geometry allows it: 844×390 landscape, sidebar collapsed →
  cols **≥80** (measured 92). *Deviation from the plan's "cols ≥80
  portrait": arithmetically impossible at fontSize 15 — 390px ÷ ~9px/cell
  ≈ 43 cols with ANY mono face; adapted to no-cols-regression portrait +
  the achievable landscape floor.*
- [Task 1.1] Box-drawing alignment (`├──` tree, Claude Code box borders)
  intact at fontSize 15 **and** at the stepper extremes 10 and 22 (until
  Task 1.8 lands, drive via `window.__term.options.fontSize = N`).
- [Task 1.2] Lobby chrome font: `document.fonts.check('14px "DM Sans Variable"')`
  → `true` and `getComputedStyle(document.getElementById('lobby')).fontFamily`
  starts with `"DM Sans Variable"` (popup menus + toast + gallery panel
  likewise). Terminal untouched: in the iframe, `window.__term.options.fontFamily`
  still starts `'JetBrains Mono'` and contains NO DM Sans; #soft-keys and the
  drop overlay stay on `var(--font-mono)`. Screenshot the lobby.
- [Task 1.3] Dim-text contrast: `window.__term.options.minimumContrastRatio`
  → `4.5`; on the `ink` (light) theme,
  `tmux -L tl-dev send-keys -t main "printf '\e[2mdim sample\e[0m normal\n'" Enter`
  → screenshot: the dim run is READABLE against the light background but
  still visibly dimmer than the adjacent normal text (xterm holds dim to
  half-ratio).
- [Task 1.3] Selected-text readability eyeball on all four themes
  (carbon/slate/mono/ink): emit colored output
  (`for i in $(seq 30 37); do printf "\e[${i}mcolor$i \e[0m"; done`), drag a
  selection across it → glyphs stay legible inside the selection overlay
  (contrast adjustment interacts with selectionBackground). Box/block glyphs
  (`│ █ ▓`) keep exact theme colors — excluded from the adjustment.
- [Task 1.3] Inactive cursor: `window.__term.options.cursorInactiveStyle` →
  `'outline'`; blur the terminal (focus the lobby sidebar) → cursor renders
  as a hollow outline, not a solid block; refocus → solid blinking block
  returns.
- [Task 1.3] Bold weight: `window.__term.options.fontWeight` → `'400'` and
  `fontWeightBold` → `'700'`;
  `tmux -L tl-dev send-keys -t main "printf 'normal \e[1mbold\e[0m\n'" Enter`
  → screenshot: bold run renders in the real JBM 700 face (heavier, same
  cell width — no faux-bold smear/overflow).
- [Task 1.3] Atlas-recovery listener: in the terminal iframe run
  `document.dispatchEvent(new Event('visibilitychange'))` (document is
  visible, so the handler calls `clearTextureAtlas`) → no console error and
  the terminal still renders (screenshot matches pre-dispatch).
- [Task 1.4] Unicode 11 widths: iframe console shows
  `unicode11 addon loaded (active version 11)` and
  `window.__term.unicode.activeVersion` → `'11'`. Then
  `tmux -L tl-dev send-keys -t main "echo '🙂🙂🙂 ├── test'" Enter` →
  screenshot: emoji render double-width and the `├──` tree stays aligned
  with tmux's wcwidth — no one-cell drift/overlap after the emoji (the
  built-in Unicode 6 tables count 🙂 as width 1 while tmux counts 2).
- [Task 1.5] Full ITheme emission: in the terminal iframe
  `window.__term.options.theme` → carries all 16 `black…brightWhite` keys
  plus `cursorAccent`, each equal to the active theme's
  `--terminal-ansi-*` / `--terminal-cursor-accent` computed value; the
  original `background/foreground/cursor/selectionBackground` values are
  **byte-identical** to their pre-task values on every theme (red line:
  selection color untouched).
- [Task 1.5] ANSI swatches: on EACH of carbon/slate/mono/ink run
  `tmux -L tl-dev send-keys -t main 'for i in $(seq 30 37) $(seq 90 97); do printf "\e[${i}m█ "; done; printf "\e[0m\n"' Enter`
  → screenshot: 16 mutually distinguishable swatches in the T3-seeded
  palette (NOT xterm's stock VGA — stock red is the #cd0000 class), all
  colors legible against the theme bg. On ink the row renders the dark
  T3-light-seeded set — colors 30-37/90-97 visible on the light
  background; the white/bright-white NEUTRALS sit near-bg by design
  (they are a light theme's "paper" colors, and █ block glyphs are
  excluded from the minimum-contrast adjustment). Verified 2026-07-11
  on ink: 14 chromatic swatches + dark black pair all clearly visible.
- [Task 1.6] New presets: for each of t3-dark / t3-light /
  catppuccin-mocha / catppuccin-latte — click its picker button → lobby
  chrome re-themes (body class `theme-<name>`, sidebar/cards/accent
  change) and the attached terminal re-themes after the iframe reload;
  run the Task 1.5 swatch line → screenshot: terminal bg + 16 swatches
  match the preset (t3-dark bg #161616, t3-light bg #ffffff, mocha bg
  #1e1e2e with pastel swatches, latte bg #eff1f5).
- [Task 1.6] System auto-follow: click "System" (persists
  `tmux-theme=system`), emulate the OS scheme (Playwright
  `page.emulateMedia({colorScheme:'dark'})`) → body carries
  `theme-t3-dark` AND `meta[name=theme-color]` content is `#161616`;
  flip to `light` → `theme-t3-light` + `#ffffff` with NO user action
  (the terminal iframe reloads itself to re-read xterm colors — the
  reload path holds until Task 1.7's live switch replaces it).
- [Task 1.6] Pre-paint boot: with `tmux-theme=catppuccin-latte` in
  localStorage a fresh top-level load already has body class
  `theme-catppuccin-latte` at `DOMContentLoaded` (no dark→light flash:
  the boot script is body's first child) and `meta[name=theme-color]`
  equals the theme's `--bg-page` (#eff1f5). With localStorage UNSET →
  `theme-slate` and meta `#0d1117` (historical default — zero change
  for users who never picked a theme).
- [Task 1.7] Live switch, no reload: attach `#main`, make output + an
  ACTIVE drag-selection; click a different theme in the picker →
  `window.__term.options.theme.background` equals the new theme's
  `--terminal-bg` computed value, the selection **survives**
  (`window.__term.hasSelection()` → `true`), and the iframe did NOT
  reload (instrument before the click:
  `frameEl.contentWindow.__tlMark = 1` → still `1` after; a reload
  would wipe it). Then §A.1 (1003h swallow) and §A.2 (alt-screen
  wheel) pass post-switch.
- [Task 1.7] Mid-`less` switch: with `less --mouse /etc/services` open
  and scrolled mid-file, switch theme → colors change live, viewport
  position unchanged (`tmux -L tl-dev capture-pane -p` before/after
  identical), no reload (`__tlMark` intact).
- [Task 1.7] ACK fallback (stale-build path): in the iframe set
  `window.__tlSuppressThemeAck = true` (battery hook that swallows the
  ACK), click a theme → after ~1s the iframe reloads into the new theme
  (old path: `__tlMark` gone, build stamp logged again, terminal
  reattaches).
- [Task 1.7] System auto-follow is now live: with `tmux-theme=system`,
  `page.emulateMedia({colorScheme:...})` flips re-theme the terminal
  WITHOUT an iframe reload (supersedes the reload expectation recorded
  in the Task 1.6 line — `__tlThemeLive` replaces it; `__tlMark`
  survives the flip).
- **[SUPERSEDE NOTE for the Task 1.5-1.8 lines above — MF-1,
  2026-07-12]** Since the MF-1 commit ("theme picker moved into the
  settings panel") the picker lives in the ⚙ settings panel as the
  `#sp-theme` grid: read every "click … in the picker" above as "click …
  in the settings-panel theme grid" (open ⚙ first — same
  selectTheme/tl-theme path, all assertions unchanged).
  `.theme-picker-label` is gone — the T3 group-label metric (10px
  uppercase .08em, Task 2.8) now applies to the panel's `.sp-title`. The
  sidebar `A−`/`A+` font row is gone too: the Task 1.8 "sidebar `A+`"
  steps now mean the settings-panel Font size `A−`/`A+` (same
  stepFontSize/prefs path). Acceptance for the move itself: [C4].
- [Task 1.8] Stepper shrinks the grid: attach `#main`, record
  `tmux -L tl-dev display -p '#{client_width}x#{client_height}'`; click
  the sidebar `A+` TWICE (15→17) → `window.__term.options.fontSize`
  increments each click AND the tmux client grid SHRINKS through the
  normal fit/sendResize path (measured 111x36 @15 → 100x32 @17). A
  single step can be width-neutral — JBM's floored cell width is 9px
  at BOTH 15 and 16 (only rows shrink on that step, 36→34) — so
  assert on the two-click delta, not per-click. The floating `A−`
  inside the terminal steps back down (grid recovers, sidebar readout
  tracks via the storage event). No iframe reload either way
  (`__tlMark` survives).
- [Task 1.8] Clamp: hold `A−` down to the floor → `fontSize` stops at
  **10**; hold `A+` to the ceiling → stops at **22**; localStorage
  `tl-font-size` never leaves [10, 22]; garbage in the key (e.g.
  `"huge"`) → next boot falls back to 15, no crash.
- [Task 1.8] Persistence: set size 18, reload the top-level page →
  the terminal boots at 18 (`window.__term.options.fontSize` → 18,
  constructor read — no postMessage involved) and the sidebar readout
  shows 18.
- [Task 1.8] Box redraw stays aligned: at sizes 12 and 20 run a
  Claude-style box
  (`tmux -L tl-dev send-keys -t main "printf '╭──────╮\n│ box  │\n╰──────╯\n'" Enter`)
  → screenshot: borders align, no ragged right edge (tmux redraws to
  the new cols/rows; same class of check as the Task 1.1 extremes
  line).
- [Task 1.9] Window padding geometry — NOTE the padding lives on
  `.xterm`, NOT `#terminal` (deviation from the plan text, measured
  live: FitAddon reads `#terminal`'s computed size raw, and Chrome
  resolves a border-box element's computed width/height to the BORDER
  box, so plan-placement padding produced a 36-row/720px canvas in a
  704px content box — bottom row clipped 8px. addon-fit@0.10.0
  explicitly subtracts `.xterm`'s own padding, so that is the
  supported spot). Checks, in the terminal iframe:
  `getComputedStyle(document.querySelector('.xterm')).padding` →
  `8px 10px`; `getComputedStyle(#terminal)` → `padding 0px`,
  `boxSizing border-box`, `backgroundColor` = the theme's
  `--terminal-bg`. `.xterm-screen`'s rect sits at inset (10, 8) from
  `#terminal` AND fits INSIDE the frame: `screen.bottom ≤
  terminal.bottom − 8`, `screen.right ≤ terminal.right − 10` (this
  pair is what caught the clip). No overflow: `scrollWidth ===
  clientWidth` and `scrollHeight === clientHeight` on the iframe's
  documentElement; same on the top-level page. Screenshot: grid inset
  in a theme-colored frame (verified 2026-07-11: 109×35 grid, screen
  981×700 @ (10,8) in a 1020×720 pane; baseline was 111×36 flush —
  the one-col/one-row cost is the padding, intended).
- [Task 1.9] **Red-line re-run REQUIRED: §A.1 + §A.2** (padding shifts
  the grid 10px right/8px down — the ADR-0003 pixel→cell replay is
  anchored to `.xterm-screen`'s LIVE rect and must self-correct;
  challenge-verified but verify anyway).
- [Task 1.9] Mobile keyboard path with padding: emulate 390×844 touch
  viewport (soft-keys active), focus the terminal (keyboard-open path —
  in the harness force it by shrinking the emulated `visualViewport` or
  dispatching its `resize` after a height override); `syncViewport()`
  sets an inline px height on `#terminal` (border-box, zero own
  padding → border edge lands exactly at visualViewport height −
  toolbar) → the prompt row stays visible above the keyboard, no
  horizontal scroll, and the LAST column is not clipped (echo a
  full-width ruler `printf '%*s' $(tmux -L tl-dev display -p '#{client_width}') '' | tr ' ' '='`
  → screenshot shows the closing `=` inside the padded frame).
- [Task 1.10] Lobby scrollbars: on a dark theme
  `getComputedStyle(sidebar, '::-webkit-scrollbar').width` → `6px` for
  `#lobby-sidebar` (make it scroll first: short window or many
  sessions), `#img-gallery .gallery-grid` and `.popup-menu`; thumb
  color = `rgba(255,255,255,0.1)` (hover `.18`), radius 3px,
  transparent track. Switch to a light theme (ink/t3-light/latte) →
  thumb flips to `rgba(0,0,0,0.15)`/hover `.25` (the
  `--scrollbar-thumb*` group override). Screenshot both.
- [Task 1.10] xterm slider keys (code-level): in the terminal iframe
  `window.__term.options.theme.scrollbarSliderBackground/
  HoverBackground/ActiveBackground` equal the theme's
  `--scrollbar-thumb/-hover/-active` computed values. EXPECTED
  RENDERING CHANGE ON 5.5.0: **none** — the pinned xterm's ITheme has
  no scrollbarSlider* keys (verified vs published typings; unknown
  keys are ignored), they pre-wire the deferred 6.x upgrade. The
  terminal's own scrollbar must render IDENTICAL to baseline
  (deliberately excluded from the ::-webkit-scrollbar restyle —
  custom-scrollbar mode could change the width xterm measured at
  open, a geometry red line).
- [Task 1.11] Grain is lobby-only: on the top-level lobby page
  `document.body.classList.contains('lobby')` → `true` and
  `getComputedStyle(document.body, '::after').backgroundImage` starts
  `url("data:image/svg+xml…feTurbulence…")` at opacity 0.035 /
  z-index 0; `getComputedStyle(#lobby-content).zIndex` → `1` (the
  terminal iframe pane paints ABOVE the grain). In the terminal
  IFRAME document: body has NO `lobby` class and
  `getComputedStyle(body, '::after').content` → `none` — the
  terminal/sixel canvas is never washed by grain. §A.4 (sixel) must
  render identically to baseline.
- [Task 1.11] Surfaces + radius scale: `.session-card` computed
  `borderRadius` `18px` and `boxShadow` = the scheme's
  `--surface-shadow` (dark: 5% drop + inset 0 1px white 6%; light
  themes: inset 0 -1px black 4%); `.popup-menu` radius `10px`,
  hairline `var(--border)` border, shadow = elevation drop + bevel;
  gallery panel radius `18px`; toast radius `8px` (measure `.toast-card` —
  since Task 2.7 `#toast` is the position-only stack viewport); `.new-row
  button` carries `inset 0 1px rgba(255,255,255,.16)` + an
  accent-tinted 24% drop, collapsing to `inset 0 1px rgba(0,0,0,.08)`
  while `:active`. Lobby screenshot on EVERY theme (grain over
  sidebar chrome, bevelled cards, no layout shift vs baseline beyond
  the radii).
- [Task 1.11] Loading skeletons: throttle the first `/sessions`
  response (`--delay /sessions=3` harness flag) and load the lobby →
  `#session-list` shows exactly 3 `.session-skeleton` shimmer cards
  (animation `skeleton 2s -1s infinite linear`, gradient over
  `--bg-card` with the scheme's `--skeleton-highlight`), then the
  first render replaces them with real cards (skeleton count drops
  to 0; no flash of "No sessions yet" before the response).
- [Task 1.12] Mobile viewport mechanisms (audit result — three already
  shipped, two safe-area fills added): viewport meta carries
  `interactive-widget=resizes-content`; `html, body` carry
  `overscroll-behavior: none` (every scrollable child — sidebar,
  gallery grid, popup menus, soft-keys row — chains only into that
  suppressed viewport); `#toast` computed `top`/`right` and
  `#lobby-sidebar` computed `padding` resolve to the baseline
  `16px 16px` / `20px 14px` at env()=0, and under a CDP
  `Emulation.setSafeAreaInsetsOverride` (top 50/left 40/right 30)
  grow to exactly `66px/46px` and `70px … 54px` — the toast and the
  sidebar header clear the notch/status bar; no other rule changes.
- [Task 1.12] §A.5 (tap-vs-swipe + `--kb-offset`) on BOTH an iOS-class
  (iPhone 12, 390×844) and an Android-class (Pixel 7) emulated
  viewport: swipe >6px → tmux copy-mode, no keyboard summon; tap →
  helper textarea focused; `--kb-offset` seeded on
  `documentElement.style`; `has-soft-keys` active under
  pointer:coarse. Default tmux server untouched before/after.
- [Task 1.13] SRI enforced on all 8 CDN tags (published non-`.min`
  paths, sha384 + `crossorigin="anonymous"`): full page load → each of
  xterm.css, xterm.js, addon-{fit,web-links,webgl,clipboard,image,
  unicode11}.js responds 200 with **zero** integrity console errors;
  `Terminal` + all six addon globals defined, unicode11 active,
  xterm.css rules applied, terminal echoes end-to-end. Enforcement
  proof: serve a copy with ONE flipped hash character on the xterm.js
  tag (out-of-tree copy — never edit the worktree file) → console
  logs "Failed to find a valid digest in the 'integrity' attribute"
  and `typeof Terminal === 'undefined'` (asset blocked); remove the
  copy. Hash respec rule: any version bump recomputes
  `curl -s <url> | openssl dgst -sha384 -binary | base64` fresh from
  the exact URL — never reuse a hash across versions or `.min`/non-min
  variants (jsdelivr-generated `.min` files are SRI-unsafe).
- [Task 1.14] Truecolor through tmux: with a browser client attached,
  `tmux -L tl-dev source-file devvm/tmux.conf.system` (the harness
  equivalent of the deploy-installed `/etc/tmux.conf` — same option,
  applied to new client attaches) then reload/attach fresh →
  `tmux -L tl-dev display -p '#{client_termfeatures}'` contains `RGB`,
  and the 77-cell 24-bit ramp
  (`awk 'BEGIN{for(i=0;i<77;i++){r=255-i*3;printf "\033[48;2;%d;%d;%dm ",r,i*3,i*2}print "\033[0m"}'`)
  screenshots as a SMOOTH gradient: ≥60 distinct colors on the ramp's
  pixel row (detect it as a vertically-constant row with ≥10 colors —
  pure backgrounds, no glyph antialiasing; text rows fail constancy).
  Measured 2026-07-11: 78 distinct fixed vs 13 banded baseline
  (the 256-cube collapses the ramp to ~12 values). WITHOUT the conf →
  no `RGB`, ~13 colors (that IS the shipped-config regression signal).
  Re-run the ramp on prod after deploy. Note: `Environment=
  COLORTERM=truecolor` on ttyd.service is inert on tmux 3.4 (verified
  empirically + binary strings + upstream CHANGES — the COLORTERM hint
  ships in tmux 3.6); do not count on it in any battery.
- [Task 2.1] Favicon badge + title on awaiting state (poke = the exact
  ADR-0001 hook path, a tmux session option on the REAL default server —
  isolation rules apply). tmux-api's liveness backstop (proc.go
  clearDeadStates) DROPS any state whose pane has no live process with
  comm `claude` underneath — a bare set-option is silently blanked
  (verified 2026-07-11), so fake one first:
  `tmux new-session -d -s tl-battery-attn`, then
  `cp /bin/sleep "$SCRATCH/claude" && tmux send-keys -t tl-battery-attn
  "$SCRATCH/claude 600" Enter`. Load the lobby top-level →
  `link[rel=icon]` href is `/icon-192.png`. Then
  `tmux set-option -t tl-battery-attn @claude_state awaiting` → within
  one poll (≤5 s + ε) the tab title gains the `(1●)` badge AND the
  favicon href flips to a `data:image/png` URL (canvas badge; in the
  harness the icon route 404s so the render is the theme-tile fallback —
  still a data: URL). `tmux set-option -t tl-battery-attn @claude_state
  done` → title badge drops, href back to `/icon-192.png`. Cleanup:
  `tmux kill-session -t tl-battery-attn` (the fake claude dies with it).
- [Task 2.1] Opt-in notification, once per transition: instrument BEFORE
  the flow with `context.grantPermissions(['notifications'])` + a
  wrapper around `window.Notification` that counts `(title,
  options.tag)` and delegates construction (also count
  `Notification.requestPermission` calls — carry over the static
  `permission` getter or the page's gates misread). Load the lobby → the
  requestPermission count is **0** (never auto-requested) and the 🔔
  toggle shows `aria-pressed="false"`. Click 🔔 → `aria-pressed="true"`
  + persisted `tl:notify:v1 = 1` + success toast. Hide the tab — in
  headless Chromium a second page + bringToFront does NOT flip
  `document.hidden` (verified 2026-07-11; every page is its own
  window), so use the standard shim:
  `Object.defineProperty(document, 'hidden', {value:true,
  configurable:true})` (+ same for `visibilityState`) then dispatch
  `visibilitychange`. Flip `tl-battery-attn` done→awaiting (fake-claude
  recipe above) → EXACTLY ONE Notification, title
  `tl-battery-attn needs input`, tag `tl-tl-battery-attn`; wait ≥2 more
  poll cycles with the state still `awaiting` → count stays 1
  (per-transition; the tag replaces rather than stacks on re-fire).
  Un-shim (`delete document.hidden` etc. + dispatch) → attention
  clears. Toggle 🔔 off → further transitions notify nothing.
- [Task 2.1] Bell + output-while-hidden (drive the OUTER page; terminal
  iframe attached to `#main`): with the tab visible AND focused,
  `tmux -L tl-dev send-keys -t main "printf '\a'" Enter` → title and
  favicon change NOTHING (the away() gate: hidden || !hasFocus).
  Apply the hidden shim above, send the bell again → outer tab title
  gains the `● main ` prefix AND the favicon href goes `data:` (a bell
  badges even with no session awaiting; the echoed prompt output also
  latches the output-while-hidden signal — one postMessage per hidden
  period, not one per chunk). Un-shim + dispatch `visibilitychange` →
  prefix AND badge clear (window focus is the other clear trigger).
- [Task 2.2] Reconnect ladder + pill (healer untouched): create the session
  OUT-OF-BAND first — `tmux new-session -d -s tl-battery-conn` (REAL default
  server — isolation rules, clean up after). Creating it "via the lobby" is
  NOT executable under the harness: Create&Open never calls a create API —
  in prod the session materializes as a side effect of ttyd running
  `tmux new-session -A` on WS attach (index.html ≈3597; the button only
  calls `activateSession`), and the harness ttyd command is FIXED (ignores
  the URL arg), so a lobby-typed name never reaches the real server and the
  first ttyd kill would hit `sessionStillExists()` = false → "Session
  ended." — the retry ladder never engages. With the session pre-created,
  attach `#tl-battery-conn` (the harness ttyd still puts the pty on scratch
  `main`; the name only feeds `sessionStillExists`). Pre-set
  `frameEl.contentWindow.__tlMark = 1`. Kill the harness ttyd child
  (`pkill -f 'ttyd.*--port 7996'`). **Expect:** `#conn-pill` in the iframe
  loses `.hidden` reading `Connecting…`, then `Reconnecting… (attempt N)`
  with ladder gaps — attempt N+1 starts ≥ the rung delay after N
  (1/2/4/8/16s, holding at 16s for N≥6; watch `connAttempts` climb via the
  pill text). Restart the same ttyd command
  (`ttyd --port 7996 --interface 127.0.0.1 --writable -a -t
  enableClipboard=true --index out/index.html tmux -L tl-dev new-session -A
  -s main`) → the next rung reattaches: pill regains `.hidden`, typing
  echoes, console logs a second `Connected to ttyd`, and `__tlMark` still
  `1` — the healer's reloadIfStale ran on that reconnect against an
  unchanged build without reloading (the changed-build reload leg is the
  Task 1.7 ACK line).
- [Task 2.2] Ladder reset + instant retry: stay connected ≥30s, kill ttyd
  again → the FIRST pill text is `Connecting…` (the 30s stability timer
  reset the attempt counter). While a long rung is pending, dispatch
  `window.dispatchEvent(new Event('online'))` in the iframe → the attempt
  fires immediately (console `reconnect: instant retry (back online)`);
  same via the visibility path (hidden-shim recipe in the Task 2.1 line,
  un-shim + `visibilitychange` → `instant retry (tab visible)`). With
  `navigator.onLine` shimmed to `false`
  (`Object.defineProperty(navigator,'onLine',{value:false,configurable:true})`)
  a repaint shows `You are offline` + `.offline` class (amber pulse dot
  turns danger-red); delete the shim + fire `online` → reconnects at once.
- [Task 2.2] Session-ended guard unchanged: with ttyd killed AND
  `tl-battery-conn` deleted (`DELETE /api/sessions/sessions/tl-battery-conn`
  — the doubled segment per the isolation-section note; 204), the
  iframe's next close-check finds the session gone → writes
  `Session ended.`, pill goes `.hidden`, and NO further attempts start for
  ≥20s (a killed session must never be resurrected by the retry loop;
  the lobby deactivates the frame on its next poll — assert within that
  ≤5s window or block the poll first).
- [Task 2.3] Focus return — gallery + lightbox (terminal iframe on
  `#main`): click the 🖼 floating button (the BUTTON takes focus — that
  is the bug being guarded), gallery overlay opens; press Escape → it
  closes; type `echo focus-back` + Enter IMMEDIATELY (no click) →
  `tmux -L tl-dev capture-pane -p -t main` shows the command ran
  (keystrokes reached the pty). "Immediately" means ROBOT speed — the
  first keystroke may follow Escape within the same ~16ms frame:
  closeOverlay focuses xterm SYNCHRONOUSLY before the deferred
  rAF/50ms re-request (fix 2026-07-11: the deferred race alone left a
  ~1-frame hole in which the first key still routed to the focused
  🖼 button — 4/7 robot cycles lost it). Run ≥5 back-to-back
  Escape→type cycles; every command must execute. Repeat via the lightbox: paste/upload
  an image first, open the gallery, click a thumbnail (lightbox on
  top), Escape → back on the grid, Escape → closed → type → reaches
  the pty. Backdrop-click dismissal refocuses the same way.
- [Task 2.3] Focus return — lobby menus + dialogs (drive the OUTER
  page): create `tl-battery-focus` on the real server (isolation
  rules), open its card's ⋯ menu, press Escape → menu closes AND the
  terminal iframe regains the keyboard: type `echo menu-esc` + Enter →
  shows in `tmux -L tl-dev capture-pane -p -t main` (the harness pty;
  the outer→inner hop is a `tl-focus` postMessage into the iframe's
  `term.focus()`, deferred via rAF raced with a 50ms timeout — rAF
  alone starves in an iframe with no pending paint, measured in
  headless Chromium). Dialog path: ⋯ → Rename opens a native
  prompt() — cancel it → focus lands back in the terminal (the rAF
  refocus fires after the modal returns); type → reaches the pty.
  Outside-CLICK menu dismissal must NOT steal focus back: open the ⋯
  menu, click into the new-session name input → menu closes and the
  INPUT keeps focus (`document.activeElement.id === 'new-name'`).
  Cleanup: kill `tl-battery-focus`.
- [Task 2.7] Typed toasts + legacy wrapper: `showToast('hello','success',1500)`
  still works — `#toast` gains `.visible` (the A.3 selector is unchanged
  by design) containing a `.toast-card.t-success` child that auto-closes
  after 1.5s (`.visible` drops with the last card). Via the battery hook:
  `id = __tlToast.add({type:'error', title:'boom', description:<220-char
  string>, timeout:0})` → the card shows the ✕ error icon, a 4-line
  clamped description (`.t-desc.t-clamp`, computed `-webkit-line-clamp`
  4) and a Copy button that puts the FULL 220-char string on the
  clipboard; `__tlToast.update(id, {description:'short now'})` mutates
  the SAME element in place (child count of `#toast` unchanged); the ×
  button (and `__tlToast.close(id)`) removes it. A `type:'loading'` card
  renders the ring spinner. Stack cap: 7 quick `add`s → ≤6 cards, the
  oldest auto-dismiss card evicted first, sticky (timeout 0) cards
  survive.
- [Task 2.7] Slow-request health toast (fetch path, end-to-end): run the
  harness with `--delay /sessions=20` and load the lobby → ~15-16s after
  the first `/sessions` poll ONE sticky warning card "Some requests are
  slow" appears (timeout 0), description `N request(s) waiting longer
  than 15s.`; "Show requests ▾" expands rows
  `GET /api/sessions/sessions` + `Started HH:MM:SS`. The 5s poll cadence
  plus Chrome's 6-connections-per-origin queueing keeps ~4-7 requests in
  the slow set at any moment (measured 2026-07-11; tracking starts at
  `fetch()` call time, the 20s delay only once a pooled connection frees
  up), so the SAME card persists and updates in place — still exactly
  one `.toast-card.t-warning`, count changing, oldest `Started` rows
  rolling off as their responses ack — it cannot drain while the flag
  is on. Clear-on-ack is the single-shot variant: rerun with
  `--delay /whoami=20` — the boot preflight is the only lobby whoami
  call, so the card appears ~15s into the load and closes BY ITSELF at
  ~20s when the response lands (the lobby renders right after). Restart
  the harness without flags → no slow toast within 30s of normal use.
  (SIGSTOP/SIGCONT on the live tmux-api also demonstrates it but touches
  the production service — prefer the flag.)
- [Task 2.7] WS liveness feeds the same toast: the aiohttp harness
  accepts the browser WS before dialing ttyd, so a true CONNECTING hang is
  unreachable locally — assert the wiring via the hook instead:
  `id = __tlSlowRequests.track('WS /ws')` → after 15s the warning card
  appears listing `WS /ws`; `__tlSlowRequests.ack(id)` closes it. Wiring
  is code-visible in `connect()` (track at socket creation, ack in both
  onopen and onclose): during battery A runs the toast must NEVER appear
  from normal connects/reconnects (onclose acks failed attempts — only a
  socket genuinely stuck >15s in CONNECTING qualifies).
- [Task 2.4] Pills v2 state cycle (fake-claude recipe from the Task 2.1
  line — REAL default tmux server, so isolation rules apply; session
  `tl-battery-pills`): create + fake claude, then step `@claude_state`
  through the trio, waiting ≤1 poll (5s + ε) per step:
  `awaiting` → the card's `.state-dot` carries class `awaiting`, computed
  background = the theme's `--state-awaiting` (amber `#f59e0b` on
  t3-dark/t3-light), and the tab title gains `(1●)`;
  `running` → dot class `running` + the `state-pulse` animation, computed
  background `--state-running` (sky `#0ea5e9` on t3-*), the detail row
  gains `.working-note` — three 4px `working-pulse` dots at
  animation-delay 0/200/400ms + literal `Working for ` + a
  `.working-timer` span — and the title badge rolls to `(1⋯)` (running
  outranks nothing here; with another session awaiting, `(N●)` wins);
  `done` (do NOT click the card) → dot class `done unseen`, computed
  opacity `1` + emerald ring (`--state-done`, `#10b981` on t3-*), title
  badge `(1✓)`.
- [Task 2.4] Timer ticks with NO re-render: while `running`, capture the
  card node + its `.working-timer` textContent (e.g. `4s`); wait 2-3s
  (between polls — the shared 1 Hz ticker drives it); textContent
  increased AND both the card element and the timer span are the SAME
  nodes (isSameNode) — updates are textContent-only. Values follow the
  T3 format: `34s` → `2m 10s` → `1h 5m`.
- [Task 2.4] Visiting clears the emerald: with `tl-battery-pills` in
  unseen-done, click its card (the harness iframe attaches the scratch
  `main` session whatever the card name — the visit stamp is client-side
  `activateSession` and fires regardless) → the dot immediately drops
  `unseen` (computed opacity ≈0.45), the `(1✓)` badge clears, and
  localStorage `tl:session-visits:v1` now maps the session to a
  fresh epoch-ms. Reload the lobby → still seen (both stores persist;
  `tl:session-states:v1` keeps the transition timestamp). Cleanup:
  `tmux kill-session -t tl-battery-pills` → after the next poll the
  stores PRUNE the dead name (both keys no longer contain it).
- [Task 2.5] Go side: `go test ./...` in `tmux-api/` green — incl.
  `TestParseSessionsPaneCommandAndTitle` (8-field format, pipe-in-title
  survives, pipe-in-name row dropped, legacy 6-field row skipped) and
  `TestSessionsJSONShape` (keys `pane_current_command`/`pane_title`,
  omitted when empty). End-to-end needs a SCRATCH build (the production
  tmux-api on :7684 predates the fields):
  `go build -o $SCRATCH/tmux-api-dev ./tmux-api &&
  TMUX_API_ADDR=127.0.0.1:17684 $SCRATCH/tmux-api-dev &` then run the
  harness with `--tmux-api-port 17684` → `/api/sessions/sessions` items
  carry `"pane_current_command"` + `"pane_title"`.
- [Task 2.5] Live-command chip: `tmux new-session -d -s tl-battery-cmd
  'cat'` (REAL server, isolation rules — `cat` is the same payload
  command battery item A.1 uses) → within one poll the card shows
  `.cmd-chip` with textContent `cat`, computed 11px `var(--font-mono)`
  (JetBrains Mono first); chip title carries `cat — <pane_title>`.
  Click the card (attach) → `document.title` becomes
  `cat — tl-battery-cmd` (plus any state badge prefix).
- [Task 2.5] Inline rename round-trip: double-click the card TITLE →
  `.session-name` swaps to a focused, prefilled `input.rename-input`
  and `card.draggable` flips false; type `tl-battery-cmd2` + Enter →
  204 from the existing rename endpoint, `tmux list-sessions` shows the
  new name, the card re-keys, and (if attached) hash + tab title follow.
  Escape or blur restores the title untouched; an invalid name toasts
  and keeps the editor open. Guards: single click still activates
  (only `detail > 1` is suppressed), dblclick with a held modifier or
  on a nested button does nothing. Editor survives the poll repaint
  (2026-07-11 regression: paint() rebuilt the card DOM under the
  editor): hold the editor open across ≥2 poll boundaries (>11s, with
  other sessions' states churning) → the SAME `input.rename-input`
  element is still connected, focused, and keeps the typed draft
  (renameEditing pauses paint like the menus); after Escape the
  repaint resumes (kill the session from tmux → its card disappears
  within ~2 polls).
- [Task 2.5] Card context menu (T3 fallback port): right-click a card →
  ONE `.popup-menu` at the pointer with Move to…/Session/Rename/Kill;
  the menu survives its own opening gesture (rAF first-frame guard);
  synthetic `contextmenu` with clientX/Y at the viewport corner → menu
  rect clamps ≥4px inside every edge; Escape (lobby-focused) and
  outside pointerdown dismiss with NO action; picking Kill runs the
  normal confirm() flow. While the menu is open the 5s poll repaint
  pauses (same contract as the ⋯ menu).
- [Task 2.5] Gallery-thumb context menu + native menu untouched: upload
  an image for the session (`curl -F image=@px.png -F
  session=tl-battery-cmd2 <origin>/clipboard/upload`), open the gallery
  in the terminal iframe, right-click a cell → menu Open / Insert path
  into terminal / Download; "Insert path" types the store path into the
  pty (`tmux -L tl-dev capture-pane -p` shows it) and closes the
  gallery. Over the terminal itself: dispatch a cancelable
  `contextmenu` on `.xterm-screen` → `defaultPrevented` is FALSE (no
  listener anywhere on the xterm surface — the native browser menu
  still appears; red line). Cleanup: kill the session, `rm -rf
  /var/lib/clipboard-store/<osUser>/tl-battery-cmd2`.
- [Task 2.6] Go side: `go test ./...` in `tmux-api/` green — incl. the
  /prefs suite (GET empty → `{}`, PUT→GET round-trip incl. last-writer-
  wins, per-user isolation via X-Authentik-Username against a fixture
  user map, invalid/oversize body → 400, no-header → 401, unmapped →
  403, POST → 405). End-to-end needs a SCRATCH build (production
  tmux-api predates /prefs) with a DISPOSABLE store — never the real
  `/var/lib/tmux-api/prefs`:
  `go build -o $SCRATCH/tmux-api-dev ./tmux-api &&
  TMUX_API_ADDR=127.0.0.1:17684 TMUX_API_PREFS_DIR=$SCRATCH/prefs
  $SCRATCH/tmux-api-dev &`, harness with `--tmux-api-port 17684` →
  `curl -H 'X-Authentik-Username: vbarzin' :17684/prefs` → `{}`; PUT
  `{"cursorStyle":"bar"}` → 204 and GET echoes it back. (The header
  carries the AUTHENTIK name — `/etc/ttyd-user-map` maps it to the OS
  user; the OS name `wizard` is unmapped and 403s.)
- [Task 2.6] Settings popover: click the sidebar `⚙ Terminal settings`
  button → `#settings-panel` opens anchored to it with EXACTLY seven
  controls (six until Task 3.5 added the flow-control checkbox) —
  font-size A−/A+ (same store as the Task 1.8 steppers:
  panel steps move `#font-size-value` and vice versa), line-height
  range 1–1.4, letter-spacing range 0–1px, cursor Block/Bar/Under
  segments, cursor-blink checkbox, bold-weight 600/700 segments,
  flow-control checkbox (`#sp-flow`, Task 3.5) — and
  NO smooth-scroll / renderer / mouse / wheel / scroll option anywhere
  in it (red line; assert by scanning the panel's text). Escape closes
  it AND the terminal regains the keyboard (type → capture-pane shows
  it; the Task 2.3 closeOverlay path). Outside-click closes it WITHOUT
  stealing focus (click into `#new-name` → input keeps focus).
- [Task 2.6] Live apply + refit, no reload: attached to `#main`, record
  `tmux -L tl-dev display -p '#{client_width}x#{client_height}'`; set
  line height 1.4 → `window.__term.options.lineHeight` → 1.4 and
  client_height SHRINKS while client_width holds (deviation from the
  plan's "client_width changes": lineHeight only affects row height —
  the width assert moved to letter spacing); set letter spacing 1 →
  client_width shrinks. Cursor Bar → `options.cursorStyle` `'bar'`;
  blink off → `options.cursorBlink` `false`; bold 600 →
  `options.fontWeightBold` `'600'` (rendering note: with only the
  400/700 JBM faces vendored, CSS matching resolves 600 to the Bold
  face — assert the option value, not pixels). `__tlMark` survives
  throughout (no iframe reload), then §A.1 + §A.2 pass immediately
  after (fit() is the declared-safe resize path).
- [Task 2.6] Roaming: with the scratch tmux-api wired (recipe above),
  change prefs in the panel → within ~1s (400ms debounce + write)
  `$SCRATCH/prefs/wizard.json` holds the new doc (PUT-on-change).
  Open a SECOND browser context (fresh profile, empty localStorage) →
  after the boot GET the panel shows the roamed values and
  `window.__term.options.lineHeight` matches (server doc adopted, and
  a pre-existing `tl-font-size` legacy key seeds fontSize when the doc
  lacks one). Local-wins guard — CROSS-FRAME (2026-07-11 regression:
  per-frame prefsDirty let the terminal iframe's boot GET revert a
  change made in the outer panel): run the harness with
  `--delay /prefs=3`, seed the server doc with a different lineHeight,
  load + attach so BOTH frames have boot GETs in flight, change
  lineHeight via the OUTER panel ~1s after load → when the delayed
  GETs resolve there is NO snap-back in either frame (panel value,
  `localStorage['tl:prefs:v1']` and `window.__term.options.lineHeight`
  all keep the user's value — the changing frame skips adoption via
  prefsDirty, the sibling via the `tl:prefs-dirty:v1` marker), and the
  next PUT pushes the local doc up, after which the marker is retired
  (`localStorage['tl:prefs-dirty:v1']` gone once the PUT acks — a
  stale-server-doc reload before any ack must also NOT adopt).
- [Task 2.6] Validate-or-default: set `localStorage['tl:prefs:v1']` to
  `'{"fontSize":999,"lineHeight":"huge","cursorStyle":"comic-sans"}'`,
  then to `'not-json'`, reloading each time → no crash, terminal boots
  at defaults (fontSize falls back to the `tl-font-size` legacy key),
  panel paints defaults; making one valid change replaces the garbage
  doc wholesale (localStorage now a clean six-field doc).
- [Task 2.8] Density metrics (desktop viewport, any dark theme):
  `.lobby-header-row` computed min-height `52px` (T3's
  --workspace-topbar-height); #new-btn, #restore-btn and
  #new-project-btn each measure exactly 32px tall (border-box) with
  computed padding `0px 11px`, border-radius `10px`, font `500 14px`
  var(--font-ui) — measure ALSO with the sidebar content overflowing
  its viewport (a 720p-or-shorter window with a few cards already
  overflows): #restore-btn/#new-project-btn are direct flex children
  of the scrolling sidebar column and must NOT flex-shrink below 32px
  (regression 2026-07-11: default flex-shrink:1 compressed them to
  20px under overflow; `flex-shrink: 0` pins them); #new-name matches at 32px but KEEPS 16px text (iOS
  no-zoom rule); #notify-toggle is 32×32 with a 16px glyph at opacity
  0.8 (T3 icon tier); group labels (.theme-picker-label,
  .project-title, .popup-menu .menu-label, .settings-panel .sp-title)
  compute 10px uppercase letter-spacing 0.8px (.08em); the old 11px
  chrome tier now reads 12px (.session-detail, .theme-options /
  .font-size-row / #settings-btn / .sp-* controls, .project-badges)
  and .popup-menu button 14px — EXCEPT `.cmd-chip`, which stays 11px
  (Task 2.5 lock). Theme chips and settings-panel segments show NO
  text clipping at the new sizes (scrollWidth ≤ clientWidth on each).
- [Task 2.8] Focus rings + disabled: starting from body, keyboard-Tab
  through the lobby (sidebar toggle → bell → name input → Create →
  project headers / cards / ⋯ → + Project → Restore → theme buttons →
  A−/A+ → settings) → EVERY stop computes `outline: 2px solid` in the
  theme's --ring (= --accent) at outline-offset `1px` — except the
  full-bleed rows (.session-card, .project-header), which keep an
  INSET `-2px` offset (deviation from the plan's uniform 1px: a +1px
  ring on those rows clips under the sidebar's overflow-x: hidden).
  Pointer clicks paint no ring (:focus-visible), and the inline rename
  editor keeps outline: none. Any disabled chrome control (e.g. force
  `#restore-btn.disabled = true`) computes opacity `0.64`.
- [Task 2.8] Hover tint + coarse targets: on a dark theme
  `getComputedStyle(document.body)` --hover-tint =
  `rgba(255, 255, 255, 0.04)`; on ink/t3-light/latte =
  `rgba(0, 0, 0, 0.04)`; `.popup-menu button:hover` and
  `.project-header:hover` backgrounds resolve to it. On an emulated
  coarse-pointer viewport (Pixel 7 class, 412×915): every lobby
  control — buttons + the #new-name input, popup-menu items,
  settings-panel controls — measures ≥44px tall; #sidebar-toggle and
  #notify-toggle square 44×44; standard buttons step to 16px text and
  the 12px tier to 14px — INTERACTIVE controls only (theme options,
  font-size row, #settings-btn, settings-panel segments/steppers), per
  the plan's controls-oriented coarse rule: passive text such as
  `.session-detail` stays 12px; the rename editor is exempt (no card
  jump);
  no horizontal scroll. The soft-key toolbar (#soft-keys) is
  UNTOUCHED: its buttons still measure 38px tall with min-height auto
  (the plan's "keeps the existing soft-key toolbar sizing").
- [Task M.3] Flat iframe history: load the lobby top-level and snapshot
  `base = history.length` (2 under Playwright — its fresh page starts on
  about:blank; 1 in a real fresh tab), then attach 3 DIFFERENT sessions
  by clicking their cards in sequence (attaching real cards is safe —
  the harness ttyd ignores the URL arg) → `history.length` stays
  **base** after every swap (pre-M.3 measured 2→3→4: every
  `frameEl.src` swap after the first pushed a joint entry). Then
  `page.go_back()` → lands OUTSIDE the app (Playwright's about:blank
  start page), NEVER on a stale attach, and `page.go_forward()` returns
  to the untouched outer URL (`#<session>` hash intact, auto-attaches).
  Real-tab equivalent: base is 1 and back is a no-op — the iOS
  standalone edge-back-swipe stays disarmed, Android predictive-back
  minimizes the app. The `about:blank` writer (deactivate has no UI
  control — it is hash/kill-driven) is exercised via the Task 1.7
  ACK-fallback bounce: suppress the ACK, switch theme → the iframe
  reloads (~1s) into the new theme and `history.length` is STILL base
  (the bounce is two `replace()` navigations now). Guard-read
  regression: while attached, a theme click still posts `tl-theme` and
  dispatching `tl-prefs-change` still posts `tl-prefs` + `tl-font-size`
  into the iframe — their `currentActive && … && contentWindow` guards
  read the tracked `frameUrl` (`frameEl.src` goes stale under
  `location.replace()` and must not be reintroduced).
- [Task 3.1] Go side: `go test ./...` in `clipboard-upload/` green — the
  public-asset suite (exact-path whitelist incl. the pre-shipped
  /icon-512-maskable.png entry, content types, cache policies, HEAD
  support, POST/PUT/DELETE → 405, traversal + tl-symbols + non-listed →
  404, non-asset routes fall through untouched).
- [Task 3.1] Public assets end-to-end through devserve (production shape:
  the harness carve-out forwards ASSET_PATHS to clipboard-upload
  unstripped, NO auth header). Production :7683 predates the handlers, so
  run a scratch build serving the repo's own files:
  `(cd clipboard-upload && go build -o $SCRATCH/clipboard-upload-dev .) &&
  CLIPBOARD_UPLOAD_ADDR=127.0.0.1:17683
  CLIPBOARD_UPLOAD_ASSET_DIR=$PWD/frontend
  $SCRATCH/clipboard-upload-dev &`, harness with `--clipboard-port 17683`.
  Cookie-less, header-less curls against `http://127.0.0.1:7997`:
  `/manifest.webmanifest` → 200 `application/manifest+json` +
  `Cache-Control: public,max-age=3600`, body parses as JSON with
  description exactly `Web tmux sessions.` (vendor string gone);
  `/icon-192.png` + `/icon-512.png` → 200 `image/png` (same
  cache policy); `/icon-512-maskable.png` → 200 `image/png` since Task
  M.9 shipped the file (it 404ed between 3.1 and M.9 — the whitelisted-
  but-not-installed 404 path stays covered by the Go tests); each of the
  5 vendored fonts under
  `/fonts/` → 200 `font/woff2` + `Cache-Control: public,max-age=604800`
  with `content-length` equal to the repo file
  (JetBrainsMono-Regular.woff2 = 92164).
- [Task 3.4] ttyd honors client PAUSE (server side): build the patched
  binary (`./scripts/build-ttyd.sh` — its preflight aborts with apt names
  if cmake/gcc/libwebsockets-dev/libjson-c-dev are missing) and run the
  harness against it:
  `python3 scripts/dev-harness.py --scratch --ttyd-bin out/ttyd`. Then
  `python3 scripts/devserve/flowprobe.py` → `pause_honored: true`, exit 0
  (post-PAUSE the stream drains only in-flight bytes and goes quiet,
  delivers ZERO bytes in the 2s strict window, and RESUME revives it —
  measured 2026-07-11: drain 323-646 B quiet within 0.02s, strict 0,
  ~80 KB after RESUME). Regression sentinel: the same probe against a
  stock-pause build prints `pause_honored: false` (1.1-1.2 MB streamed
  past PAUSE, never quiet within the 8s cap).
- [Task 3.4] Un-paused throughput control (shared-binary guard — a partial
  freeze would sneak past a total-freeze check):
  `python3 scripts/devserve/flowprobe.py --no-pause` against the patched
  binary vs a pre-fix baseline build → median `bytes_per_sec` within ~10%
  and totals match (measured 2026-07-11: fixed median 150306 B/s (n=5) vs
  baseline 144937 B/s (n=3), +3.7%; per-run spread is ±10% tmux pacing
  noise, so compare MEDIANS of ≥3 runs; a 20M `yes` flood collapses to
  ~2.49 MB total at ~0.13 MiB/s client-visible — tmux frame-skipping, see
  flowprobe.py's instrument notes).
- [Task 3.4] Sixel §A.4 re-run against `out/ttyd` (the pixel-size hunks
  ride the same renamed `devvm/ttyd-local.patch`): still ≥100 distinct
  colors in the image crop (measured 635) and the attached client's
  `#{client_termfeatures}` lists `sixel`.
- [Task 3.5] Flow control — bounded write queue + responsiveness: harness
  against the patched binary (`--ttyd-bin out/ttyd`), attach `#main`;
  instrument every frame with an init script wrapping
  `WebSocket.prototype.send` to log 1-byte `'2'`/`'3'` frames
  (`window.__tlFlowFrames`) + the `__term` Proxy recipe; CDP
  `Emulation.setCPUThrottlingRate` rate 6. Flood
  `tmux -L tl-dev send-keys -t main 'yes | head -c 20M' Enter` → poll
  `__term._core._writeBuffer._pendingData` every ~100 ms until the stream
  quiesces: peak ≤ ~1.2 MB, and an in-page rAF probe's max frame gap
  < 200 ms (main thread responsive). NOTE tmux frame-skipping collapses
  the client-visible flood to ~0.13 MiB/s (Task 3.4 instrument note) —
  an UNthrottled tab never nears the high-water mark; under the 6×
  throttle xterm's parse rate drops below the arrival rate and the
  backlog crosses it for real (measured 2026-07-11: peak 1.04-1.15 MB,
  just over the 11 × 100 KB registration threshold — exactly ONE '2'
  PAUSE frame sent, max rAF gap 167-183 ms, tail drains after the
  callback-path RESUME). A Playwright frame-lookup gotcha for all
  Task 3.5 legs: M.3's `location.replace()` swaps leave Playwright's
  cached `frame.url` at `about:blank` — find the terminal frame by
  live content (`frame.evaluate('location.href')`), never by
  `frame.url`.
- [Task 3.5] Watchdog fail-open (challenge-round requirement — a stuck
  PAUSE must never freeze the terminal): same instrumented setup; in the
  terminal iframe swallow completion callbacks —
  `const t = window.__term, o = t.write.bind(t); t.write = (d, cb) => o(d)`
  — then flood 20M (run each leg against a FRESH reload: a paused
  server + in-flight callbacks from a previous leg poison the
  counters). Expect, in order: ≥1 `'2'` (PAUSE) frame once ~1.1 MB has
  arrived (11 × 100 KB registrations, ~7-8 s at the collapsed rate);
  output goes QUIET (the Task 3.4 server honors it); ≤4 s later the
  console warns exactly `tl-flow: watchdog resume` and a `'3'` (RESUME)
  frame follows; new OUTPUT bytes arrive ≤5 s after the quiet point —
  output never freezes for good (the cycle repeats while the swallow is
  active; measured 2026-07-11: PAUSE at 1 105 032 flood bytes, watchdog
  RESUME 4.00 s after it, output growing again 2.6 s after the quiet
  point, exactly one warn per cycle). Restore `t.write = o` (or reload)
  after.
- [Task 3.5] Kill-switch: `localStorage['tl-flow-control'] = 'off'`,
  reload, re-instrument INCLUDING the leg-2 callback swallow (the exact
  conditions that trip PAUSE when flow control is on), flood 20M →
  ZERO 1-byte `'2'`/`'3'` frames for the whole flood (behavior
  identical to pre-3.5 plain `term.write`), flood renders to completion
  (measured 2026-07-11: 0 frames over a 1.9 MB collapsed flood).
  Settings panel: `#sp-flow` is the seventh control, CHECKED by default;
  untick → the key reads `'off'` (storage event live-disables an
  attached terminal; if it was paused at that instant it force-resumes,
  warning `tl-flow: kill-switch resume`); tick → key removed, flow
  control re-arms at the next connect (onopen re-read).
- [Task 3.5] Server side unchanged by the client work:
  `python3 scripts/devserve/flowprobe.py` against the same harness →
  still `pause_honored: true`, exit 0.
- [Task 3.1] Traversal probes — direct against the scratch service with
  raw paths (`curl --path-as-is -so /dev/null -w '%{http_code}'
  http://127.0.0.1:17683/<path>`): `/icon-../etc/passwd` → 404,
  `/fonts/../../etc/passwd` → 404 (the pre-mux dispatcher answers —
  no ServeMux canonicalize-and-301), `/fonts/tl-symbols.woff2` → 404
  (installed for parity but data-URI-embedded, deliberately not
  whitelisted), `/fonts/does-not-exist.woff2` → 404. POST
  `/manifest.webmanifest` → 405. Existing routes intact through the
  harness: `/clipboard/list?session=main` (auth header injected by the
  proxy) still answers JSON, `/health` direct → `ok`.
- [Task 3.6] Query-reply sanitizer unit suite: `go test ./...` in
  `tmux-api/` green — T3-ported strip rules (CSI `…n` DSR, CSI
  `[0-9;?]*R` CPR, CSI `[>0-9;?]*c` DA, OSC `(10|11|12);(?|rgb:)`),
  keep-table (SGR/DECSET/titles/OSC52/DCS-atomicity/UTF-8/binary),
  chunk-boundary straddle at EVERY split point + byte-at-a-time,
  seeded 300-iteration sequence-free identity property, idempotence,
  and the resurrect-archive rewriter (strip, clean-noop, mode
  preservation, corrupt-leaves-original, exit-0 hook contract).
- [Task 3.6] Replay-path CLI round-trip (the wired path: resurrect's
  `@resurrect-hook-pre-restore-all` → `tmux-api sanitize-resurrect`
  runs BEFORE restore.sh extracts + `cat`s pane contents into the
  recreated ptys): build `tmux-api`, write a fixture
  `$HOME/.tmux/resurrect/pane_contents.tar.gz` whose pane file mixes
  SGR + `\x1b[6n` + `\x1b[?64;…c` + `\x1b]11;rgb:…\x1b\\` + emoji,
  run `HOME=<fixture> tmux-api sanitize-resurrect` → exit 0, stderr
  names the archive, re-read: query/reply bytes GONE, SGR + text +
  emoji byte-identical, entry layout/modes preserved (measured
  2026-07-11: 95 → 62-byte pane file). Second run → silent no-op,
  archive mtime+size unchanged. Service mode unaffected by the CLI
  dispatch: `TMUX_API_ADDR=127.0.0.1:17699 tmux-api` (no args) still
  serves `/health` → `ok`.
- [Task 3.6] Negative wiring finding (recorded, no action): the web
  "Restore sessions" path (POST /restore → tmux-restore-user →
  tmux-persist) replays NO captured content — its manifest is
  name/cwd/claude-uuid and sessions are recreated via `claude
  --resume`; the ONLY capture→pty replay route in the stack is
  tmux-resurrect's pane-contents `cat`, covered above.
- [Task 4.1] Merged-handler guard (challenge-round blocker): the served page
  contains exactly ONE `attachCustomKeyEventHandler(` call site (grep), with
  the `tlKb.matchesAppChord` branch INSIDE it, after the keydown-type check
  and BEFORE the copy/paste branches. Never add a second call — xterm stores
  one handler and a second call silently replaces the ADR-0003 contract.
- [Task 4.1] Default OFF (zero change for non-opted browsers): with NO
  `tl:keybindings:v1` in localStorage, arm the key sensor
  (`tmux -L tl-dev send-keys -t main "stty -icanon -echo -isig min 1 time 0; cat -v" Enter`),
  focus the terminal, press Alt+1 / Alt+Shift+] / Ctrl+Shift+K →
  capture-pane shows `^[1` and `^[}` (chords reached the pty unchanged;
  Ctrl+Shift+K emits nothing — stock xterm behavior, pre-existing), and NO
  `.cmd-palette` exists in the lobby document or the iframe. Settings panel:
  "App shortcuts" is the eighth control, UNCHECKED.
- [Task 4.1] ADR-0003 key contract runs IDENTICALLY with the layer ON and
  OFF (execute this whole line twice, once per state): drag-select echoed
  text → Ctrl+C → clipboard holds the selection + "Copied" toast + NO `^C`
  in the pane + selection survives; output-cleared selection then Ctrl+C
  ≤15 s → "Copied (recovered)"; Escape with a selection → selection clears
  AND `^[` appears in the pane; Ctrl+C with no selection → `^C` (SIGINT);
  Ctrl+V with multi-line clipboard → one bracketed paste (§A.6 shape).
  Verified 2026-07-12 both states on the harness (byte-identical pane log).
  GOTCHA for the recovered leg: the stash lives 15 s from selection — run
  select → output-clear (type `seq 1 40` + Enter into the pane; the scroll
  clears the highlight WITHOUT nulling the stash) → Ctrl+C inside ONE
  scripted sequence. Spreading it across slow tool/protocol round-trips
  expires the window and the chord correctly falls through as SIGINT
  (looks like a false FAIL — it isn't; exit 130 at the shell is the
  designed >15 s path, layer state irrelevant).
- [Task 4.1] Enabled chords act and never reach the pty: tick #sp-kb (writes
  `tl:keybindings:v1 = {"enabled":true,"overrides":{}}`; the iframe follows
  via the storage event, no reload), focus the terminal, then: Ctrl+Shift+K →
  palette opens in the LOBBY document with its input focused; Alt+2 → the
  2nd sidebar card attaches (frame `?arg=`, `#hash`, `.active` card all
  agree) and typing immediately lands in the new session (keyboard-only
  switch); Alt+Shift+] then Alt+Shift+[ cycle next/prev with wrap;
  capture-pane gained NO `^[<digit>`/`^[}`/`^[{` bytes for any of it.
- [Task 4.1] Palette behavior: sessions list recents-first (attach two
  sessions, reopen → they lead; `tl:session-visits:v1` order), current
  session tagged; query filters (exact=3 > prefix=2 > substring=1 — query a
  full session name → it ranks first); `>` prefix shows the Actions group
  only (New/Rename/Gallery/Paste/Kill); ArrowDown/ArrowUp move the `.sel`
  row, Enter runs it (session row → attach + palette closes), Escape and
  backdrop-click close with terminal refocus (helper textarea is
  activeElement again).
- [Task 4.1] Alt-held jump badges: with the layer on, hold Alt (keydown
  only) with focus INSIDE the terminal → after ~100 ms (not at 60 ms)
  numbered `.kb-badge` chips overlay the first ≤9 session cards in sidebar
  order; Alt release → gone; re-hold then window blur → gone (tracker
  reset). Layer off → badges never appear.
- [Task 4.1] Live-disable: untick #sp-kb while attached → doc reads
  `{"enabled":false,...}`; Alt+1 in the terminal no longer attaches and
  `^[1` reaches the pty again (storage event flipped the iframe live).
- [Task M.1] New soft keys send bytes: mobile emulation (390×844, touch),
  attach `#main`, arm `tmux -L tl-dev send-keys -t main 'cat -v' Enter`;
  tap `⇧Tab`, `/`, `-` in the soft-key row → `capture-pane -p -J` shows the
  contiguous run `^[[Z/-`. Row order: Esc Tab ⇧Tab Ctrl Alt ↑↓←→ | ` / -
  Copy Paste Kbd.
- [Task M.1] Hold-to-repeat (raw CDP `Input.dispatchTouchEvent` — the row
  SCROLLS horizontally, so `scroll_into_view_if_needed()` the target first;
  Playwright's tap-only touchscreen can't hold): touchStart on ↓, hold
  1.2 s, touchEnd → **≥10** `^[[B` in capture-pane (measured 11: initial
  send + 500 ms delay + 60 ms ticks), and the count is UNCHANGED 0.5 s
  after release (cancel on pointerup; pointercancel/pointerleave are wired
  for OS gesture interrupts + mouse holds dragged off the button).
- [Task M.1] Repeat opt-outs, both live per press (no reload): write
  `tl:prefs:v1` `gestures.keyRepeat=false` → same 1.0 s hold sends exactly
  **1** byte-run; restore `keyRepeat:true` + set `tl-gestures`='off'
  (master kill, same `!== 'off'` posture as `tl-flow-control`) → exactly
  **1** again; remove the kill key afterwards.
- [Task M.1] `⌄` dismiss: tap the terminal (helper textarea focused —
  `document.activeElement.className` contains `helper-textarea`), tap the
  `⌄` button → activeElement is NOT the helper textarea (keyboard
  collapse), and `⌄` is a DIRECT child `#soft-keys > button.sk-dismiss`
  (right-pinned outside the scrolling row — never scrolls out of reach).
  `Kbd` re-focuses (inverse).
- [Task M.1] Edge fade: `getComputedStyle` of `.sk-row` has a
  `linear-gradient` mask-image (scroll affordance); the row (not
  `#soft-keys`) is the horizontal scroller.
- [Task M.1] Settings: on a coarse-pointer lobby (un-collapse the sidebar
  at 390 px first) the panel shows a "Key repeat" row (`#sp-repeat`,
  checked by default); untick → `tl:prefs:v1.gestures.keyRepeat === false`
  with ALL sibling top-level fields intact (nested deep-merge) and the
  debounced PUT roams the doc (server copy gains `gestures`). On a
  fine-pointer (desktop) context `#sp-repeat` does NOT render.
- [Task M.1] Nested-prefs robustness (normalizePrefs generalization —
  M.10's compose.* rides the same mechanism): corrupt `gestures` in
  localStorage (e.g. `42`, `{"keyRepeat":"yes"}`, `[1,2]`) → fresh page
  boots with NO pageerror and `getPrefs().gestures` degrades per-subkey to
  defaults; a `setPrefs({gestures:{…}})` patch never resets sibling
  namespace flags.
- [Task M.1] Red line: §A.5 legs (single-finger swipe → synthetic wheel →
  copy-mode scroll; tap → keyboard focus) pass unchanged, and the standing
  diff guard holds — the touch-discriminator IIFE (`// Touch behaviour on
  the terminal canvas:` through its `})();`) is BYTE-IDENTICAL to the
  Stage-A deploy (`git show 6773cbd:frontend/index.html` extract == HEAD
  extract). *(Guard re-baselined by M.11 — one declared
  `term.focus()`→`tapFocus()` token swap in this block; see [MF-6].)*
  The modifier state machine (softMods/tapMod/paintMod) is
  likewise untouched.
- [Task M.2] Go side: `go test ./...` in `tmux-api/` green — incl. the
  copy-mode/capture table suite (POST `/sessions/{name}/copy-mode` entry +
  whitelisted Mark/Yank `-X` relay with exact tmux argv asserted via the
  stub seam, `can't find pane` → 404, non-whitelisted command / bad JSON →
  400, `not in a mode` → 409, wrong method → 405, no header → 401 /
  unmapped user → 403 with tmux NEVER invoked, and GET capture body =
  tmux stdout VERBATIM — stderr excluded). End-to-end needs a SCRATCH
  build (production tmux-api predates the endpoints): the Task 2.6 recipe
  (`TMUX_API_ADDR=127.0.0.1:17684 TMUX_API_PREFS_DIR=$SCRATCH/prefs`,
  harness `--tmux-api-port 17684`).
- [Task M.2] Endpoint wiring leg — HARNESS SPLIT-BRAIN NOTE: tmux-api
  operates the REAL default server while the pty the browser renders is
  scratch `main`, so the flow verifies in two halves (in production they
  are the same session and the taps compose into one end-to-end flow,
  probe-proven 2026-07-11: clipboard == show-buffer == 'ALPHA BRAVO').
  (a) Wiring: `tmux new-session -d -s tl-battery-copy` (REAL server —
  isolation rules; give it screen content), coarse-pointer emulation
  (Pixel-7 class), attach `#tl-battery-copy`; tap `Sel` (scroll the
  sk-row) → `tmux display -p -t tl-battery-copy '#{pane_in_mode}'` → `1`;
  tap `Mark` → `#{selection_present}` → `1`; tap `Yank` →
  `#{pane_in_mode}` → `0` AND `tmux show-buffer` holds the selected text
  (no OSC52 reaches the browser in THIS leg — nothing is attached to
  tl-battery-copy in the harness; the browser-clipboard half is leg (b)).
  409 guard: with the pane OUT of copy-mode, tap `Mark` or `Yank` →
  'Tap Sel first' toast, pane state unchanged.
- [Task M.2] (b) In-terminal copy flow — the proven ~30 s probe sequence
  on the scratch pty (copy-mode entered CLI-side because tmux-api cannot
  target `-L tl-dev`; the tap→endpoint hop is leg (a)): make scrollback
  (`seq 1 40`), `tmux -L tl-dev copy-mode -t main`; tap soft `↑` twice →
  `#{copy_cursor_line}`/`#{copy_cursor_y}` change (arrows drive the copy
  cursor through the normal WS input path);
  `tmux -L tl-dev send-keys -t main -X begin-selection` (CLI stand-in for
  Mark) + more arrows → `#{selection_present}` → `1` and the selection
  grows; press Enter (the keyboard path; Yank is the binding-independent
  server equivalent) → copy-mode exits, 'Copied' toast (the OSC52
  provider) and `clipboard.readText()` == `tmux -L tl-dev show-buffer`.
- [Task M.2] Copy screen-capture fallback: attached to `#tl-battery-copy`
  with NO xterm selection (`window.__term.hasSelection()` → `false`), tap
  `Copy` → 'Screen copied' toast and `clipboard.readText()` ==
  `tmux capture-pane -p -J -t tl-battery-copy` output (REAL server;
  trailing blank screen rows included). The write hands the fetch to
  `navigator.clipboard.write` as a ClipboardItem PROMISE synchronously in
  the tap gesture (iOS transient-activation wrapper — an awaited fetch
  hop would void it); contexts without ClipboardItem fall back to
  `writeText(await …)`. Desktop unchanged: with an xterm selection
  present, Copy writes the SELECTION and toasts 'Copied' (the fallback
  fires only on empty).
- [Task M.2] INVERTED guard stays: a single-finger vertical drag over the
  terminal still wheels (§A.5 — scratch `main` scrolls/enters copy-mode)
  and `term.hasSelection()` stays `false` — touch can never create an
  xterm selection; that is WHY the copy path is server-side. Soft-key row
  order now: Esc Tab ⇧Tab Ctrl Alt ↑↓←→ | ` / - Sel Mark Yank Copy Paste
  Kbd. Red line: the touch-discriminator IIFE + modifier machine stay
  byte-identical (M.1 standing diff guard). Cleanup:
  `tmux kill-session -t tl-battery-copy`.
- [Task M.4] Card long-press (raw CDP `Input.dispatchTouchEvent`,
  Pixel-7-class coarse emulation; create `tl-battery-m4` on the REAL
  server first — isolation rules): touchStart at the card center, hold
  600 ms, touchEnd → ONE `.popup-menu` with
  Move to…/Session/Rename/Kill (the same Task 2.5 menu as right-click)
  — since Task M.5 it arrives WRAPPED in a `.tl-sheet` bottom sheet on
  coarse pointers (assert the menu + items, not the position; with
  `gestures.bottomSheet=false` it is the original at-pointer popup) —
  the press does NOT attach (`location.hash` unchanged — the trailing
  lift-click is swallowed by the one-shot capture flag), Escape
  dismisses. Cards report `draggable === false` under `pointer: coarse`
  (HTML5 DnD stays desktop-only; touch reorder remains ⋯ Move up/down).
- [Task M.4] Cancel paths: the same press with ~15 px of FINE touchMove
  travel before 500 ms → NO menu (>10 px cancel); a second touch point
  joining mid-hold → NO menu; a clean plain tap (<100 ms) still attaches
  the session. Repaint guard: start a press just before a 5 s poll
  boundary and hold through it → the pressed card element stays
  CONNECTED (gestureActive joins isDragging/renameEditing in
  paint()/renderLobby) and the menu still opens at ~500 ms.
- [Task M.4] Long-press opt-outs, live per press (no reload):
  `tl-gestures`='off' → a touch hold does NOTHING (no menu AND no card
  activation on lift; Android's native touch-derived `contextmenu` is
  silenced too) — remove the key after; `tl:prefs:v1`
  gestures.cardLongPress=false → same. Desktop MOUSE right-click keeps
  the Task 2.5 menu in BOTH states (the flag governs touch only, and
  the rename editor still gets the native input menu via the skip).
  Settings: the coarse-pointer panel shows "Card long-press"
  (`#sp-longpress`) and "Overlay swipes" (`#sp-overlayswipe`), both
  checked by default; neither renders on a fine-pointer panel. Gallery
  thumbs share the recognizer: long-press a `.gallery-cell` → the
  Open / Insert path / Download menu (actions covered by the Task 2.5
  thumb line).
- [Task M.4] Lightbox swipe-nav (upload 3 images for the battery session
  first — Task 2.5 curl recipe — then attach, open the gallery, tap the
  first thumb): `#img-lightbox` shows `.lb-chip` `1/3`; FINE-step
  horizontal drag left ≥50 px (axis lock |dx|>12 && >1.5|dy|; coarse
  dispatch false-greens — plan M.8) → chip `2/3` AND `img.src` swaps to
  the next grid-order URL (neighbors preloaded via `new Image()`),
  lightbox stays open; drag left again at `3/3` → rubber-band (0.3×
  follow) — chip/src unchanged, `img.style.transform` springs back to
  `''` within ~200 ms. The paste-preview lightbox (no nav) renders NO
  chip and never swipe-navigates.
- [Task M.4] Lightbox swipe-down dismiss: FINE-step vertical drag down
  ≥96 px (or a short fling >0.5 px/ms) → the box closes through the
  Task 2.3 closeOverlay (iframe `document.activeElement` is the
  `.xterm-helper-textarea` again) with the gallery grid still mounted
  underneath; a sub-96 px slow drag springs back (still open, backdrop
  alpha restores to 0.65). During a claimed drag the image
  follow-translates (0.85× down, 0.25× rubber up) and the backdrop
  fades 1−(dy/400). `gestures.overlaySwipe=false` (or the master kill)
  → the same drag is IGNORED (no follow, no dismiss; tap-to-close
  unaffected). Verified 2026-07-12 on the harness: 24/24 smoke legs
  green (long-press A/B/H, tap-attach, chip nav 1/3→3/3, rubber-band,
  dismiss+focus, opt-outs, settings rows).
- [Task M.4] Red line: §A.5 unchanged — the recognizers live on lobby
  cards, gallery cells and the per-open lightbox overlay ONLY (zero
  listeners added to the terminal surface or its document; the
  lightbox's `{passive:false}` touchmove is per-open on the OVERLAY box,
  removed with it — explicitly allowed by the plan, distinct from the
  M.6 standing-listener doctrine) — and the M.1 standing diff guard
  holds (touch-discriminator IIFE byte-identical to the Stage-A deploy,
  re-checked 2026-07-12). Cleanup: kill the battery session +
  `rm -rf /var/lib/clipboard-store/<osUser>/tl-battery-m4`.
- [Task M.5] Settings bottom sheet (390×844 coarse emulation; drags are
  raw CDP `Input.dispatchTouchEvent` with FINE steps on the grabber —
  coarse dispatch false-greens, plan M.8): tap the sidebar ⚙ →
  `#settings-panel` arrives inside a `.tl-sheet` (32×4 px
  `.tl-sheet-grip`, 'Terminal settings' `.tl-sheet-header`, modal
  `.tl-sheet-backdrop`) whose rect height ==
  `round(0.55 × visualViewport.height)` ±1 (55% detent) and whose CSS
  `bottom` is the `calc(var(--kb-offset, 0px) +
  env(safe-area-inset-bottom))` plumbing (NO new visualViewport
  listener anywhere — code-inspect); every Task 2.6/3.5/4.1/M.x control
  is present and live (A+ still moves `#font-size-value`), and a
  touch-drag on the CONTENT rows scrolls them natively without moving
  the sheet (drag surfaces are grabber/header ONLY). Grabber-drag UP
  past the 55/92 midpoint → height snaps to `round(0.92 × vvH)` ±1;
  grabber-drag DOWN >25% of the sheet height → sheet closes through
  closeSettings(true) → closeOverlay: type immediately → keystrokes
  land in the pty (`tmux -L tl-dev capture-pane -p -t main` shows the
  command). A sub-25% drag springs back (still open, same detent);
  backdrop tap and Escape close the same way; reopen → 55% again (the
  detent is per-open, not persisted).
- [Task M.5] Menu-as-sheet + opt-outs: long-press a session card (M.4
  recipe) → the SAME Task 2.5 items now inside a `.tl-sheet` (content-
  sized, CAPPED at the 55% detent — an up-drag rubber-bands back);
  tapping an item acts (and Rename keeps its keepFocus contract);
  backdrop tap resolves null with NO action; the M.4 trailing-click
  swallow still holds (the opening press never attaches). Gallery-thumb
  long-press inside the terminal iframe → same sheet presentation
  (Open / Insert path / Download). Opt-outs, live at the NEXT open (no
  reload): untick `#sp-sheet` (writes `gestures.bottomSheet=false`) or
  set `tl-gestures`='off' → settings reopens as the anchored popover
  and long-press yields the at-pointer `.popup-menu` again; desktop
  fine-pointer contexts NEVER see a sheet (popover/at-pointer always).
  Red line: presentation-only — zero terminal-surface listeners, zero
  touch\* listeners (grabber/header are per-open pointer-event
  surfaces with CSS touch-action:none; content scrolls natively), §A.5
  passes unchanged after a sheet open/dismiss cycle.
- [Task M.6] Gesture legs from here on dispatch through
  `scripts/devserve/gestures.py` (raw CDP `Input.dispatchTouchEvent`;
  Playwright's touchscreen is tap-only and coarse dispatch false-greens —
  FINE steps per plan M.8). Contexts: `p.devices['Pixel 7']` for
  Android-gated legs, `p.devices['iPhone 13']` for the iOS-negative leg
  (the recognizer gates on `navigator.userAgent`, so a real device
  descriptor is required, not just `has_touch`). Coordinates are OUTER-page
  viewport px (`#session-frame` bounding box + inner offset). Prefs
  isolation: legs below flip `gestures.*` — snapshot `GET /prefs` before,
  `PUT` it back after (standing rule above).
- [Task M.6] Module isolation (the RL-critical leg): Pixel-7 emulation,
  attach `#main`; in the iframe `window.__tlGestures` exists with
  `attached === false`, `recognizers === 3` (2f-tap + 3f-swipe + the
  Task M.8 pinch — pinch REGISTERS on any Chromium coarse pointer;
  its default-OFF flag is read per press, not at registration; was 2
  before M.8 landed); instrument a capture wheel
  counter on `#terminal`; `multi_swipe(page, [(cx, cy)], dx=0, dy=-60,
  steps=12)` (5 px steps) → copy-mode entered (§A.5 semantics), wheel
  counter counts the delivered moves past the 6 px discriminator
  threshold (Chrome COALESCES dispatched moves — measured 9 of 12
  delivered locally; the assert is EQUALITY with the same dispatch on a
  pre-M.6 build, floor ≥8), and `__tlGestures.attached` stayed `false`
  throughout (poll during dispatch) — 1-finger sequences traverse ZERO blocking listeners: the
  standing module listeners are capture+PASSIVE
  touchstart/touchend/touchcancel ONLY; the `{capture:true,passive:false}`
  document touchmove attaches at the 2nd touch and detaches at last
  touchend/touchcancel/pagehide. During any 2-finger sequence the module
  must never `preventDefault` (observe `defaultPrevented === false` from a
  later-registered document capture listener) — native pinch-zoom stays
  intact (M.8's flag-OFF leg re-asserts scale>1).
- [Task M.6] `‹`/`›` soft keys (universal affordance, engine-independent):
  two battery sessions `tl-battery-m6a`/`tl-battery-m6b` on the REAL
  server (isolation rules), attach `#tl-battery-m6a`; tap `›` → outer
  `location.hash` flips to the NEXT painted card name
  (`.session-card` DOM order — the same ring the Task 4.1 chords walk),
  `#session-pill` (role=status) flashes the target name for ~220 ms, and
  the scratch pane's `capture-pane -p` is UNCHANGED with
  `#{pane_in_mode}` still 0 (a session switch leaks no bytes/scroll into
  the pty); `‹` cycles back. Identical under iPhone emulation (the
  buttons are the iOS affordance; TalkBack-ready aria-labels
  'Previous session'/'Next session'). Row order now: Esc Tab ⇧Tab Ctrl
  Alt ↑↓←→ | ` / - Sel Mark Yank Copy Paste Kbd ‹ › (+ pinned ⌄).
- [Task M.6] 3-finger swipe (Android accelerator): Pixel-7 emulation,
  `multi_swipe(page, [3 points ≥32 px from side edges, inside the
  terminal], dx=-120, steps=12)` → hash flips to the NEXT card + pill,
  scratch capture-pane unchanged, `#{pane_in_mode}` 0; `dx=+120` → the
  PREVIOUS card. Threshold rejects (each → hash unchanged): same dispatch
  with `dy=60` (fails |dx|>2|dy| and the 24 px cumulative-|dy| gate); one
  start point at x=16 (32 px edge dead-zone — the OS back-gesture zones
  stay unfought); `hold_ms=450` before moving (>350 ms rest = the OEM
  partial-screenshot hold → abort); 2-point and 4-point dispatches (arm
  is EXACTLY 3). iPhone emulation: the same 3-point dispatch NEVER flips
  (recognizer not registered — iOS owns the 3-finger vocabulary while a
  text input is focused; exclusion #1).
- [Task M.6] Swipe opt-outs, live per gesture (no reload):
  `gestures.swipeSession=false` → 3-point dispatch does nothing; restore,
  then `tl-gestures`='off' → nothing (and `__tlGestures.attached` stays
  false even during the 3-finger sequence — the master kill also stops
  the lazy attach); remove the key → works again. Settings: an
  Android-UA coarse lobby panel shows '3-finger swipe' (`#sp-swipe`) and
  '2-finger tap' (`#sp-twofinger`), both checked by default; `#sp-swipe`
  does NOT render under iPhone emulation (gesture can't exist there) and
  neither row renders on a desktop fine-pointer panel.
- [Task M.6] 2-finger tap toolbar toggle: Pixel-7 emulation, attach
  `#main`; `two_finger_tap(page, cx, cy)` over the terminal →
  `body.has-soft-keys` drops, `#soft-keys` computed display 'none',
  'Two-finger tap to restore keys' toast (first hide per page-life),
  `tl:prefs:v1` `gestures.toolbarHidden === true`, and after the
  debounced refit the client rows GROW — read via
  `tmux -L tl-dev list-clients -F '#{client_height}'` (`display -p`
  resolves NO client from a script and prints empty; list-clients may
  also be transiently empty during an iframe swap — settle first);
  second tap → class + toolbar back, rows shrink, `toolbarHidden ===
  false`. Reject legs
  (each → no toggle): `travel_px=15` (>10 px per-finger travel);
  `span_delta_px=10` at `gap_px=60` (≥8% span delta = pinch start — and
  the dispatch still native-zooms nothing because the recognizer only
  observes); `hold_ms=300` (>220 ms). A 2-finger tap on the toolbar
  itself (not the terminal) does nothing.
- [Task M.6] toolbarHidden roams + anti-stuck: reload with
  `gestures.toolbarHidden=true` in `tl:prefs:v1` (a DIRECT localStorage
  write must also stamp `tl:prefs-dirty:v1`, or the next boot's /prefs
  GET adopts the server doc back over it — setPrefs stamps it for real
  users) → boots hidden
  (client_height at the grown value); with `tl-gestures`='off' OR
  `gestures.twoFingerTap=false` the SAME doc boots VISIBLE, and flipping
  either while hidden restores the toolbar live (tl-prefs message /
  storage event → applyToolbarPrefs) — the hidden state is honored only
  while its restore gesture exists, so a roamed doc can never strand a
  device. syncViewport's height branch now gates on `isCoarsePointer`
  (byte-equivalent while the toolbar is visible; hidden toolbar reads
  `offsetHeight` 0 → full-viewport terminal that still tracks the iOS
  keyboard).
- [Task M.6] Red line: §A.5 passes on BOTH emulated viewports, and the
  standing diff guard EXTENDS to a second block — besides the M.1
  touch-discriminator IIFE, the ADR-0003 drag-selection interceptor
  (`document.addEventListener('mousedown', (e) => {` through its
  hijack/ghost machinery, original :2043-2121) must be BYTE-IDENTICAL to
  the Stage-A deploy (`git show 6773cbd:frontend/index.html` extract ==
  HEAD extract), and `term.attachCustomKeyEventHandler(` appears exactly
  ONCE in HEAD. Verified 2026-07-12 at implementation time. *(Guard
  re-baselined by M.11 — two declared `term.focus()`→`tapFocus()` token
  swaps in this block; see [MF-6].)*
- [Task M.6] iOS 3-finger reservation probe (MANUAL, standing pre-deploy
  item for ANY change to terminal touch handlers + per major iOS
  release; first run: Viktor, noted in the deploy heads-up): open
  `scripts/devserve/ios-3finger-probe.html` on a real iPhone — Safari
  tab AND installed PWA — and walk variants A (hidden helper focused,
  production shape), B (visible textarea), C (blurred). Expected while
  exclusion #1 holds: A/B show the OS text-edit HUD and the page logs
  touchcancel / a starved (<3 moves) 3-finger stream; the 2-finger tap
  arrives cleanly everywhere. ANY variant showing a released 3-finger
  vocabulary → re-open the analysis exclusion before considering iOS
  terminal gestures.
- [Task M.7] Haptic vocabulary (mobile emulation so the soft-key row
  exists; install the spy in the TERMINAL IFRAME before interacting:
  `window.__vib=[]; navigator.vibrate=(p)=>{__vib.push(p);return true;}; true`
  — `haptic()`'s optional call resolves to the own-property spy; the
  trailing `true` matters: a Playwright `evaluate` whose string RESULT is
  a function INVOKES it once with `undefined`, ghosting a `[null]`
  entry): tap a
  soft key (e.g. `/`) → `__vib` gains `5` (selection grade — every
  makeBtn tap); hold ↓ past 500 ms → repeat ticks append more `5`s; the
  M.6 3-finger swipe commit (CDP recipe above, Android UA) and the
  2-finger toolbar toggle → `15` (impact grade — supersedes M.6's
  ad-hoc `[10,10]`); `window.__tlToast.add({type:'error',title:'x'})`
  → `[10,60,10]` (error grade; success/info toasts stay silent).
  Font-step commit: A+ tap at fontSize 15 → one `5`; at the 22 clamp →
  NO new entry (only committed steps tick).
- [Task M.7] Haptics opt-outs, live per call (no reload): set
  `tl:prefs:v1` `gestures.haptics=false` → the same soft-key tap adds
  NO `__vib` entry (bytes still reach the pty — the visual/functional
  path is independent); restore `haptics:true` + set `tl-gestures`='off'
  → silent again; remove the kill key. Settings: on a coarse-pointer
  lobby with `'vibrate' in navigator` (Chromium always) the panel
  renders a "Haptics" row (`#sp-haptics`, checked by default) whose
  untick writes `gestures.haptics=false` with all sibling flags intact;
  the row does NOT render on fine-pointer desktop (coarse block) — and
  never where the API is absent (iOS WebKit: manual checklist).
- [Task M.9] Maskable PWA icon serves (scratch clipboard-upload build,
  Task 3.1 recipe: `CLIPBOARD_UPLOAD_ASSET_DIR=$PWD/frontend` on
  :17683, harness `--clipboard-port 17683`): cookie-less, header-less
  `curl -si http://127.0.0.1:7997/icon-512-maskable.png` → 200
  `image/png` + `Cache-Control: public,max-age=3600`, body bytes ==
  `frontend/icon-512-maskable.png` (the repo artwork: existing 512
  glyph inset to the ~80% maskable safe zone — furthest non-bg pixel
  r≈155px < the 204.8px safe-circle limit — on a #0d1117 field, the
  icon's own bg AND the manifest background_color/theme_color).
- [Task M.9] Manifest carries all three icons: in-page
  `fetch('/manifest.webmanifest').then(r=>r.json())` → `icons.length
  === 3`; exactly one entry has `purpose: 'maskable'`
  (`src: '/icon-512-maskable.png'`, `sizes: '512x512'`), the two
  `purpose: 'any'` entries stay (purpose-any-only letterboxes on
  Android adaptive launchers; any-only removal would regress iOS/
  desktop), and `orientation` stays `'any'` (terminals want landscape —
  T3's portrait lock does not transfer).
- [Task M.9] Traversal probes still 404 against the same scratch build:
  `/icon-../etc/passwd`, `/icon-512-maskable.png.bak`,
  `/fonts/../icon-512-maskable.png` → 404 (exact-path table lookup —
  the new file adds no directory serving); `go test ./...` in
  `clipboard-upload/` green (the whitelisted-but-not-installed 404
  scenario keeps its regression test).
- [Task M.8] Pinch-to-font-size — probe instrumentation shared by the
  legs below (Pixel-7 emulation, attach `#main`): in the terminal
  iframe, BEFORE dispatching, install a BUBBLE-phase document touchmove
  probe —
  `window.__pz={n:0,consumed:[],cancelable:[]}; document.addEventListener('touchmove', e=>{ if(e.touches.length===2){ __pz.n++; __pz.consumed.push(e.defaultPrevented); __pz.cancelable.push(e.cancelable); } }, {passive:true}); true`
  — bubble on document fires AFTER the module's document-CAPTURE
  listener, so it observes the recognizer's preventDefault (a
  pre-registered capture probe would run first and false-red). All
  dispatches are FINE-step raw CDP via `gestures.py` (plan M.8: coarse
  dispatch false-greens — it never exercises Chrome's ~1-3-move
  cancelable-touchmove window; `pinch()` defaults give ≈2.5
  px/finger/move). Flag legs set the shared-origin localStorage key
  `tl:gesture-pinch-font:v1`='on' (any window — one store). fontSize
  isolation: snapshot `tl:prefs:v1`.fontSize + `tl-font-size` before,
  restore after (pinch steps also PUT the roamed doc — prefs-isolation
  rule above applies).
- [Task M.8] Flag-ON diverging pinch (the CLAIM): flag 'on',
  `pinch(page, cx, cy, span0=80, span1=255, steps=35)` centered on the
  terminal → `__pz.consumed[0] === true` with
  `__pz.cancelable[0] === true` (the claim consumes from move 1 — not
  post-classification) and `__pz.consumed.every(x=>x)` (EVERY
  delivered 2f move consumed; Chrome coalesces so delivered may be
  <35, but must be ≥3; measured 35/35 at implementation); at END
  `window.top.visualViewport.scale === 1` — native zoom never
  started. Scale is a TOP-window property: the iframe's OWN
  `visualViewport.scale` reads 1 in Chromium regardless of page zoom
  (measured — that's why the recognizer's gate reads
  `window.top.visualViewport.scale` via `pageScale()`). Iframe fontSize
  stepped ≥2 ABOVE the start value (span ratio 3.19 → clamps to 22
  from the default 15; steps arrive through the shared applyFontSize,
  so each commit ticks haptic `5` under the M.7 spy and repaints the
  grid), `tl-font-size` in step with `tl:prefs:v1`, and `#font-pill`
  (role=status) showed `Aa NNpx` with `.visible` during the burst,
  gone ≈220ms after touchend. Converging leg (`span0=255, span1=80`)
  → fontSize steps DOWN (toward the 10 clamp).
- [Task M.8] Flag-OFF native-zoom guard (STANDING red-line leg:
  `#terminal`'s `touch-action: pan-x pan-y pinch-zoom` must never be
  narrowed): key removed (= production default), same diverging
  dispatch → ZERO consumed moves and `window.top.visualViewport.scale
  > 1` (native pinch-zoom reached the compositor; measured 5 = the
  clamp. The unconsumed stream also shows Chrome's cancelable window
  live: `__pz.cancelable` = [true, false, false, …] — exactly why the
  claim must consume from move 1); reset with the CDP session's
  `Emulation.resetPageScaleFactor` and POLL the top scale back to 1
  (the reset settles asynchronously, ≈0.5s — a one-shot read
  false-reds); fontSize UNCHANGED. Repeat with flag 'on' +
  `tl-gestures`='off' → identical native-zoom result (the master kill
  stops the module's lazy listener attach itself, so nothing can
  consume); remove the kill key, reset scale.
- [Task M.8] Span-constant 2-finger pan (the RELEASE): flag 'on',
  `multi_swipe(page, [(cx-40,cy),(cx+40,cy)], dx=0, dy=-80, steps=16)`
  (two fingers, gap pinned at 80px) → consumed moves are EXACTLY the
  first 3 (`__pz.consumed` = [true,true,true,false,…]:
  classify-at-move-3 sees |span/span0−1| < 0.05 → RELEASE; the ~7.5px
  of swallowed centroid is the declared cost), every later move
  unconsumed (native resumes the pan), fontSize unchanged, no
  `#font-pill`.
- [Task M.8] Staggered join (the DECLARED LEAK — panic-zoom mid-scroll
  must stay native): flag 'on'; compose: `multi_swipe(page, [(cx,
  cy+40)], dx=0, dy=-80, steps=8, release=False)` (1-finger scroll in
  flight, finger stays down at (cx, cy−40)), then `pinch(page, cx, cy,
  span0=80, span1=200, steps=12, angle_deg=90)` — its touchStart
  continues finger 0 at (cx, cy−40) and JOINS finger 1 at (cx, cy+40),
  then diverges and releases all → ZERO consumed 2f moves
  (`__pz.consumed` all false: the join's moves arrive
  `cancelable === false` — probe legs G/N — and the recognizer
  RELEASES on the first one instead of fighting the compositor),
  fontSize unchanged.
- [Task M.8] 1-finger isolation (module untouched): flag 'on',
  `multi_swipe(page, [(cx,cy)], dx=0, dy=-60, steps=12)` →
  `__tlGestures.attached` false throughout, `__pz.n === 0` (no
  2f moves at all), §A.5 wheel semantics per the M.6 module-isolation
  leg (which now expects `recognizers === 3`).
- [Task M.8] Repaint mask (fit-burst dim): attach `#main`; in the
  iframe fire a stepper burst (3 changed-size `applyFontSize` calls —
  or A+ taps — ≤120ms apart) and poll
  `getComputedStyle(document.getElementById('terminal')).opacity`
  every ~50ms: during the burst it reads <1 (target 0.35 behind an
  80ms fade), and it returns to exactly `'1'` ≈180+80ms after the last
  call with the final grid aligned (box-drawing echo screenshot — no
  half-painted metrics frame). The mask is CONTAINER opacity only: the
  `.xterm` canvases' own computed opacity stays `'1'` throughout
  (WebGL contents never touched). The same dim wraps the outer-stepper
  path (lobby A+ → tl-prefs message → applyTermPrefs needFit) and
  lineHeight slides; a NO-OP apply (duplicate tl-font-size message)
  must not flash it.
- [Task M.8] Settings + defaults: a coarse-pointer Chromium lobby
  panel renders 'Pinch font size' (`#sp-pinch`), UNCHECKED by default
  (DEFAULT OFF stands until Viktor's real-device run of
  `scripts/devserve/pinch-probe.html` — chrome://inspect; the
  release-resume legs are the hardware-fragile part); ticking writes
  `tl:gesture-pinch-font:v1`='on' (plain per-browser key, never
  roamed), unticking REMOVES the key; the row does NOT render on a
  fine-pointer desktop panel. With the key set, the recognizer arms
  ONLY at `pageScale() ≤ 1.001` (order matters: REMOVE the flag, zoom
  in natively via dispatch, THEN set flag 'on' → diverging pinch
  consumes NOTHING while zoomed — native pinch stays the way back
  out; reset scale after. Zooming in with the flag already on gets
  CLAIMED instead and false-reds the leg — bit the implementation
  smoke).
- [Task M.8] Red line: §A.5 on both emulated viewports + the standing
  diff guards (M.1 touch-discriminator block AND the ADR-0003
  mousedown interceptor byte-identical vs `6773cbd` *(re-baselined by
  M.11: three declared token swaps — see [MF-6])*;
  `term.attachCustomKeyEventHandler(` exactly once in HEAD).
- [Task M.10] Compose bar default state + attributes (Pixel-7 emulation,
  attach `#main`; the bar is BUILT only on coarse pointers). **M.11
  re-based the default:** under DEFAULTS the bar is now VISIBLE at boot
  (see [MF-6]); this leg's hidden-at-boot baseline runs with
  `compose.show:'off'` seeded (or after the bar's ⌄): then `#compose-bar`
  computed display 'none' and terminal height ==
  `visualViewport.height − #soft-keys.offsetHeight` (baseline formula,
  ±2px) with `--sk-h` == the toolbar's px height; tap the ✎ soft key →
  `.visible` + `#compose-input` focused; assert on the TEXTAREA:
  `autocapitalize='sentences'`, `autocorrect='on'`, `spellcheck='true'`,
  `autocomplete='off'` (form-autofill only — keyboard suggestion/swipe/
  dictation stay), `inputmode='text'`, `hasAttribute('type')===false`
  (never inherits the helper's type=password trick), aria-label set,
  computed font-size ≥16px (INLINE — iOS focus-auto-zoom block),
  `enterkeyhint='enter'` under default prefs. Verified 33/33 at
  implementation (2026-07-12).
- [Task M.10] Decisive framing leg (byte-exact bracketed-paste send):
  scratch pane runs
  `stty -icanon -echo -isig -icrnl min 1 time 0; printf '\e[?2004h'; cat -v`
  (the A.1 sensor posture; `-icrnl` is LOAD-BEARING — with it on, the
  tty maps the pasted \r to \n and `cat -v` prints a newline instead of
  the `^M` this leg asserts on). Type `line1` ⏎ `line2` into the field
  (default 'newline' mode: Enter stays local, value gains the \n, the
  bar auto-grows one line, capture-pane UNCHANGED) → tap ▶ →
  capture shows `^[[200~line1^Mline2^[[201~^M`: ONE paste block, \n
  normalized to ^M INSIDE the bracket, the submit CR a SEPARATE
  sendInput('\r') OUTSIDE it; field clears and stays focused
  (keyboard up). Long-press ▶ (~700ms CDP `long_press` on the button
  center) with new text → same bracketed block with NO trailing `^M`
  + 'Staged (no Enter)' toast + field still focused.
- [Task M.10] enterKey modes are LOCAL to the field: flip the lobby
  panel's 'Compose Return' seg to Send → `enterkeyhint` flips to
  'send' live in the iframe (panel setPrefs → tl-prefs postMessage →
  applyComposePrefs); then Shift+Enter inserts a newline with capture
  UNCHANGED, and plain Enter submits `^[[200~a^Mb^[[201~^M`. Auto-grow
  clamps at 5 lines (scrollHeight clamp → overflow-y:auto past that).
- [Task M.10] Focus routing (guarded focusActiveInput): while the field
  is focused, tap soft Esc → capture gains exactly `^[` AND focus
  RETURNS to `#compose-input` (sendInput bypasses DOM focus; makeBtn's
  post-tap focus routes to the field only while it WAS the active
  input); soft ↑ (noFocus) → `^[[A`, focus unmoved. Tap the bar's ⌄ →
  bar hides, helper textarea focused (keyboard handed back), terminal
  height returns to the baseline formula; the SAME soft-Esc tap now
  focuses the helper textarea — byte-equivalent to pre-M.10 while the
  bar is off. Armed-Ctrl/Alt + typed-letter chords need terminal focus
  (documented limitation — compose is for prose).
- [Task M.10] Geometry (390×844): bar open ⇒ terminal height ==
  `vv.height − toolbar.offsetHeight − #compose-bar.offsetHeight` (±2px),
  bar's bottom edge docked on the toolbar's top edge (`--sk-h`
  plumbing), no overlap with the terminal; the floating action buttons
  ride `--cb-h` (72px + cb-h + kb-offset on coarse) so 📋 can never
  swallow ▶/⌄ taps — with the bar hidden both vars are 0px and every
  formula is byte-identical to the M.6 baseline. Growing the field
  refits at most once per height change (growAndRefit gates on
  offsetHeight delta + the 120ms debounce — no fit thrash).
- [Task M.10] Prefs + settings (values re-keyed by M.11 to TRI-STATE —
  see [MF-6] for the migration matrix): `compose:{show:'auto',
  tapFocus:'compose', enterKey:'newline'}` defaults in `tl:prefs:v1`
  (nested namespace, validated like gestures.*): localStorage
  `{"compose":42}` + dirty stamp + reload → whole namespace degrades to
  defaults (bar VISIBLE on coarse — 'auto' resolves per-device),
  enterkeyhint 'enter'; `{"compose":{"enterKey":"bogus","show":"off"}}`
  → bar hidden (valid subkey kept) and enterkeyhint 'enter' (bogus
  dropped per-field). Auto-open never focuses (no keyboard summon). A
  manual ✎/⌄ toggle beats show-reconciliation for the rest of the
  page-life (a prefs event after ⌄ must NOT re-open the bar). Coarse
  lobby panel renders 'Compose bar' (`#sp-compose`, CHECKED default —
  binary checkbox over the tri-state: paints `show !== 'off'`, writes
  only 'on'/'off') + 'Terminal tap' seg (Compose active default, M.11)
  + 'Compose Return' seg (Newline active default); the segs write the
  nested pref with siblings intact; none of these rows render on a
  fine-pointer desktop panel, and the desktop iframe does not even
  build `#compose-bar`. Panel flips PUT the roamed doc —
  snapshot/restore per the isolation rule above (a crashed run roams
  e.g. show:'off' to real devices; bit the implementation smoke).
- [Task M.10] Red line: full §A with compose OFF (`show:'off'` since
  M.11 — was the default); the standing diff guards extend over the
  compose surface — the helper-textarea suppression block, `sendInput`,
  the term.onData wrapper each BYTE-IDENTICAL to `6773cbd`, and the M.1
  touch-discriminator IIFE and the ADR-0003 mousedown interceptor
  **RE-BASELINED by M.11** (was: byte-identical to `6773cbd`; now:
  extract vs `6773cbd` differs by EXACTLY the three declared
  `term.focus()`→`tapFocus()` token swaps, all other bytes identical —
  full guard statement in [MF-6]), and
  `term.attachCustomKeyEventHandler(` exactly once in HEAD (verified
  2026-07-12 at implementation); the bar only CALLS the unchanged
  `term.paste()`/`sendInput()` primitives. 1-finger swipe/tap
  semantics unchanged with the bar open or closed
  (`__tlGestures.attached` stays false throughout).
- [Task M.10] Real-device checklist (MANUAL, mac/Appium iPhone rig or
  physical devices — first run: Viktor, per the deploy heads-up):
  Gboard swipe typing lands words in the field; iOS dictation runs
  WITHOUT blurring the field; an accepted autocorrect suggestion
  arrives in the sent paste; the Return key renders per enterkeyhint
  ('return' vs 'send' key face); focusing the field triggers NO iOS
  auto-zoom (inline 16px); send → text arrives in Claude Code's
  composer as one block, Enter-submit only when sent with ▶/Enter-mode.

### [C4] Theme picker → settings panel (MF-1; Viktor complaint 4: "move the theme in the settings menu")

All six legs run green 2026-07-12 at implementation (45 checks; run on a
second harness instance — proxy 7987 / ttyd 7986, scratch socket renamed
to `-L tl-mf1` — to coexist with a concurrent tl-dev run; adjust the
`tmux -L …` commands accordingly when repeating that setup).

- [C4] Panel grid + live apply: fresh context (clean localStorage), attach
  `#main`, make output + an ACTIVE drag-selection; open ⚙ → the panel's
  Theme grid (`#sp-theme`) renders 9 buttons with Slate active (the
  getTheme default); click Mocha → body class `theme-catppuccin-mocha`,
  `meta[name=theme-color]` = `#1e1e2e`, iframe
  `window.__term.options.theme.background` equals the new `--terminal-bg`
  computed value, the drag-selection **survives** (`hasSelection()` →
  `true`), the iframe did NOT reload (`__tlMark` intact — the Task 1.7
  live-retheme contract, now driven from the panel), and Mocha carries
  `.active` in the grid; reload the page → theme persists pre-paint (body
  already `theme-catppuccin-mocha` at `DOMContentLoaded`, no flash).
- [C4] System follow from the panel: click System → localStorage
  `tmux-theme` = `system`; `page.emulateMedia({colorScheme:'light'})` →
  body `theme-t3-light` + meta `#ffffff`; flip to `dark` →
  `theme-t3-dark` + meta `#161616`; both flips live (`__tlMark` intact).
- [C4] ACK fallback from the panel: in the iframe set
  `window.__tlSuppressThemeAck = true` → click a theme in the panel →
  after ~1s the iframe reloads into the new theme (stale-build fallback
  path preserved).
- [C4] Old picker gone: `#theme-picker` / `.theme-picker` /
  `.theme-picker-label` / `.font-size-row` / `#font-size-value` /
  `#font-size-dec` / `#font-size-inc` absent from the DOM AND from
  `frontend/index.html` source (grep → 0 hits; `.theme-options` renders
  only inside `#settings-panel`); the sidebar bottom is the lone ⚙
  Settings button pinned by `.settings-row`'s `margin-top:auto` +
  hairline `border-top`; zero console errors at boot and across settings
  open/close.
- [C4] Sheet mode (coarse pointer, M.5 default-on): the theme buttons are
  ≥44px targets at 14px type (the pointer-coarse `:where(.settings-panel)`
  rule + `.theme-options button` type step); a theme tap applies live
  WITHOUT dismissing the sheet; grabber drag-dismiss afterwards still
  refocuses the terminal (Task 2.3 contract).
- [C4] Font consolidation: the panel A−/A+ row steps 10-22 live (now the
  only lobby stepper — the sidebar row is removed); a prefs write from
  another same-origin window repaints the open panel via the storage
  listener; the terminal-mode floating A−/A+ cluster is unaffected
  (until MF-2).

### [C3] Floating action cluster off the terminal (MF-2; Viktor complaint 3: "the 5 buttons overlay on top of the terminal box and on mobile it shadows the textbox")

Coarse pointers no longer render the five floating buttons (display:none
— the elements STAY in the DOM as the function owners; row/palette
delegates `.click()` them); fine pointers pin the cluster top-right.
All legs run green 47/47 on 2026-07-12 at implementation, on a second
harness instance — proxy 7977 / ttyd 7976, scratch socket `-L tl-mf2` —
coexisting with a sibling run (adjust `tmux -L …` accordingly).

- [MF-2] Coarse geometry matrix (390×844 coarse harness, iframe on
  `#main`, bottom-anchored TUI mock — input box on the last 4 rows,
  `scripts/devserve`-style mockbox): in EACH of 4 states — kb closed /
  kb open (visualViewport shim 336px + `resize` dispatch) × compose
  hidden / visible (✎) — all five of
  `#paste-btn/#img-btn/#gallery-btn/#font-inc-btn/#font-dec-btn` have
  0×0 `getBoundingClientRect`; `#soft-keys` and `#compose-bar` rects do
  NOT intersect `.xterm-screen`; screenshot shows the mock input box +
  hint + status rows fully unobscured. Known harness artifact: the
  kb-open WebGL doubled-glyph paint is a headless vv-shim artifact only
  — assert DOM geometry, not pixels, there.
- [MF-2] Row functions: sk-row ends `[..., ‹, ›, 🖼, 📷, A−, A+]` and
  each delegate fires — 🖼 opens `#img-gallery` (backdrop click closes),
  📷 clicks `#img-input`, A−/A+ step `__term.options.fontSize` ±1
  (feedback is the M.7 haptic + the visible refit; the `#font-pill`
  readout rides ONLY the M.8 pinch path — `showFontPill` is closured in
  the pinch recognizer, deliberately not rewired). Row Paste with an
  IMAGE on the clipboard runs the full `#paste-btn` routine —
  `/clipboard/upload` + 'Pasted: /…' toast + path `sendInput` (assert
  the capture with ALL whitespace stripped: ZLE soft-wraps typed input
  via cursor moves, no tmux wrap marker, so `capture-pane -J` cannot
  join it — bit the implementation smoke).
- [MF-2] Isolation for the legs above: A−/A+ route through the roamed
  `/prefs` doc — GET-snapshot before, PUT it back after; uploads key
  under the hash session, so run paste legs attached to a
  `tl-battery-mf2` session (create via API, DELETE after; default-server
  `tmux ls` identical before/after).
- [MF-2] Desktop 1280×800 fine: all five render 48×48 at
  `top: calc(16px + safe-area)`, right offsets 24/80/136/192/248
  unchanged, computed z-index 9990 (< `#toast` 9999 — the toast stack is
  also top-right and must paint over the cluster); bounding boxes
  intersect NEITHER the last-3-rows band of `.xterm-screen` NOR any
  soft-key/compose element (desktop builds neither).
- [MF-2] `#img-preview` follows its launcher (transient — excluded from
  the static band assert): fine → top 72 / right 24 / z 9990, spatially
  BELOW the cluster, never covering it; coarse → parks above the
  soft-key + compose stack (`8px + --sk-h + --cb-h + --kb-offset +
  safe-area`; `top: auto` in the coarse override is load-bearing — an
  over-constrained fixed `<img>` with both edges set keeps `top` and
  would pin back under the cluster's fine-pointer spot). The retained
  `--cb-h` term is the MF-6 compose-default interlock.
- [MF-2] Red line: §A.5 passes unchanged — 1-finger swipe → copy-mode
  (`pane_in_mode` 0→1) with NO new focus (attach itself focuses the
  terminal per Task 2.3, so assert the swipe causes no focus CHANGE),
  tap → helper-textarea focus. No mouse/wheel/selection/scroll,
  6px-discriminator, or xterm-handler code touched; the change only
  REMOVES five z-9999 tap interceptors from over the input rows. The
  M.10 geometry leg's "floating buttons ride --cb-h" clause is
  SUPERSEDED by this section (coarse no longer renders them); full §A
  rides the MF-6 end-of-pass gate.

### [MF-3] Soft keys tap-commit + flat cycling history (Viktor complaint 1, ranks 2+4: "i dont like the side swipe to open all sessions")

Non-repeat soft keys fire on pointerup behind a <10px same-pointer travel
guard (was: instantly at touch-down — probe P3 reproduced a row-scroll
swipe landing on ‹/› flipping the session hash mid-swipe; the same defect
class fired Tab/Esc/Paste). Repeat keys (M.1 arrows + Tab) keep the
down-fire path byte-for-byte. Unframed soft-key/gesture session cycling
navigates via `location.replace` (history stays flat — the iOS
edge-back-swipe is never re-armed by cycling; palette attach keeps
`assign`). All legs run green 2026-07-12 at implementation on a sibling
harness instance — proxy 7967 / ttyd 7966, scratch socket `-L tl-mf3` —
adjust `tmux -L …` accordingly when repeating that setup.

- [MF-3] Inverted probe P3 (lift from scratchpad/swipe-probe.py): 1-finger
  80px horizontal swipe STARTING on '›', iPhone-class AND Android
  emulation → outer hash UNCHANGED, `.sk-row` scrollLeft changed, no
  iframe swap.
- [MF-3] Clean tap on '›' → hash cycles exactly as today; '‹' cycles
  back; 220ms `#session-pill` shows.
- [MF-3] Swipe starting on Paste → no clipboard read, no toast, no pty
  bytes; clean tap on Paste still pastes.
- [MF-3] M.1 repeat legs re-run verbatim: hold soft arrow → repeats;
  pointercancel mid-hold stops.
- [MF-3] Focus preservation legs re-run: helper textarea focused → tap
  Tab → bytes sent + focus retained; (post-MF-6 rerun) compose focused →
  tap '|' → focusActiveInput returns to compose field.
- [MF-3] Unframed top-level /?arg= tab: click '›' twice → session changes
  twice, history.length UNCHANGED (location.replace); palette attach
  still adds an entry.
- [MF-3] §A.5 re-run unchanged (terminal surface untouched).

### [MF-4] 3-finger session swipe DEFAULT-OFF via pref re-key (Viktor complaint 1, rank 3: "i dont like the side swipe to open all sessions")

`gestures.swipeSession` → `gestures.swipeSessionOptIn`, default **false**.
Re-key, not a plain default flip: pre-existing roamed /prefs docs
materialize `swipeSession:true` (Viktor's live doc verified carrying it),
and normalizePrefs drops unknown keys — so the stale value is structurally
ignored on every read and omitted from the next whole-doc write. No
migration write-back: default-false + dropped legacy key IS the disable; a
user re-enabling writes the new key durably. Recognizer registration block
untouched (per-press gate only — the settings toggle stays live without
re-registering); `tl-gestures` master-kill semantics unchanged; ‹/› soft
keys remain the universal session-cycling affordance (guarded by MF-3).
**SUPERSEDE NOTE for the [Task M.6] lines above:** the "3-finger swipe
(Android accelerator)" leg now requires `swipeSessionOptIn:true` pre-set
(seed prefs or check the row first), and in the "Swipe opt-outs" leg read
"`gestures.swipeSession=false`" as "`gestures.swipeSessionOptIn=false`"
and "both checked by default" as "#sp-twofinger checked, #sp-swipe
UNCHECKED by default". All legs run green 15/15 on 2026-07-12 at
implementation on a sibling harness instance — proxy 7957 / ttyd 7956,
scratch socket `-L tl-mf4` — adjust `tmux -L …` when repeating.
**SNAPSHOT+RESTORE the live /prefs doc around the whole run** (it is
Viktor's real roamed document, and legs 2-3 rewrite it): `GET /prefs`
(header `X-Authentik-Username: <user>`) before, byte-compare a `PUT` of
the snapshot after. Android legs = Pixel-7-class emulation; lift the P1
3-point dispatch and P2 iPhone re-run from `scratchpad/swipe-probe.py`
(P1 asserted the SHIPPED default-on behavior — expectations below
invert it).

- [MF-4] Fresh profile (clean localStorage): dispatch the P1 3-finger
  horizontal swipe over the terminal → outer hash UNCHANGED (inert by
  default) and `__tlGestures.recognizers` still 3 (registration
  unchanged); the 2-finger-tap toolbar toggle and the flag-off pinch
  legs still pass (module intact — only the per-press gate expression
  changed inside it).
- [MF-4] Legacy roamed doc ignored: seed localStorage `tl:prefs:v1` =
  `{"gestures":{"swipeSession":true}}` (Viktor's roamed shape — stamp
  `tl:prefs-dirty:v1` too, else the boot /prefs GET adopts the server
  doc over the seed) → reload → P1 swipe STILL inert; trigger any
  setPrefs (e.g. sk-row A+) → the persisted doc (localStorage AND the
  server doc after the debounced PUT) contains
  `gestures.swipeSessionOptIn:false` and NO `swipeSession` key.
- [MF-4] Settings opt-in: Android-UA panel shows the '3-finger swipe'
  row (`#sp-swipe`) UNCHECKED by default; check it → doc has
  `swipeSessionOptIn:true` → P1 swipe fires (hash cycles to the
  neighbor card + 220ms `#session-pill`); uncheck → inert again (live,
  no reload — per-press gate).
- [MF-4] iPhone-class UA: recognizer not registered, row not rendered
  (P2 re-run: `recognizers === 2`, the 3-finger dispatch is inert,
  `#sp-swipe` absent from the panel).
- [MF-4] Desktop fine-pointer panel: no gesture row rendered (existing
  assertion, unchanged).
- [MF-4] Red line: single-finger terminal path, 6px discriminator,
  wheel/selection semantics untouched — the M.1 + M.6 standing diff
  guards (touch-discriminator IIFE + ADR-0003 mousedown interceptor
  byte-identical vs `6773cbd`, `term.attachCustomKeyEventHandler(`
  exactly once) verified 2026-07-12 at implementation time. *(Guards
  since re-baselined by M.11 — see [MF-6].)*

### [MF-5] Hashless coarse-pointer boot reattaches the last session (Viktor complaint 1, rank 1: "i dont like the side swipe to open all sessions")

The iOS edge-back-swipe traverses to the pre-app (Authentik) history
entry, which redirects back to `/` WITHOUT the `#session` hash — the
lobby booted session-less onto the full list. The gesture can't be
removed; MF-5 fixes the LANDING: on coarse pointers a hashless boot with
the device-local marker `tl:last-active:v1` set (written by
activateSession, cleared by deactivateSession) re-fetches the sessions
list and reattaches the marked session if it still exists. Gated by the
NEW roamed pref `session.reopenLast` (default **true**; fresh namespace —
pre-existing roamed docs lack the key, so the code default applies
everywhere, no re-key dance). BOOT-ONLY: never wired to hashchange — the
hashchange→deactivateSession path stays the explicit in-app detach and
clears the marker. Reattach rides activateSession's existing
`history.replaceState` (history stays flat); the pushState-sentinel
approach is documented as REJECTED in-code (it would re-arm the gesture
M.3 disarmed). Desktop/fine pointers: unchanged (no auto-attach, no
settings row). **SNAPSHOT+RESTORE the live /prefs doc around the run**
(GET before, byte-compare, PUT back only if drifted — leg 3 seeds
localStorage prefs; never stamp `tl:prefs-dirty:v1`, that would PUSH the
seed onto the real roamed doc). All legs run green 20/20 on 2026-07-12
at implementation on a sibling harness instance — proxy 7947 / ttyd
7946, scratch socket `-L tl-mf5`, card sessions `tl-battery-mf5a/b`
pre-created on the real default server (isolation rules; killed after,
`tmux ls` byte-identical before/after) — adjust `tmux -L …` when
repeating. Harness coarse emulation = 390×844, `isMobile` + `hasTouch`,
iPhone UA.

- [MF-5] Attach a scratch card (`tl-battery-mf5a`) via card click →
  localStorage `tl:last-active:v1` = the session name. Open a NEW tab in
  the same context at `/` with NO hash (fresh load, marker seeded) →
  session AUTO-attached (hash becomes `#tl-battery-mf5a`, iframe
  visible), hash set via replaceState: `history.length` unchanged vs the
  post-goto baseline (fresh-tab shape: about:blank + goto = 2; any
  pushState would push past it) — the P4 flat-history re-assert.
- [MF-5] Seed the marker with a nonexistent name (`tl-battery-ghost`) →
  hashless boot → clean 'Pick a session' lobby (`#lobby-empty` visible,
  hash stays empty), marker CLEARED, zero console errors.
- [MF-5] Seed prefs `session.reopenLast:false` (+ marker) → hashless
  boot → list shown (switch honored), marker survives (switch-off is not
  a detach); coarse settings panel shows the 'Reopen last session' row
  (`#sp-reopen`) UNCHECKED.
- [MF-5] In-app detach (clear the hash → hashchange →
  deactivateSession) → marker cleared; reload hashless → list shown.
- [MF-5] Fine pointer 1280×800, marker seeded → hashless boot → list
  (desktop unchanged, marker untouched); desktop settings panel shows NO
  'Reopen last session' row.
- [MF-5] Existing M.3 flat-history leg re-run: `history.length` constant
  across 3 card attaches (post-attach the iframe overlays the collapsed
  mobile sidebar, so dispatch the card clicks via JS `el.click()` — same
  activateSession path; hit-testing is not under test).
- [MF-5] MANUAL (real device, Viktor's first pass per the standing
  deploy heads-up): the three iOS edge-back legs E1-E3 added to
  `scripts/devserve/ios-3finger-probe.html` — Safari tab post-Authentik
  login: edge-back-swipe → bounces through the flow page → relands
  ATTACHED to the previous session; installed PWA after an in-shell
  re-auth hop: same; after an explicit in-app detach: edge-back reland
  shows the LIST (marker cleared).

### [MF-6 / Task M.11] Compose-first mobile input (Viktor complaint 2: "the terminal isnt a textbox so i cant use autocorrect and other native keyboard features")

The M.10 bar existed but was opt-in and undiscovered. M.11 makes it the
DEFAULT phone experience: bar visible at session entry on coarse
pointers, terminal tap focuses the compose field (native keyboard),
schema re-keyed `compose.autoShow`(bool) → `compose.show`
('auto'|'on'|'off') with read-side coercion true→'on', false/absent→
'auto' — a bare default flip would have been inert: Viktor's roamed doc
serializes `autoShow:false`, indistinguishable from "never touched".
'auto' resolves per-device at apply time (coarse shows, fine ignores);
'on'/'off' are written only by the settings checkbox. New
`compose.tapFocus` ('compose' default | 'terminal') routes the tap; new
'Terminal tap' settings row; toolbar ⌄ now blurs whichever input is
active (pre-existing helper-only bug, default-path now); Kbd relabeled
'Raw terminal keyboard'; one-time coach toast (device-local
`tl-compose-hint:v1`) + once-per-page-life ✎ reopen hint. Reversible:
`show:'off'` restores the hidden bar; `tapFocus:'terminal'` restores
shipped tap focus; bar hidden = byte-equivalent shipped behavior.
enterKey default stays 'newline'. Fine pointers: unchanged in every
respect.

**MANDATORY isolation: snapshot+restore the live `/prefs` doc around
EVERY run** (GET before, byte-compare, PUT back if drifted — the
inverse of the documented M.10 incident: a crashed run must not roam
`show:'off'` to Viktor's phone).

**Standing diff guards — RE-BASELINED HERE (2026-07-12).** The M.1
touch-discriminator IIFE (`// Touch behaviour on the terminal canvas:`
through its `})();`) and the ADR-0003 mousedown interceptor
(`document.addEventListener('mousedown', (e) => {` through its
hijack/ghost machinery `}, true);`) are no longer byte-identical to
`6773cbd`. Declared delta — the ONLY permitted difference: **three
`term.focus()`→`tapFocus()` token swaps, all other bytes identical**
(IIFE: the `if (!moved && startY !== null)` touchend tap branch;
interceptor: the no-selection path after `dispatchSelectionClone(e)`
and the selection-held path's trailing `// we swallowed xterm's focus
click` line). Guard procedure from the MF-6 landing commit onward:
extract both blocks from `git show 6773cbd:frontend/index.html` and
from HEAD; `diff` must show EXACTLY those three one-line substitutions
and nothing else (verified mechanically at implementation). The
`tapFocus` seam itself (declaration above the interceptor, reassignment
in the coarse compose block) lives OUTSIDE both guarded regions.
`term.attachCustomKeyEventHandler(` still exactly once in HEAD.

- [MF-6] RED-LINE GATE (this task changes tap semantics on the terminal
  surface): FULL §A pass (A.1 selection, A.2 alt-screen, A.5, A.6) run
  TWICE — once with `compose.show:'off'` seeded (byte-equivalent
  baseline) and once under DEFAULTS (bar visible) — plus desktop
  fine-pointer legs (1280×800) proving the seam is behavior-identical
  there: tapFocus is never reassigned, click/drag/selection/focus per
  §A.1, no compose bar built, roamed compose.* ignored. §A.5 leg 3 runs
  as its 3a/3b/3c split (defined in §A.5).
- [MF-6] MIGRATION MATRIX (each seed: write `tl:prefs:v1`, reload, NO
  dirty stamp): seed `{"compose":{"autoShow":false}}` → bar VISIBLE at
  boot, `#compose-input` NOT focused, keyboard closed (auto-show never
  focuses); seed `{"compose":{"autoShow":true}}` → behaves as 'on' and
  the next natural setPrefs (flip any panel pref) persists a doc with
  `show:'on'` and NO `autoShow` key; seed `{"compose":{"show":"off"}}`
  → bar hidden + baseline tap (helper textarea focus). Unit-level
  matrix (14 cases incl. both-keys idempotence, garbage degradation,
  raw-input immutability) verified against the extracted
  normalizePrefs at implementation.
- [MF-6] RAW EXCURSION: defaults, bar visible → tap Kbd → helper
  textarea focused (aria-label/title 'Raw terminal keyboard') →
  soft-Esc → pty capture gains `^[` → tap the terminal → compose field
  focused again (one-shot excursion, no sticky mode).
- [MF-6] DISMISS: focus the compose field → tap toolbar ⌄ →
  `document.activeElement` blurred (keyboard drops) while the bar keeps
  `.visible`; with the bar hidden and helper focused, ⌄ still blurs the
  helper (pre-M.11 behavior intact).
- [MF-6] TOAST: fresh profile (no `tl-compose-hint:v1`) → coach toast
  exactly once ('Type in the bar below…', top-of-viewport, never
  overlapping the bottom bar) + the key set; second reload → silent;
  seeded `show:'on'` on a fresh profile → NO toast (only the 'auto'
  transition coaches); first ✎/⌄ collapse per page-life → '✎ brings the
  compose bar back' once (second collapse silent; new page-life hints
  again).
- [MF-6] STATUS ROW: compose mode (bar visible, field focused), tmux
  mouse mode on → tap the tmux status line → window switches (SGR
  replay lands) AND focus follows the routing (tapFocus →
  `#compose-input` under defaults) — the interceptor's status-row
  branch is byte-untouched; only the focus sites route.
- [MF-6] SETTINGS: coarse panel — 'Compose bar' CHECKED under defaults;
  uncheck → persisted doc carries `show:'off'` (no `autoShow` key) →
  reload → bar hidden, tap → helper textarea; re-check → `show:'on'`,
  bar reopens. 'Terminal tap' seg (Compose|Keyboard) → Keyboard →
  `tapFocus:'terminal'` roams and a terminal tap focuses the helper
  with the bar open (leg 3c). 'Compose Return' row unchanged. Desktop
  fine-pointer panel: NO compose rows; a roamed compose.* doc is
  ignored on fine (no bar, no routing).
- [MF-6] GEOMETRY re-runs: the M.10 geometry leg (390×844) in the NEW
  default state — bar open at boot ⇒ terminal height ==
  `vv.height − toolbar.offsetHeight − #compose-bar.offsetHeight` (±2px),
  no overlap (syncViewport already subtracts `--cb-h`; no new
  geometry); MF-2's cluster leg re-run in compose-VISIBLE state
  (`#img-preview` rides `--cb-h` above the bar; floating cluster still
  display:none on coarse).
- [MF-6] Mixed-build LWW window (documented, accepted): an OLD-build tab
  re-serializes `autoShow` and drops `show` on its next write — the
  M.*-class whole-doc clobber, healed by the stale-tab reloader within
  minutes of deploy; noted in the deploy heads-up.
- [MF-6] REAL-DEVICE additions to the standing iOS checklist (first
  pass: Viktor, per the standing deploy heads-up): auto-shown bar does
  NOT raise the keyboard at session entry; a terminal tap opens the
  keyboard WITH the suggestion strip (compose field); Kbd opens it
  WITHOUT (helper textarea); dictation and swipe-typing work in the
  bar; the coach toast reads correctly on a 390pt viewport.
- [Add-1] Advanced → Clear local data: open ⚙ → an 'Advanced' group
  holds 'Also reset roamed settings' (`#sp-clear-roamed`, unchecked)
  and a 'Clear' danger button. Seed several app keys (e.g. `tmux-theme`,
  `tl-font-size`, `tl:prefs:v1`, `tl:notify:v1`, `tmux-sidebar-collapsed`,
  a user-suffixed `tmux-collapsed-<user>`) plus a `sessionStorage`
  entry; click Clear and accept the `confirm()` → localStorage holds
  ZERO `tl:*`/`tl-*`/`tmux-*` keys, `sessionStorage` is empty, a success
  toast shows, and the page `location.replace()`s to `location.pathname`
  (no `#hash`, no `?query`). With 'Also reset roamed settings' CHECKED,
  point the harness at a SCRATCH tmux-api (`--tmux-api-port`, disposable
  `TMUX_API_PREFS_DIR` — never the live `/prefs`): a `PUT /prefs` of the
  normalized defaults lands BEFORE the local wipe (`GET /prefs` echoes
  the defaults doc); a PUT failure toasts the error and still clears
  locally. `tmux ls` (default server) unchanged before/after.
- [Add-2] Reload action: the lobby header shows a ⟳ button
  (`#reload-toggle`) beside the 🔔 bell on BOTH fine and coarse pointers
  (44px square under `pointer:coarse`); clicking it triggers
  `location.reload()` (stub `location.reload` or watch for a navigation
  to assert — the build stamp re-logs in the console). The ⚙ settings
  panel carries a 'Reload app' row (`.sp-btn` labelled 'Reload') that
  does the same, present in both the popover and the bottom-sheet
  presentations. Neither control touches localStorage or tmux state.
- [Add-3a] Soft-key strip pre-fit: at a 390×844 coarse viewport, attach
  `#main` and record `window.__term` cols×rows immediately at boot, then
  again after ≥2s (past the toolbar build) → IDENTICAL (no post-toolbar
  reflow). `document.body.classList.contains('has-soft-keys')` is true
  from boot, BEFORE `#soft-keys` exists in the DOM (assert the class
  while `document.getElementById('soft-keys')` is still null on a slowed
  boot, or code-inspect: the matchMedia add sits before `term.open`).
  On a fine-pointer viewport the class is absent (desktop unaffected).
- [Add-3b] Opacity-hold: `#terminal` boots at inline `opacity:0` and is
  revealed (inline opacity cleared → computed `1`, 80ms fade) only after
  BOTH the boot-end fit AND the first WS output frame (first frame
  reveals ~120ms later). After a normal attach settles,
  `getComputedStyle(document.getElementById('terminal')).opacity` → `1`.
  Hard cap: block WS output (harness delay / no frames) → the terminal
  still reveals within ~1.5s of open (never hangs blank). maskFitBurst
  is a NO-OP while hidden (a pinch/stepper fit during the hold does not
  flash the container to 0.35 — assert opacity stays 0 until reveal).
- [Add-3c] loadingdone fit gate: after boot (booted=true) dispatch
  `document.fonts` `loadingdone` in the terminal iframe → NO tmux resize
  (`tmux -L tl-dev display -p '#{client_width}x#{client_height}'`
  unchanged) but the terminal still renders (clearTextureAtlas ran
  unconditionally — screenshot matches pre-dispatch). Before the
  boot-end fit the same event DOES refit (code-inspect the `!booted`
  gate; the pre-boot late-face refit path is preserved).
- [Add-3d] ttyd -I index caching (verified 2026-07-12 on the rebuilt
  out/ttyd): first `GET /` → `HTTP 200` + `Cache-Control: no-cache` +
  strong `ETag: "<hexsize>-<hexmtime>"` + Content-Length; a conditional
  `GET /` with `If-None-Match: <that etag>` → `HTTP 304 Not Modified`
  (same ETag + Cache-Control, no body); a stale If-None-Match → `200`.
  Regression guards on the SAME binary: `flowprobe.py` PAUSE leg →
  `pause_honored: true` and the `--no-pause` throughput leg streams to
  quiesce with no stall (pixel-size + PAUSE hunks byte-identical to the
  prior verified patch); §A.4 sixel still renders (≥100 colors).
- [Add-4] Notifications Part 1 — SW delivery + gate + seeding. Serve
  side: `go test ./...` in clipboard-upload green incl. `/sw.js` served
  `application/javascript` + `Cache-Control: no-cache` (fixture,
  served-table and fallthrough=false cases extended); a cookie-less
  `GET /sw.js` through the harness returns the worker bytes. Frontend:
  `navigator.serviceWorker.register('/sw.js')` at lobby boot inside a
  try/catch — a 404 before the infra route lands must NOT break boot
  (console clean, terminal echoes). notifyTransitions prefers
  `(await navigator.serviceWorker.ready).showNotification`; the bell
  toggle toasts "not supported" when NEITHER the SW registration NOR a
  usable Notification constructor exists. Gate (fake-claude recipe from
  Task 2.1, scratch `tl-battery-*` names only): with permission granted +
  opted in, a `running→awaiting` transition fires EXACTLY ONE notification
  while the window is `away()` — hidden (hidden-shim) OR
  visible-but-blurred — and NONE while focused+visible (the old
  `!document.hidden` gate missed the blurred case); tag `tl-<session>`
  coalesces re-fires. Seeding: a session first seen ALREADY `awaiting` on
  a LATER poll announces once; the very first poll after load stays silent.
