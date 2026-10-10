/**
 * What a press on a zoomable picture meant: a tap, a double tap, or neither.
 *
 * The picture's stage takes every pointer, because a pinch that started on the
 * dark area around a photo would otherwise reach the browser and zoom the whole
 * page. That leaves it answering for the taps the lightbox used to get as plain
 * clicks: one tap closes, two zoom in, and a drag or a pinch is neither.
 */

/** How far a finger may wander and still be a tap, in CSS px. */
export const TAP_SLOP = 10;
/** How long a tap may be held, in ms. */
export const TAP_MS = 300;
/** How soon after the first lifts a second tap has to land, in ms. */
export const DOUBLE_TAP_MS = 280;
/** How close to the first a second tap has to land, in CSS px. */
export const DOUBLE_TAP_SLOP = 30;

export type Tap = "tap" | "double";

interface Press {
  x: number;
  y: number;
  t: number;
}

export interface TapTracker {
  down(id: number, x: number, y: number, t: number): void;
  /** What the press that just ended was, or null if it was not a tap. */
  up(id: number, x: number, y: number, t: number): Tap | null;
  cancel(id: number): void;
}

export function createTapTracker(): TapTracker {
  const active = new Map<number, Press>();
  // Set once a second finger joins; cleared when the last one lifts. Every
  // finger of a pinch is spoiled, the last one up included.
  let spoiled = false;
  let lastTap: Press | null = null;

  const far = (a: Press, x: number, y: number, slop: number): boolean =>
    Math.hypot(a.x - x, a.y - y) > slop;

  return {
    down(id, x, y, t) {
      active.set(id, { x, y, t });
      if (active.size > 1) spoiled = true;
    },
    up(id, x, y, t) {
      const start = active.get(id);
      active.delete(id);
      if (!start) return null;
      const wasSpoiled = spoiled;
      if (active.size === 0) spoiled = false;
      if (wasSpoiled || t - start.t > TAP_MS || far(start, x, y, TAP_SLOP)) {
        lastTap = null;
        return null;
      }
      if (lastTap && start.t - lastTap.t <= DOUBLE_TAP_MS && !far(lastTap, x, y, DOUBLE_TAP_SLOP)) {
        lastTap = null;
        return "double";
      }
      lastTap = { x, y, t };
      return "tap";
    },
    cancel(id) {
      active.delete(id);
      if (active.size === 0) spoiled = false;
      lastTap = null;
    },
  };
}
