import type { Event, SearchHit } from "../types/events";

/**
 * Finding something in a session that has scrolled past.
 *
 * The search itself runs on the server, over the WHOLE transcript rather than
 * the window this client holds — the view opens on 20 turns and the largest
 * transcript here is 28.9 MB over 7,964 records, so a client-side find would
 * quietly cover a few percent of a long session. What is left for this file is
 * the naming and the jump.
 */

/** How a hit is labelled in the list — what it is, in the timeline's own words. */
export function hitLabel(h: SearchHit): string {
  const where =
    h.field === "message"
      ? h.kind === "user"
        ? "you"
        : "Claude"
      : h.field === "thinking"
        ? "thinking"
        : h.field;
  return h.tool ? `${h.tool} · ${where}` : where;
}

/**
 * When it happened, at the resolution that helps: a time for today, a date
 * before that. A hit list spanning weeks is the normal case on a long session.
 */
export function hitWhen(at: number | undefined, now = Date.now()): string {
  if (!at) return "";
  const d = new Date(at);
  const time = d.toTimeString().slice(0, 5);
  const days = daysBetween(at, now);
  if (days === 0) return time;
  if (days === 1) return `yesterday ${time}`;
  if (days < 7) return `${days}d ago ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${time}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function daysBetween(a: number, b: number): number {
  const midnight = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.round((midnight(b) - midnight(a)) / 86_400_000);
}

/** Whether the event a hit names is already in the client's window. */
export function isLoaded(events: Event[], id: number): boolean {
  return events.length > 0 && events[0]!.id <= id;
}

/**
 * How many steps back to allow when reaching for a hit.
 *
 * A hit can sit thousands of events behind what the client holds, and each step
 * is a round trip plus a render. The cap keeps a jump bounded; when it runs out
 * the caller says so rather than leaving the reader looking at the wrong place,
 * because a jump that silently lands somewhere else is worse than one that
 * admits it could not get there.
 *
 * It was 40 while a step was a 20-turn window. Steps are now bounded in bytes
 * (session-events MaxResponseBytes, 400 KB) so each one covers less of a heavy
 * session — measured, a 20-turn page on the heaviest session here was 2.4 MB,
 * or six such steps. Raising the cap keeps the reach a jump had while leaving
 * every individual step bounded, which is the trade the byte cap was for.
 */
export const MAX_JUMP_STEPS = 200;

/** What a jump attempt ended up doing, so the caller can say so plainly. */
export type JumpOutcome = "found" | "exhausted" | "no-more-history";
