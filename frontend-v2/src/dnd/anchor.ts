import type { DropAnchor } from "../components/lobby.logic";

/**
 * Where a session landed, in the terms the layout understands.
 *
 * The drag library hands back the group's whole order once the pointer comes
 * up. The store moves a session RELATIVE to a neighbour rather than to an index
 * (`moveSessionToAnchor`), because the rendered list and the raw layout arrays
 * deliberately diverge — dead refs are filtered out of the render and leftovers
 * swept in — so a rendered index does not address the same seat.
 *
 * The row above is the anchor wherever there is one, since it is the one the
 * drop was aimed past. A card dropped at the top has none, so it anchors above
 * the row that follows it instead, and a card alone in its group anchors
 * against nothing: `move` with no anchor appends, which for an empty group is
 * the same seat.
 */
export function anchorFor(
  order: readonly string[],
  name: string,
): DropAnchor | undefined {
  const at = order.indexOf(name);
  if (at < 0) return undefined;
  const above = order[at - 1];
  if (above !== undefined) return { name: above, side: "below" };
  const below = order[at + 1];
  if (below !== undefined) return { name: below, side: "above" };
  return undefined;
}

/**
 * Where a group belongs in the RAW sequence, given the visible order a drag
 * just produced, or null when nothing needs to move.
 *
 * The two orders are not the same list. An empty Ungrouped keeps its slot in
 * the layout — the capture and reorder contract needs it — but renders nothing,
 * so the sequence the store splices can hold tokens the drag never saw. The
 * translation is done against the neighbour the drop landed past rather than
 * against a position, for the same reason a card is moved against a neighbour:
 * a rendered index does not address the same seat.
 *
 * `reorderGroups` splices the token out and then back in, so the index it wants
 * depends on which way the token travelled — removing it first shifts every
 * later token down by one.
 */
export function groupSeqTarget(
  sequence: readonly string[],
  visible: readonly string[],
  token: string,
): number | null {
  const from = sequence.indexOf(token);
  const at = visible.indexOf(token);
  if (from < 0 || at < 0) return null;

  const above = visible[at - 1];
  if (above !== undefined) {
    const pos = sequence.indexOf(above);
    if (pos < 0) return null;
    const to = from < pos ? pos : pos + 1;
    return to === from ? null : to;
  }

  // Dropped at the top of what is on screen: land immediately before whatever
  // now follows it. A group alone on screen has neither neighbour and stays.
  const below = visible[at + 1];
  if (below === undefined) return null;
  const pos = sequence.indexOf(below);
  if (pos < 0) return null;
  const to = from < pos ? pos - 1 : pos;
  return to === from ? null : to;
}
