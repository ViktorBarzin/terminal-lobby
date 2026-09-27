/** A vertical span on screen, as `getBoundingClientRect` gives it. */
export interface Span {
  top: number;
  bottom: number;
}

/**
 * How far a scroll box has to scroll for a row inside it to show whole: a
 * positive number scrolls down, a negative one up, 0 leaves it.
 *
 * A row taller than the box shows its bottom, since that is where a card's
 * field keeps its Send.
 */
export function revealBy(box: Span, row: Span): number {
  if (row.bottom > box.bottom) return row.bottom - box.bottom;
  if (row.top < box.top) return row.top - box.top;
  return 0;
}
