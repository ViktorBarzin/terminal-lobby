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
  (kill button or `DELETE /api/sessions/<name>`).
- Never touch sessions you didn't create. The session cards in the lobby are
  real. (Merely *attaching* a card is safe: the harness ttyd command is fixed,
  ignores the URL arg, and always attaches scratch `main`.)
- Before/after every battery run: `tmux ls` (default server) must list the
  same session names.

## A. Red-line battery (run after EVERY wave and before deploy)

Every item asserts behavior identical to the golden baseline. Any deviation is
a stop-the-line failure.

### A.1 — 1003h any-motion mode: drag-selection survives buttonless motion

1. `tmux -L tl-dev send-keys -t main "printf '\e[?1003h\e[?1006h'; cat" Enter`
   (pane now requests all-motion mouse reports, SGR-encoded; `cat` holds the
   tty).
2. In Playwright, drag-select over visible text on the terminal (mouse down →
   move a few cells → up).
   **Expect:** `window.__term.hasSelection()` → `true`.
3. Move the pointer buttonless over `.xterm-screen` — a **trusted** move
   (Playwright `page.mouse.move`), NOT a JS `dispatchEvent` clone: the swallow
   guards `isTrusted` moves only and deliberately passes untrusted clones
   through (they are the frontend's own selection machinery — an untrusted
   move WILL be reported, `cat` echoes it, and that output clears the
   selection).
   **Expect:** the selection **survives** (the xterm#7378 buttonless-motion
   swallow: no motion report reaches the pane while a selection exists).
4. Press Escape.
   **Expect:** selection clears AND the key reaches the app — flow restored
   (one more `^[` echoed by `cat` than before the keypress).
5. Cleanup: `tmux -L tl-dev send-keys -t main C-c` (ends `cat`; the plan text
   said `q`, but `cat` only dies to interrupt), then
   `tmux -L tl-dev send-keys -t main "printf '\e[?1003l\e[?1006l'" Enter`.

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
  gallery panel radius `18px`; `#toast` radius `8px`; `.new-row
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
