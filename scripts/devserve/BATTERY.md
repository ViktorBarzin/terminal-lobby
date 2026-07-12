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
3. Dispatch a tap (touchstart → touchend, ΔY ≤ 6 px).
   **Expect:** the terminal focuses (helper textarea → soft keyboard path).
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
  cache policy); `/icon-512-maskable.png` → 404 (whitelisted now, the
  file ships with Task M.9); each of the 5 vendored fonts under
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
  extract). The modifier state machine (softMods/tapMod/paintMod) is
  likewise untouched.
