/**
 * The grid a terminal last fitted to, so one mounted with no box can open at
 * the size it will be shown at.
 *
 * WHY THIS EXISTS. A preload (ADR-0026) mounts CSS-hidden, and `.tl-hidden` is
 * `display: none`, so its host reports a 0x0 box. `fit.ts` refuses to fit
 * against that on purpose — fitting a hidden host computes a tiny grid and tmux
 * drags the real window down with it — and records the fit as OWED instead.
 * That guard is right, and it left the preload at xterm's constructed 80x24:
 * the handshake carried 80x24, tmux sized the window to 80x23, and the owed fit
 * settled only when the click revealed the terminal. The reflow the preload
 * exists to remove happened on the click after all. Measured 2026-09-11: a
 * preloaded open went 80x23, then 128x35 on reveal.
 *
 * WHY A GRID AND NOT A BOX. The first cut of this remembered the last host BOX
 * and handed it to `fit.ts`. That unblocked the guard and changed nothing else:
 * the fit itself is xterm's FitAddon, whose `proposeDimensions()` measures
 * `term.element.parentElement` on its own, which is still the 0x0 host. Measured
 * 2026-09-12, that made it worse, not better — the preload opened at 11x5
 * instead of 80x24. What a hidden terminal needs is the ANSWER, not the input:
 * `term.resize(cols, rows)` with the grid a visible terminal already computed.
 *
 * WHY ONE GRID SERVES ALL OF THEM. Every session slot fills the same area of
 * the shell — one visible, the rest `display: none` — and they all render the
 * same font at the same size, so the grid a visible terminal fitted to IS the
 * grid a hidden one would get if it were shown. There is nothing per-session to
 * remember.
 *
 * This is an observation, not policy. It records what was measured and says
 * nothing about whether a fit should run; `fit.ts` still decides that. A
 * terminal that has never been shown and has no predecessor gets `null` and
 * behaves exactly as it did before.
 */

/** A terminal grid, in cells. */
export interface Grid {
  cols: number;
  rows: number;
}

let last: Grid | null = null;

/** Record a grid a terminal really fitted to. A non-positive grid is what this
 *  exists to avoid handing on, so it is not recorded. */
export function rememberGrid(grid: Grid | null): void {
  if (!grid || grid.cols <= 0 || grid.rows <= 0) return;
  last = { cols: grid.cols, rows: grid.rows };
}

/** The last grid any terminal fitted to, or null if none ever has. */
export function lastGrid(): Grid | null {
  return last;
}

/** Tests only: no page ever wants to forget. */
export function forgetGrid(): void {
  last = null;
}
