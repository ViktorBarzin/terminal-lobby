/**
 * What the composer's thin line still needs, as pure functions.
 *
 * The line is the Quiet line composer's (2026-09-24). Its state on the left,
 * "Working · tool · elapsed · N steps", moved into the live group at the end
 * of the conversation on 2026-09-27 (timeline.logic `liveGroupState`, with
 * `shortTarget`). What remains is how the line words the watching state and
 * how much it keeps at a given width, until the T3 pass retires the line.
 */

/**
 * A watching reason split into the words that name the watch and the rest.
 *
 * The session view writes one sentence for why the controls are inert: who is
 * being watched, a dash or a colon, then what that means ("Watching: this
 * device does not type into the session"). The prototype sets the first half
 * in the line's strong type and the second in its muted type, and folds the
 * second away when the line runs out of room. A sentence with neither
 * separator is all reason, under the plain word.
 */
export function splitReason(reason: string): { head: string; rest: string } {
  const m = /^(.+?)\s*(?:—|:)\s+(.+)$/.exec(reason.trim());
  if (!m) return { head: "Watching", rest: reason.trim() };
  return { head: m[1]!, rest: m[2]! };
}

/** How much the line keeps, by how wide it is. */
export type Room = "wide" | "mid" | "narrow" | "tight";

/**
 * The band a width falls in, for `data-room` on the line.
 *
 * The prototype folds the line with container queries, and the oldest engine
 * served is Safari 15.6 (lib/baseline-polyfills.ts), which has none: the rules
 * would never apply there and the line would overflow. So the line measures
 * itself with a ResizeObserver and writes the band as an attribute the
 * stylesheet keys on. What each band folds is in app.css beside `.tl-statusline`.
 *
 * Zero, which is what an unmeasured element reads, counts as wide, so a line
 * nothing has laid out yet (jsdom, a hidden view) folds nothing.
 */
export function roomFor(width: number): Room {
  if (width <= 0 || width > 780) return "wide";
  if (width > 600) return "mid";
  if (width > 460) return "narrow";
  return "tight";
}
