/**
 * The last box a terminal actually measured, so one mounted with no box can
 * still open at the right size.
 *
 * WHY THIS EXISTS. A preload (ADR-0026) mounts CSS-hidden, and `.tl-hidden` is
 * `display: none`, so its host reports a 0x0 box. `fit.ts` refuses to fit
 * against that on purpose — fitting a hidden host computes a ~13x7 grid and
 * drags the real tmux window down with it — and records the fit as OWED
 * instead. That guard is right, and it left the preload at xterm's constructed
 * 80x24: the handshake carried 80x24, tmux sized the window to 80x23, and the
 * owed fit settled only when the click revealed the terminal, so the reflow the
 * preload was supposed to remove happened on the click after all. Measured on
 * 2026-09-11: a preloaded open went 80x23 and then 128x35 as it was revealed.
 *
 * WHY ONE BOX IS THE RIGHT ANSWER FOR ALL OF THEM. Every session slot fills the
 * same area of the shell — one is visible and the rest are `display: none` —
 * so the box a visible terminal measures IS the box a hidden one would get if
 * it were shown. There is nothing per-session to remember.
 *
 * This is an observation, not policy: it holds what was measured, and says
 * nothing about whether a fit should run. `fit.ts` still decides that, and it
 * still sees a real box or none. A terminal that has never been shown and has
 * no predecessor gets `null` and behaves exactly as it did before.
 */
import type { HostBox } from "./fit";

let last: HostBox | null = null;

/** Record a box a host really had. Zero and negative boxes are what this exists
 *  to avoid handing on, so they are not recorded. */
export function rememberHostBox(box: HostBox | null): void {
  if (!box || box.width <= 0 || box.height <= 0) return;
  last = { width: box.width, height: box.height };
}

/** The last real box any terminal measured, or null if none ever has. */
export function lastHostBox(): HostBox | null {
  return last;
}

/** Tests only: no page ever wants to forget. */
export function forgetHostBox(): void {
  last = null;
}
