# T3-Code UX parity — deep-analysis record (2026-07-11)

Provenance: multi-agent analysis workflow `terminal-ux-deep-analysis` (run `wf_7b2f4720-3f5`,
13 agents, 6 parallel surveys → synthesis → completeness critic → 4 live-verification probes →
revised matrix). Sources: `~/code/t3code` (T3 Code source @ v0.0.29-nightly), this repo, live
devvm/production checks, xterm.js/ttyd docs (context7), VS Code terminal defaults, web research.
This file is the research record; the actionable plan is `2026-07-11-t3-ux-parity.md`.

## Survey summaries

### T3 visual design system
Tailwind v4 + shadcn (zinc base); ~30 semantic CSS variables on `:root` with a `.dark` variant.
White/#161616 backgrounds, alpha-based neutrals (black/white at 4–10% for borders/inputs), one
blue primary (#1b4ed8 light / #366ffb dark), 10px base radius. UI face: DM Sans Variable
(self-hosted @fontsource-variable); code/terminal: SF Mono-first stack falling back to
self-hosted JetBrains Mono 400/500 (xterm fontSize 12, lineHeight 1). Signature polish: 3.5%
SVG fractal-noise grain over body, 1px inner bevel on raised surfaces, 5%-opacity shadows,
6px rounded scrollbars matched inside xterm, hand-tuned 16-color ANSI palettes whose bg/fg are
read live from the app theme.

### T3 terminal rendering
T3 does NOT render Claude Code through a terminal: Claude sessions run server-side via the
agent SDK and render as a virtualized structured React chat. Its actual terminal is a secondary
drawer: stock xterm.js 6.0.0, fit addon only, DOM renderer, scrollback 5000, hand-tuned ANSI
palette derived from app CSS (`ThreadTerminalDrawer.tsx:145-198`). Server side persists 5000
lines of history and strips DSR/CPR/DA/OSC-10/11/12 query replies before persisting
(`Manager.ts:869-897`) — directly relevant to our bare-viu leak class. Tab titles via 1s
subprocess polling (we get this free from tmux `pane_current_command`).

### T3 interaction patterns
Declarative keybinding table with VS Code-style `when` contexts feeding a window dispatcher +
xterm `attachCustomKeyEventHandler` (chord-exact only). Priority-ranked colored status pills
(Pending amber > Awaiting indigo > Working sky+pulse > Plan violet > unseen-Completed emerald),
hold-mod-100ms numbered session-jump badges, 1/2/4/8/16s reconnect ladder reset after 30s
stable, instant retry on visible/online, single self-updating "requests slow" toast at 15s,
namespaced+versioned localStorage (`t3code:*:v1`), pre-hydration theme boot script. Notably T3
web has NO Notification API / favicon badge / sound — we can leapfrog there.

### Current stack (terminal-lobby)
Single 3137-line `frontend/index.html` (no build step) served by patched ttyd 1.7.7; six
xterm.js 5.5.0 assets from jsdelivr `.min` URLs; 4-theme CSS-var system (carbon/slate/mono/ink).
ttyd serves ONLY `/` — live-verified: `/manifest.webmanifest` + icons 404 (and 302 to Authentik
cookie-less), so PWA install is doubly broken. Fonts are aspirational: 'JetBrains Mono' named
but no @font-face — most clients render OS fallbacks. fontSize hardcoded 15; no ANSI palette
theming (light `ink` theme runs xterm's dark defaults). Deploys restart
ttyd/ttyd-ro/tmux-api/clipboard-upload; tmux servers survive (systemd-run user scopes);
stale-tab healer reloads clients. tmux 3.4, mouse on, tmux-256color, set-clipboard on.

### Claude Code TUI needs
Truecolor output; Unicode box-drawing + braille + its own spinner/status glyphs; OSC 52; sixel
(already working via local ttyd patch); bracketed paste; mouse mode 1003 with the ADR-0003
selection machinery layered on top; ~120×40 minimum for workflow trees; scrollback inert under
tmux alt-screen (tmux copy-mode owns history).

### Industry practice
xterm.js stable is 6.0.0 (canvas renderer deleted; UMD bundles still shipped). Biggest quality
levers vs VS Code-class terminals: real @font-face (fonts gated via `document.fonts.load()`
BEFORE `term.open()`), `minimumContrastRatio: 4.5` (VS Code default; excludes box/block glyphs),
Unicode-11 width tables, window padding (Ghostty signature), full 16-color themed ANSI palettes
(Catppuccin flagship), `cursorInactiveStyle: 'outline'`. jsdelivr `.min` variants are
dynamically generated → SRI must use published non-`.min` files only.

## Critic probes (all four live-verified 2026-07-10)

1. **JetBrains Mono glyph gap (fc-query on JBM 2.304):** braille U+2800–28FF entirely absent,
   as are Claude Code's live spinner/status glyphs ✢✳✻✽⏺⎿✔☐☒⏵◼※. Box drawing, blocks/shades,
   powerline ARE covered. Cascadia Mono, DejaVu Sans Mono, both Noto Symbols faces fail the
   battery; **Iosevka 34.7.0 and JuliaMono 0.062 pass**. → JBM webfont alone would be a strict
   regression; ship a subset symbols fallback face in the same commit.
2. **PWA manifest fetch is credential-less by spec** (W3C: manifest fetch omits credentials even
   same-origin) AND ttyd 404s the files; an ingress route cloned from `/clipboard/` would carry
   forward-auth and still 302. → needs the `auth="none"` carve-out pattern (proven in
   `infra/stacks/tasks/main.tf:296-328`) + Go asset handlers.
3. **jsdelivr `.min` files are dynamically generated** (live banner: "Do NOT use SRI with
   dynamically generated files!"); npm packages ship no `.min` files. → SRI only on published
   non-`.min` paths (JS actually shrinks ~273 B/tag; CSS grows +2.7 KB).
4. **ttyd client flow control is a no-op in 1.7.7 and upstream main**: `process->paused` is set
   true at spawn and never cleared, so PAUSE ('2') early-returns (`pty.c:124,470`); live WS probe
   confirmed output continues at 108–260 KB/s after PAUSE. Client-side counters alone would be
   inert. → ~6-line server patch folded into our existing local patch, then port stock client
   counters (limit=100000, highWater=10, lowWater=4). Measured client exposure: 2.4 MB queue
   growth + 981 ms stalls under 6× CPU throttle; 4 MB synthetic burst → 6.2 MB peak, 13.6 s frozen.

## Feature matrix

30 features, priority-ordered; 13 quick wins; 19 deliberate exclusions. Full matrix with exact
values, file:line evidence, risk classification (`touches_mouse_scroll_selection`, `reversible`)
embedded in the implementation plan tasks. Headline exclusions (with reasons recorded so no
future session re-litigates): T3's structured chat renderer (abandons the true-terminal
premise), chat composer / "Add to chat" bubble (red-line adjacent), smoothScrollDuration +
scroll-to-end pill + wasAtBottom refit (red line / alt-screen no-ops), @xterm/addon-search
overlay (alt-screen buffer holds one frame; history is tmux copy-mode's job),
@xterm/addon-ligatures (Node-only), Berkeley Mono (license bars terminal embedding),
allowTransparency/backdrop-blur on canvas (perf), in-page splits (tmux owns layout),
`crossorigin="use-credentials"` manifest fix (WebAPK/iOS icon fetchers are cookie-less
server-side — carve-out is the only correct fix), SRI on `.min` URLs (bricks on jsdelivr
re-minification).

## Challenge round (2026-07-11, planning.md §2b — two blind disprove-briefed challengers)

Both attacked the plan independently; findings reconciled into the plan same-day:
- **BLOCKER caught:** Task 4.1's `attachCustomKeyEventHandler` call would have REPLACED the
  existing handler at `index.html:2503` — the entire ADR-0003 copy/paste/Escape contract.
  Fixed: merge the chord branch into the existing handler; keybindings layer defaults OFF.
- **MAJOR:** `#terminal` is content-box → window padding needs `box-sizing: border-box` or it
  overflows and fights the mobile keyboard height path. Fixed in Task 1.9.
- **MAJOR:** client flow control was fail-closed (a stuck PAUSE freezes a user's output).
  Fixed: 4 s watchdog auto-RESUME + localStorage kill-switch + un-paused throughput control in
  flowprobe. Server patch verified line-exact against real ttyd 1.7.7 source by BOTH challengers
  (no deadlock; PAUSE cannot affect the app, other clients, or mid-drag selection).
- **HIGH (reuse):** `scripts/dev-harness.py` already implements the local proxy harness the plan
  was about to rebuild in Go. Plan now extends it (scratch `tmux -L tl-dev` server, port params).
- Mobile hardening (P27) was mostly ALREADY implemented (stale analysis claim) → task rewritten
  as audit-and-fill-gaps. Iosevka TTF must come from the GitHub release ZIP (jsdelivr /gh/ has
  no built TTFs). Fonts now VENDORED + self-hosted via the same public asset route as the PWA
  files (jsdelivr kept only as @font-face fallback src). Deploys staged A (Wave 0-2) / B (Wave
  3-4) with SSH held open as the recovery channel; ttyd binary kept aside as `.prev`.
- Verified-true (don't re-litigate): rename endpoint exists; /layout is a clean /prefs clone
  with real tests; ingress_factory strips nothing + full_host trap documented; walloff ordering;
  ADR-0003 replay math self-corrects under padding; overscroll-behavior can't affect the
  synthetic-wheel path; live theme switch preserves selection; SRI non-.min URLs 200 + ACAO:*.
- Challenger dissent NOT adopted (recorded): defer flow-control (3.4/3.5) and the server half of
  roaming prefs (2.6) as beyond-the-ask. Kept because the stated goal is industry-grade UX
  robustness incl. Claude workflow floods; risk is mitigated by watchdog+kill-switch+staged
  deploy, and each is one-revert reversible.

## Standing constraint (red line)

Nothing may alter mouse/wheel/selection/scroll semantics (Viktor, stored preference; a prior
mouse-mode change broke his workflow and was reverted). Alt-screen TUI scrolling must keep
working exactly as-is. Every change here is additive and independently revertible; the four
flagged items (window padding, live theme switch, mobile viewport hardening, xterm 6 upgrade)
carry explicit regression steps against the ADR-0003 battery; xterm 6 is deferred to a
follow-up after this pass soaks.
