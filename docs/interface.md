# Using the lobby

Keyboard shortcuts, the session image gallery, themes, and how the lobby
behaves on a phone.

## Keyboard shortcuts

Switch sessions and drive the lobby without the mouse. The shortcut layer
is **on by default** (per-browser; uncheck **App shortcuts** in ⚙ Settings
to send these keys to the terminal instead — the opt-out persists). Chords
are user-overridable via the `tl:keybindings:v1` localStorage key.

**Hold `Alt`** for ~100 ms to reveal numbered chips on the first ten
sidebar cards, then press the digit to jump (on macOS the UI shows `Alt`
as `Option` — the labels in the help overlay, tooltip and hint follow the
viewer's platform):

| Chord | Action |
|---|---|
| `Alt+1` … `Alt+9` | Attach the 1st–9th session (sidebar order) |
| `Alt+0` | Attach the 10th session |
| `Alt+Shift+[` / `Alt+Shift+]` | Cycle to the previous / next session |
| `Alt+Shift+Enter` | Jump to the next session **awaiting input** (amber dot) |
| `Alt+Shift+S` | Toggle the sidebar (fullscreen terminal ⇄ lobby) |
| `Alt+Shift+N` | New session (focus the name box) |
| `Alt+Shift+W` / `Alt+Shift+R` | Kill / rename the current session |
| `Alt+Shift+Backspace` | Kill the **attached** session — from anywhere, even mid-type (always on) |
| `Ctrl+Shift+K` | Command palette (fuzzy session + action search) |
| `Ctrl+J` / `Cmd+J` | Toggle a docked scratch shell (always on) |
| `/` or `?` / `Alt+/` | Show this shortcuts help (`Alt+/` works in a session too) |

Sessions past the tenth aren't digit-jumpable — cycle with
`Alt+Shift+[` / `]` or search with the palette. The chords work while
focus is inside the terminal too (the iframe forwards them up to the
lobby). **Alt**, not Cmd/Ctrl: the browser reserves `Cmd/Ctrl+digit` for
tab-switching and a page in a normal tab can't override them, whereas
`Alt+digit` is capturable everywhere.

`/` (or `?`) opens the shortcuts help from the lobby — it's a plain key,
so it only fires when the lobby chrome has focus (never while you're
typing in the terminal, where `/` belongs to the shell). Inside a session,
use **`Alt+/`** (`Option+/` on Mac) — a modifier chord, so it opens the
help from anywhere — or the `Ctrl+Shift+K` palette → **Keyboard shortcuts**.

**Backspace** / **Delete** kill the selected session straight from the
sidebar — select a session card (click it, or Tab/arrow to it) and press
Backspace or Delete (a confirm guards it). Like `/`, these are plain keys, so
they only fire when the sidebar has focus, never while you're typing in a
terminal. From inside a session — where those keys belong to the shell — use
`Alt+Shift+Backspace` (in the table above), which kills the attached session
from anywhere. Rename a session by **double-clicking** its name (single click
just selects), or from the card's `⋯` menu.

## Session image gallery

Every image pasted, uploaded, or drag-dropped into a session, and
every image rendered with `show-image`, persists under
`/var/lib/clipboard-store/<user>/<session>/` and is re-viewable from
the terminal view: the floating 🖼 button (next to Img/Paste) opens
an overlay grid — newest first, `show-image` renders badged "shown" —
and a thumbnail click enlarges in the usual lightbox (Escape/click
steps back to the grid). Images live as long as their session does
(live in tmux, or still in your saved sidebar layout) plus a 30-day
grace after it dies; *non-image* drops remain 7-day ephemera in
`/tmp` — they're transfer conveniences, not gallery content. Details
and trade-offs: `docs/adr/0005-session-image-store.md`.

## Theme

Nine presets shipped as CSS variables on `body.theme-*`: `carbon`, `slate`
(default), `mono`, `ink`, `t3-dark`, `t3-light`, `catppuccin-mocha`,
`catppuccin-latte`, plus `system`, which follows the OS light/dark setting
(as T3 Light / T3 Dark, tracking scheme changes live). The picker is a
9-button grid in the ⚙ Settings panel. Choice persists per device in
`localStorage` (`tmux-theme`) — deliberately not part of the roamed prefs
doc. Switches apply live: the lobby posts `tl-theme` to the attached
terminal iframe, which re-reads the CSS vars and repaints xterm without a
reload; a stale iframe build that doesn't ACK gets the old full-reload
fallback after ~1s.

## Mobile

The lobby works on phones and tablets. The viewport meta declares
`viewport-fit=cover` + `interactive-widget=resizes-content` so the
soft keyboard pushes the layout up instead of overlaying it, and the
xterm pane refits whenever `visualViewport` reports a size change.

**Soft-key toolbar.** On any device that reports `pointer: coarse`, a
docked toolbar appears above the soft keyboard with keys mobile
keyboards lack: `Esc`, `Tab`, `Ctrl`, `Alt`, arrow keys, `|`, `` ` ``,
plus `Copy` / `Paste` / `Kbd` (re-summon keyboard). `Ctrl` and `Alt`
are one-shot on a single tap and **latch** on a double-tap (within
400 ms); a small dot on the button indicates latch state. Latched
modifiers apply to subsequent letters typed on the system soft
keyboard until you tap the modifier again to release.

**Install as a PWA.** A `manifest.webmanifest` (served from `/`) plus
the two icons (`/icon-192.png`, `/icon-512.png`) let iOS Safari and
Chrome Android "Add to Home Screen" install the lobby as a standalone
app. Run in standalone mode and the URL bar / tab strip disappear,
giving the terminal the full screen. iOS PWA cookies are sandboxed
per-app, so on first launch you may need to re-authenticate via
Authentik.

**Gestures.** `overscroll-behavior: none` suppresses Chrome
pull-to-refresh and iOS rubber-band on the terminal. `touch-action`
keeps pinch-zoom available for accessibility but kills double-tap
zoom. The sidebar auto-collapses on first session activation on
mobile so the terminal gets the full viewport; the toggle in the
top-right re-opens it (choice persists in `localStorage`).
