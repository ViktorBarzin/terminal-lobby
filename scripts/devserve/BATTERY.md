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
