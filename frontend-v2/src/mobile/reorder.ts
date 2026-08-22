/**
 * Dragging a session row with a finger.
 *
 * The mouse reorders the list with HTML5 drag-and-drop, which a touch screen
 * never fires, so the row's long press hands over to a pointer drag instead
 * (SessionCard). Where that drag would land, and when the list should scroll
 * itself to reach the rest of the sessions, are decided here — arithmetic
 * rather than DOM, so both can be tested at all.
 */

import type { DropAnchor } from "../components/lobby.logic";

/** Where a dragged row would land if the finger came up now. */
export interface DropSpot {
  /** the group it lands in; "" is Ungrouped. */
  group: string;
  /** the row it lands against. Absent for a drop on a group's header, which
   *  means "into this group" and leaves the position to the layout. */
  anchor?: DropAnchor;
}

/**
 * Which side of the row under the finger the dragged row belongs on.
 *
 * The exact middle counts as below, so every pixel of the row answers and
 * there is no seam between the two halves.
 */
export function dropSide(
  y: number,
  top: number,
  height: number,
): "above" | "below" {
  return y < top + height / 2 ? "above" : "below";
}

/**
 * How far the list should scroll itself, in pixels per frame, while a drag
 * sits near its edge. Negative is up, 0 is the whole middle of the list.
 *
 * A phone shows about eight rows, so a drag that could only reach what is
 * already on screen could not move a session past its neighbours. Speed rises
 * with how deep into the edge zone the finger is, and stops rising at the edge
 * — a finger dragged off the end of the list asks for the same speed as one
 * resting exactly on it.
 */
export function edgeScroll(
  y: number,
  top: number,
  bottom: number,
  zone = 56,
  max = 14,
): number {
  const intoTop = top + zone - y;
  if (intoTop > 0) return -Math.round(max * Math.min(1, intoTop / zone));
  const intoBottom = y - (bottom - zone);
  if (intoBottom > 0) return Math.round(max * Math.min(1, intoBottom / zone));
  return 0;
}
