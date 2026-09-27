import type { ContextReading, Event, SessionState } from "../types/events";

/**
 * The context line's data, in the model sheet.
 *
 * Two sources. A `/context` reading is the CLI's own markdown in the
 * transcript, which the normalizer turns into a `meta` event carrying the
 * numbers, ceiling included. It is a point in time, and nothing refreshes it:
 * automating it was built and then removed on 2026-08-19, since keeping it
 * current meant typing into somebody's pane on a schedule.
 *
 * So the line also reads the last settled turn's usage, which every turn
 * carries on its `turn_end`. That is the CLI status line's own arithmetic
 * (2.1.283: input + cache writes + cache reads over the window, rounded), and
 * it is why the line is there in an ordinary session: found live on
 * 2026-09-27, the sheet had no context line until someone ran /context, while
 * the pane's status line read 5% and then 9%. The usage gives the numerator;
 * the WINDOW is not on the wire and is not a constant (1m on most models here,
 * 200k on Haiku 4.5), so it comes from a `/context` reading on the same model
 * when there is one, and otherwise from what the caller measured for the model
 * (lib/models.ts `contextWindow`). With neither, the line draws nothing rather
 * than guess.
 */
export interface ContextState {
  reading: ContextReading;
  /** Turns that have ended since the reading. 0 = read in the current turn. */
  turnsAgo: number;
}

/** What the caller knows about the session's model, for the usage reading. */
export interface ContextModel {
  /** The model the session is answering as. */
  model?: string;
  /** Its context window in tokens, where it has been measured. */
  window?: number;
}

/** The newest reading, with its age in settled turns. */
export function contextState(
  events: Event[],
  seed?: SessionState | null,
  now?: ContextModel,
): ContextState | null {
  const logged = loggedReading(events, seed);
  const end = lastTurnWithUsage(events);
  if (logged && logged.index > end) return logged.state;
  const seeded = seededReading(events, seed);
  if (end >= 0) {
    // A reading from the frame that no turn has settled since is newer than
    // any turn in the log.
    if (!logged && seeded?.turnsAgo === 0) return seeded;
    const fromUsage = usageReading(events[end]!, logged?.state.reading ?? seeded?.reading, now);
    if (fromUsage) return { reading: fromUsage, turnsAgo: 0 };
  }
  return logged?.state ?? seeded;
}

/** The newest `/context` reading the state frame does not account for. */
function loggedReading(
  events: Event[],
  seed?: SessionState | null,
): { state: ContextState; index: number } | null {
  const at = seed?.at ?? -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.id <= at) break;
    if (e.kind !== "meta" || e.meta !== "context" || !e.context) continue;
    let turnsAgo = 0;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j]!.kind === "turn_end") turnsAgo++;
    }
    return { state: { reading: e.context, turnsAgo }, index: i };
  }
  return null;
}

/** The frame's reading, aged by the turns that have settled since. The reading
 *  itself is usually far outside a bounded backfill. */
function seededReading(events: Event[], seed?: SessionState | null): ContextState | null {
  if (!seed?.context) return null;
  const at = seed.at ?? -1;
  let turnsAgo = seed.contextTurnsAgo ?? 0;
  for (const e of events) {
    if (e.id > at && e.kind === "turn_end") turnsAgo++;
  }
  return { reading: seed.context, turnsAgo };
}

/** Where the session's own newest settled turn with a usage is, or -1. A
 *  subagent's turn is its own context, not the session's. */
function lastTurnWithUsage(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "turn_end" && !e.sidechain && e.usage) return i;
  }
  return -1;
}

/** A reading worked out from a turn's usage, or null without a window. */
function usageReading(
  end: Event,
  known: ContextReading | undefined,
  now?: ContextModel,
): ContextReading | null {
  const u = end.usage;
  if (!u) return null;
  const sameModel = !!known && (!known.model || !now?.model || known.model === now.model);
  const window = (sameModel ? known.maxTokens : 0) || now?.window || 0;
  if (window <= 0) return null;
  const used =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const model = now?.model ?? known?.model;
  return {
    ...(model ? { model } : {}),
    usedTokens: used,
    maxTokens: window,
    percent: Math.min(100, Math.max(0, Math.round((used / window) * 100))),
  };
}

/** `65.2k`, the way the CLI writes it, so the sheet's context line and the pane agree. */
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
 * How full the context reads, as a band. Compaction is the thing worth noticing before it
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
 * What the model sheet's context line says on hover: the numbers behind the
 * percentage and how old the reading is, since nothing refreshes it.
 */
export function contextSummary(c: ContextState): string {
  const r = c.reading;
  return (
    `${formatTokens(r.usedTokens)} of ${formatTokens(r.maxTokens)} tokens` +
    `${r.model ? ` on ${r.model}` : ""}, read ${readingAge(c.turnsAgo)}`
  );
}
