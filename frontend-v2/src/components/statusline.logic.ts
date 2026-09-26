import type { WorkingRow } from "./timeline.logic";

/**
 * What the composer's thin line says, as pure functions.
 *
 * The line is the Quiet line composer's (Viktor chose it on 2026-09-24): one
 * row of small type above the pill, the session's state on the left and the
 * mode, model and context dials on the right. It took over two things that
 * lived elsewhere. The working row sat at the foot of the timeline, inside the
 * scroll, and the background strip sat between the timeline and the composer.
 * Both now say their piece here, in the same place every time.
 */

/** The one thing the line's left side reports. */
export type LineState =
  | { kind: "working"; row: WorkingRow }
  | { kind: "waiting"; row: WorkingRow }
  | { kind: "background"; label: string }
  | { kind: "watching"; reason: string }
  | { kind: "idle" };

/**
 * Which state the line shows, by the prototype's precedence.
 *
 * Watching comes first: a device that only watches can stop nothing and send
 * nothing, and the line is where it says so. Then the open turn, waiting when
 * Claude is stopped on the reader and working otherwise. Then work the session
 * still owes once its turn has closed (lobby.logic `backgroundLabel`), which by
 * this order never speaks while a turn is open and so never doubles up with
 * it. Then nothing.
 *
 * The dock's top edge does not follow this. It follows the session itself, so
 * a watcher still sees the sweep while the session they watch works.
 */
export function lineState(o: {
  live?: WorkingRow;
  background?: string;
  inertReason?: string;
}): LineState {
  if (o.inertReason) return { kind: "watching", reason: o.inertReason };
  if (o.live)
    return o.live.waiting ? { kind: "waiting", row: o.live } : { kind: "working", row: o.live };
  if (o.background) return { kind: "background", label: o.background };
  return { kind: "idle" };
}

/**
 * What the line shows of a call's target.
 *
 * A path by its file name: the line has a few words of room, and the name is
 * the part that says which file. The title carries the whole path. A command
 * whole, since its first word is rarely its point (`npx vitest run
 * QuestionCard`), and an address whole, since its last segment says nothing on
 * its own. A token with no space in it and a slash somewhere is a path.
 */
export function shortTarget(label: string): string {
  const t = label.trim();
  if (!t || /\s/.test(t) || !t.includes("/") || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  const parts = t.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? t;
}

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
