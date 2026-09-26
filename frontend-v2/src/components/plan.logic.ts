/**
 * When the plan-approval card docks
 * (docs/plans/2026-09-24-text-composer-redesign.md, "When the card docks, and
 * what it shows").
 *
 * Two pure steps. `planDockFacts` reads the events for the two things the
 * decision depends on: the pane's plan reading, and the newest ExitPlanMode
 * call with where its result landed relative to that reading.
 * `decidePlanDock` turns those facts, and this client's own last answer, into
 * docked or not.
 */
import type { Event } from "../types/events";
import { planFromPane, type PlanReading } from "./timeline.logic";

/** The newest ExitPlanMode call in the transcript, as the dock sees it. */
export type PlanCall =
  | { state: "missing" }
  | { state: "pending"; toolId: string }
  /**
   * `afterReading` is true when the result landed after the current reading
   * arrived, which means that dialog has just been answered. It is false when
   * there is no reading.
   */
  | { state: "resolved"; toolId: string; afterReading: boolean };

export interface PlanDockFacts {
  /** The pane's plan reading, or null when the pane shows none. */
  reading: PlanReading | null;
  call: PlanCall;
}

/** The plan reading this client answered last. */
export interface AnsweredPlan {
  /** `planReadingKey` of the reading the answer was sent against. */
  key: string;
  /**
   * The answer was applied and has not settled yet: the transcript result
   * has not landed and 20 s have not passed. The caller keeps this clock.
   */
  settling: boolean;
}

export type PlanDock =
  | { docked: false }
  /**
   * `call` is the pending call whose plan the card shows, or null while the
   * card reads "Loading the plan…" because the transcript has no call for
   * this dialog yet.
   */
  | { docked: true; reading: PlanReading; call: string | null };

/**
 * A plan reading's identity, as one comparable string. The watcher sends no
 * sequence number, so the content is all there is to compare.
 */
export function planReadingKey(reading: PlanReading): string {
  return JSON.stringify([
    reading.options.map((o) => [o.number, o.label]),
    reading.feedbackRow,
    reading.planPath,
  ]);
}

/**
 * Read the plan reading and the newest ExitPlanMode call off the events.
 *
 * The reading is the newest `asking` meta body. A question reading or an
 * empty body withdraws it, since the two kinds share the meta. Transcript
 * events do not withdraw it, unlike `askingFromPane`: two plan dialogs in a
 * row can draw byte-identical readings, and the watcher then publishes once,
 * so the reading has to outlive the first dialog's result for the second
 * dialog to dock.
 *
 * The reading's arrival is where its body first appeared since the last
 * change. The watcher appends only when the reading changes, so a repeat of
 * the same body is a replay rather than a new dialog, and it keeps the first
 * position.
 */
export function planDockFacts(events: readonly Event[]): PlanDockFacts {
  let body = "";
  let reading: PlanReading | null = null;
  let readingAt = -1;
  let toolId = "";
  let resolvedAt = -1;
  for (const [i, e] of events.entries()) {
    if (e.kind === "meta" && e.meta === "asking") {
      const next = e.body ?? "";
      if (next === body) continue;
      body = next;
      reading = planFromPane(next);
      readingAt = i;
      continue;
    }
    if (e.kind === "tool_use" && e.tool === "ExitPlanMode" && e.toolId) {
      toolId = e.toolId;
      resolvedAt = -1;
      continue;
    }
    if (e.kind === "tool_result" && toolId !== "" && e.toolId === toolId && resolvedAt < 0) {
      resolvedAt = i;
    }
  }
  let call: PlanCall;
  if (toolId === "") call = { state: "missing" };
  else if (resolvedAt < 0) call = { state: "pending", toolId };
  else
    call = { state: "resolved", toolId, afterReading: reading !== null && resolvedAt > readingAt };
  return { reading, call };
}

/**
 * Whether the plan card docks, and what it shows.
 *
 * It docks while a reading is present and the newest call is pending, missing
 * from the transcript, or resolved before the reading arrived. The last two
 * show "Loading the plan…": a call resolved before the reading belongs to an
 * earlier dialog, so its plan is not the one on screen. It does not dock when
 * the call was resolved after the reading, because that dialog has just been
 * answered and the watcher has not withdrawn its reading yet.
 *
 * A reading identical to the one this client answered does not re-dock while
 * that answer is settling, so the card does not flash back up in the moment
 * between the answer applying and the pane or the transcript catching up.
 */
export function decidePlanDock(facts: PlanDockFacts, answered?: AnsweredPlan | null): PlanDock {
  const { reading, call } = facts;
  if (!reading) return { docked: false };
  if (call.state === "resolved" && call.afterReading) return { docked: false };
  if (answered?.settling && answered.key === planReadingKey(reading)) return { docked: false };
  return { docked: true, reading, call: call.state === "pending" ? call.toolId : null };
}
