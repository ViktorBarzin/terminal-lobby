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
import type { AnswerResponse } from "../lib/answer-api";
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
 * events do not withdraw it, unlike the held question: two plan dialogs in a
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

/** A plan answer this client has in flight: an approve row, or feedback. */
export type PlanSending = { kind: "option"; number: number } | { kind: "feedback" };

/**
 * One line the plan card shows under its choices
 * (docs/plans/2026-09-24-text-composer-redesign.md, "When the card docks, and
 * what it shows").
 *
 * - `busy`: Send was pressed while an answer is still in flight, and ignored.
 * - `changed`: the reply was `unknown-option`; the card draws the reply's rows.
 * - `gone`: the reply was `not-drawn` or `no-dialog`; the plan is not on the pane.
 * - `unverified`: the answer may or may not have landed.
 * - `too-long`: the feedback was over 2,000 bytes and was not sent.
 */
export type PlanNotice = "busy" | "changed" | "gone" | "unverified" | "too-long";

/**
 * What the card says after a reply to a plan answer, or null when it was
 * applied.
 *
 * `refused` reads as unverified rather than as nothing typed: it is tmux not
 * taking a key, and an earlier key of the same answer may already have gone
 * in. A failed call (null) reads the same way, since the request may have
 * timed out after the server pressed its keys.
 */
export function planReplyNotice(reply: AnswerResponse | null): PlanNotice | null {
  if (!reply) return "unverified";
  if (reply.applied) return null;
  switch (reply.reason) {
    case "unknown-option":
      return "changed";
    case "not-drawn":
    case "no-dialog":
      return "gone";
    default:
      return "unverified";
  }
}

/** The CLI's feedback field is one line of at most this many bytes (contract 3). */
const PLAN_FEEDBACK_MAX_BYTES = 2000;

/**
 * Typed words as they go out as plan feedback: line breaks become
 * spaces, since the CLI's feedback field is a single line, and the ends are
 * trimmed. `joined` says a line break was replaced, so the card can say so;
 * `tooLong` says the result is over 2,000 bytes in UTF-8, which the server
 * refuses with nothing typed, so the caller does not send it.
 */
export function planFeedback(raw: string): { text: string; joined: boolean; tooLong: boolean } {
  const trimmed = raw.trim();
  const text = trimmed.replace(/\s*\n\s*/g, " ");
  const tooLong = new TextEncoder().encode(text).length > PLAN_FEEDBACK_MAX_BYTES;
  return { text, joined: /\n/.test(trimmed), tooLong };
}

/**
 * Whether an approve row clears the context before Claude starts on the plan,
 * read from the label the pane draws ("Yes, clear context (6% used) and use
 * auto mode"). The labels change between sessions, so this is the only way to
 * tell.
 */
export function clearsContext(label: string): boolean {
  return /\bclear context\b/i.test(label);
}

/**
 * Whether "Approve with this feedback" clears the context. The CLI's Shift+Tab
 * on its feedback row approves through option 1: measured in two sessions
 * whose option 1 cleared the context (2026-09-24, and on the Android emulator
 * on 2026-09-27, where the context meter went from 9% to 5%).
 */
export function feedbackClearsContext(reading: PlanReading | null): boolean {
  const first = reading?.options.find((o) => o.number === 1);
  return first !== undefined && clearsContext(first.label);
}

/**
 * The plan's own title, for the plan card's question line (the T3 pass,
 * prototype 6-plan): a first line that is a level 1-3 heading becomes the
 * title, and the markdown after it is what the card's well shows. A plan that
 * opens any other way stays whole, with no title.
 */
export function splitPlanTitle(plan: string): { title: string; rest: string } {
  const m = /^\s*#{1,3}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*(?:\r?\n|$)/.exec(plan);
  if (!m?.[1]) return { title: "", rest: plan };
  return { title: m[1].trim(), rest: plan.slice(m[0].length).replace(/^\s*\n/, "") };
}
