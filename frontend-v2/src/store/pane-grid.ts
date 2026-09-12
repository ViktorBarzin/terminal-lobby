/**
 * How big the session pane is, remembered so a terminal that boots HIDDEN can
 * attach at the size it will have rather than at xterm's fallback.
 *
 * THE BUG THIS EXISTS FOR, measured on the deployed build 2026-09-12 against a
 * session whose window was 129x35. Hovering its card preloaded it (ADR-0026),
 * and `tmux list-clients` then read:
 *
 *     during hover   health [80x24] (attached,ignore-size,UTF-8)   window 80x23
 *     after click    health [128x36] (attached,focused,UTF-8)      window 128x35
 *
 * So a hover SHRANK the session to 80 columns and rewrapped its content, and
 * the click rewrapped it back. Viktor saw it as "a small-ish screen which then
 * gets immediately resized after a few ms".
 *
 * Two things combine to make it. A preloaded `TerminalNative` mounts into a
 * CSS-hidden slot (`store/keepalive.ts`, `.tl-hidden` is `display: none`), so
 * the host measures 0x0, `fit.ts` rightly refuses the fit, and `term.cols/rows`
 * stay at xterm's 80x24 default — which is what the ttyd handshake carries. And
 * `-f ignore-size`, the flag `devvm/tmux-attach.sh` puts on a hover attach, does
 * NOT save it: that flag holds only while an UNFLAGGED client is also attached,
 * and a session nobody is reading has none, so tmux sizes the window to the one
 * flagged client it has.
 *
 * The fix cannot be a better measurement. A `display: none` terminal cannot
 * measure its own character cell either — xterm defers that to
 * `_charSizeService.measure()` on the IntersectionObserver that unpauses its
 * renderer — so there is nothing local to compute a grid from. What there IS is
 * the grid a VISIBLE terminal already reports through `SessionView`'s
 * `claimGrid`, and every session pane is the same box, so that number is the
 * answer for all of them.
 *
 * Persisted rather than held in a signal, for the one case a signal cannot
 * cover: a cold page load shows no terminal at all (the pane holds the
 * composer), and hovering a card is a perfectly ordinary first action. The
 * device's last pane grid is a better guess than 80x24 and no worse when it is
 * stale, because a stale grid is corrected by the fit that runs the moment the
 * session is actually shown.
 */
import { lsGet, lsSet } from "../lib/storage";

/** Per-device, like the view mode and unlike the roamed prefs doc: a phone and
 *  a desktop have different panes and must not teach each other a grid. */
export const PANE_GRID_KEY = "tl:pane-grid:v1";

export interface PaneGrid {
  cols: number;
  rows: number;
}

/**
 * xterm's own constructor default. A grid this small teaches a later hover
 * nothing it would not already fall back to, and storing it would let one
 * genuinely tiny window make every later preload tiny.
 */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

/** A grid worth attaching at: whole, positive, and bigger than the fallback. */
function usable(cols: number, rows: number): boolean {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
  if (cols <= 0 || rows <= 0) return false;
  return cols > FALLBACK_COLS || rows > FALLBACK_ROWS;
}

/**
 * Record the grid a terminal on screen is actually running at.
 *
 * Called from the same place that tells the SERVER this size (`claimGrid`), so
 * the two statements cannot drift, and gated the same way: only a session on
 * screen speaks for the pane.
 */
export function rememberPaneGrid(cols: number, rows: number): void {
  const c = Math.round(cols);
  const r = Math.round(rows);
  if (!usable(c, r)) return;
  lsSet(PANE_GRID_KEY, JSON.stringify({ cols: c, rows: r }));
}

/**
 * The last pane grid this device saw, or null when it has never seen one.
 *
 * Null is a real answer and the caller keeps xterm's default for it. Stored
 * state is input: a hand-edited, half-written or older-shaped value reads back
 * as null rather than reaching `term.resize()`.
 */
export function readPaneGrid(): PaneGrid | null {
  const raw = lsGet(PANE_GRID_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { cols, rows } = parsed as { cols?: unknown; rows?: unknown };
  if (typeof cols !== "number" || typeof rows !== "number") return null;
  if (!usable(cols, rows)) return null;
  return { cols, rows };
}
