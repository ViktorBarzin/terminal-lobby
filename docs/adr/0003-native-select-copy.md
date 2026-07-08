# Native select/copy is client-side, via synthetic modifier events

The terminal's copy/paste contract (Viktor, 2026-07-08): a plain mouse
drag selects text and the selection persists after release; Ctrl+C —
Cmd+C on Mac — copies it, working under ANY keyboard layout (Cyrillic
included) and with CapsLock; Ctrl+C with no selection stays SIGINT;
Cmd+C never sends anything to the PTY; Ctrl+V/Cmd+V pastes,
layout-proof. No copy-on-release, no right-click paste, no
Shift/Ctrl+Insert. Wheel scrolling, right-click, and modifier-carrying
clicks keep reaching tmux and the apps inside it as before.

This can only be solved client-side, in `frontend/index.html`. Claude
Code panes put the terminal in any-event mouse tracking
(`mouse_any=1`), so drag events tunnel straight past tmux to the app —
a server-side or tmux-config fix can never see them. Only the browser
sees every mouse event first.

Mechanism: tmux (and Claude Code inside it) keep the terminal in
mouse-report mode, where xterm.js only selects while a force-modifier
is held — Shift, or Option on Mac via `macOptionClickForcesSelection`
(constructor-only; without it the synthetic Alt-clicks below leak to
the app). A capture-phase `document` mousedown listener intercepts
unmodified left presses over `.xterm-screen` and re-dispatches a
synthetic clone carrying that modifier, so xterm's own
SelectionService provides drag growth, double-click words, and
persistence. xterm registers its mouse reporters only for presses it
processes itself, so nothing leaks to the PTY during a hijacked drag.
The bottom row (tmux status line) is exempt: real clicks there switch
windows, which matters more than selecting the status line.

Copy/paste chords are matched layout-proof. `e.key` follows the
layout — under Cyrillic, Ctrl+C reports 'с'/'ъ'/'ц', an
`e.key === 'c'` match fails, and the chord falls through as ^C: SIGINT
with a visible selection. `e.code` is the physical key position. We
match `e.key` first while it is a Latin letter (Dvorak-style remaps
stay correct) and fall back to `e.code` only when the layout yields a
non-Latin key; lowercasing handles CapsLock/Shift; AltGr (Ctrl+Alt)
chords are excluded; keydown only (xterm consults the handler on keyup
too).

tmux copy-mode copies reach the OS clipboard through the OSC 52 addon
with a custom provider: tmux 3.4 emits an EMPTY selection field
(`\x1b]52;;<base64>`), which the addon's default provider drops — it
accepts only exactly 'c' — so copy-mode copies never reached the
browser clipboard. The provider accepts '' and 'c'. Its `readText`
deliberately refuses: answering OSC 52 '?' queries would let any
program running in the PTY read the user's clipboard.

## Considered Options

- **xterm 6.1.0-beta's `mouseEventsRequireAlt`** — the exact feature
  (plain drags select even in mouse-report mode) but beta-only at the
  time of writing; the synthetic-modifier interceptor is the
  stable-release equivalent. Revisit when 6.x goes stable.
- **Copy-on-release** (selection lands on the clipboard automatically)
  — rejected (Viktor, 2026-07-08): every stray drag would clobber the
  clipboard.
- **tmux-side copy-mode bindings / config** — unreachable: with
  `mouse_any=1` panes the drag goes to the app, not tmux, so no tmux
  binding can ever fire on it.
- **Shift/Ctrl+Insert and right-click paste** — deliberately left out;
  the surface is kept minimal by request.

## Consequences

- Plain left presses over the screen (bar the bottom status row) no
  longer reach tmux/apps at all — that input class is spent on
  selection by design. Wheel, right-click, and Ctrl/Cmd-clicks are
  delivered unchanged; Shift-click already forced selection before
  this change, and on Mac Option-click now joins it (the cost of
  `macOptionClickForcesSelection`).
- Selection is bounded to the visible frame: tmux attaches on the
  ALTERNATE screen, so xterm's scrollback holds nothing while attached
  (`scrollback: 10000` is inert there). Deep history stays tmux
  copy-mode's job — and its copies now land on the OS clipboard via
  OSC 52, with the same "Copied" toast as the chord.
- The interceptor acts only on trusted events (`isTrusted`), so its
  own clones pass through untouched — the synthetic path cannot
  re-enter itself.
- Pastes go through `term.paste()` rather than raw PTY input, so
  bracketed paste is honored (multiline text no longer executes
  line-by-line in shells) and `\r\n` is normalized.
- Verified end-to-end against a live ttyd+tmux pane with
  `scripts/dev-harness.py` (41/41 assertions, Linux + emulated Mac).
