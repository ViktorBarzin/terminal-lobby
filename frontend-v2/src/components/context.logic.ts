import type { ContextReading, Event, SessionState } from "../types/events";

/**
 * The context meter's data.
 *
 * The reading itself comes from the CLI: `/context` writes its own markdown into
 * the transcript and the normalizer turns it into a `meta` event carrying the
 * numbers. Nothing here computes a context size — the ceiling is not on the wire
 * and is not a constant (a session on this box reads 65.2k of 1m), which is why
 * reading what the CLI published beats deriving a worse version of it.
 *
 * A reading is a point in time, and nothing refreshes it: the meter shows what
 * the last `/context` in the session said, and a session where nobody has run
 * one has no meter at all. Automating that was built and then removed on
 * 2026-08-19 — keeping the number current meant typing into somebody's pane on
 * a schedule, and the text view does not write to a terminal unattended. So the
 * chip says how old its reading is, in settled turns, and a stale one reads as
 * stale rather than as live.
 */
export interface ContextState {
  reading: ContextReading;
  /** Turns that have ended since the reading. 0 = read in the current turn. */
  turnsAgo: number;
}

/** The newest reading in the log, with its age in settled turns. */
export function contextState(
  events: Event[],
  seed?: SessionState | null,
): ContextState | null {
  // A reading the state frame does not account for is the fresher one.
  const at = seed?.at ?? -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.id <= at) break;
    if (e.kind !== "meta" || e.meta !== "context" || !e.context) continue;
    let turnsAgo = 0;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j]!.kind === "turn_end") turnsAgo++;
    }
    return { reading: e.context, turnsAgo };
  }
  // Otherwise the frame's, aged by the turns that have settled since — the
  // reading itself is usually far outside a bounded backfill.
  if (!seed?.context) return null;
  let turnsAgo = seed.contextTurnsAgo ?? 0;
  for (const e of events) {
    if (e.id > at && e.kind === "turn_end") turnsAgo++;
  }
  return { reading: seed.context, turnsAgo };
}

/** `65.2k`, the way the CLI writes it — so the chip and the pane agree. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) return trimZero(n / 1_000_000) + "m";
  if (n >= 1_000) return trimZero(n / 1_000) + "k";
  return String(Math.round(n));
}

function trimZero(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/** How full, as a whole number. Sub-1% reads as 1% rather than 0 so a session
 *  that has started is never shown as empty. */
export function percentFull(r: ContextReading): number {
  if (r.percent > 0) return r.percent < 1 ? 1 : Math.round(r.percent);
  if (!r.maxTokens) return 0;
  const p = (r.usedTokens / r.maxTokens) * 100;
  return p > 0 && p < 1 ? 1 : Math.round(p);
}

/**
 * How the chip reads its fill. Compaction is the thing worth noticing before it
 * happens, so the bands are about how much room is left rather than about a
 * neat gradient.
 */
export function contextTone(r: ContextReading): "ok" | "warn" | "full" {
  const p = percentFull(r);
  if (p >= 90) return "full";
  if (p >= 70) return "warn";
  return "ok";
}

/** "just now" / "1 turn ago" / "3 turns ago". */
export function readingAge(turnsAgo: number): string {
  if (turnsAgo <= 0) return "just now";
  return turnsAgo === 1 ? "1 turn ago" : `${turnsAgo} turns ago`;
}

/**
 * The breakdown rows worth showing, largest first.
 *
 * "Free space" is dropped: it is the inverse of the meter, so it would always be
 * the biggest row and would say nothing the chip has not already said.
 */
export function breakdown(r: ContextReading): ContextReading["categories"] {
  const cats = (r.categories ?? []).filter(
    (c) => c.name.toLowerCase() !== "free space" && c.tokens > 0,
  );
  return [...cats].sort((a, b) => b.tokens - a.tokens);
}
