/**
 * When the plan-approval card docks.
 *
 * The card docks while a plan reading is present and the newest ExitPlanMode
 * call is pending, not in the transcript yet ("Loading the plan…"), or
 * resolved before the reading arrived. It does not dock when the call was
 * resolved after the reading. Transcript events do not reset the reading, and
 * a reading identical to the one this client just answered does not re-dock
 * while that answer is settling
 * (docs/plans/2026-09-24-text-composer-redesign.md, "When the card docks, and
 * what it shows").
 *
 * The readings are the Go fixtures' wire shapes (see asking.pane.test.ts).
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import {
  decidePlanDock,
  planDockFacts,
  planReadingKey,
  type AnsweredPlan,
  type PlanDockFacts,
} from "../src/components/plan.logic";
import { planFromPane, type PlanReading } from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({
  session: "s",
  ...e,
});

const PLAN_FIRST = JSON.stringify({
  kind: "plan",
  options: [
    { number: 1, label: "Yes, clear context (6% used) and use auto mode" },
    { number: 2, label: "Yes, and use auto mode" },
    { number: 3, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 4,
  planPath: "~/.claude/plans/plan-how-to-create-calm-starfish.md",
});
const PLAN_NO_AUTO =
  '{"kind":"plan","options":[{"number":1,"label":"Yes, auto-accept edits"},' +
  '{"number":2,"label":"Yes, manually approve edits"}],"feedbackRow":3,' +
  '"planPath":"~/.claude/plans/plan-do-not-execute-delightful-whisper.md"}';
const QUESTION = JSON.stringify({
  questions: [{ header: "Colour", question: "Which colour?", options: [{ label: "Red" }] }],
});

const readingOf = (body: string): PlanReading => {
  const r = planFromPane(body);
  if (!r) throw new Error("fixture is not a plan reading");
  return r;
};

const asking = (id: number, body: string): Event => ev({ id, kind: "meta", meta: "asking", body });
const planUse = (id: number, toolId: string): Event =>
  ev({
    id,
    kind: "tool_use",
    tool: "ExitPlanMode",
    toolId,
    body: JSON.stringify({ plan: "# Plan\n\n1. Do it.\n" }),
  });
const result = (id: number, toolId: string, isError = false): Event =>
  ev({ id, kind: "tool_result", toolId, body: "done", isError });

const dock = (events: Event[], answered?: AnsweredPlan | null) =>
  decidePlanDock(planDockFacts(events), answered);

describe("the facts the dock decision reads off the events", () => {
  it("finds no reading and no call in an empty session", () => {
    expect(planDockFacts([])).toEqual({ reading: null, call: { state: "missing" } });
  });

  it("reads the newest plan reading and the newest call", () => {
    const facts = planDockFacts([
      ev({ id: 1, kind: "user", body: "plan it" }),
      planUse(2, "p1"),
      asking(3, PLAN_FIRST),
    ]);
    expect(facts.reading).toEqual(readingOf(PLAN_FIRST));
    expect(facts.call).toEqual({ state: "pending", toolId: "p1" });
  });

  it("says whether the newest call was resolved after the reading arrived", () => {
    expect(planDockFacts([planUse(1, "p1"), asking(2, PLAN_FIRST), result(3, "p1")]).call).toEqual({
      state: "resolved",
      toolId: "p1",
      afterReading: true,
    });
    expect(planDockFacts([planUse(1, "p1"), result(2, "p1"), asking(3, PLAN_FIRST)]).call).toEqual({
      state: "resolved",
      toolId: "p1",
      afterReading: false,
    });
  });

  it("takes the newest call, not the first pending one", () => {
    const facts = planDockFacts([
      planUse(1, "p1"),
      asking(2, PLAN_FIRST),
      result(3, "p1", true),
      planUse(4, "p2"),
    ]);
    expect(facts.call).toEqual({ state: "pending", toolId: "p2" });
  });

  it("ignores results of other tools", () => {
    const facts = planDockFacts([
      planUse(1, "p1"),
      asking(2, PLAN_FIRST),
      ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "r1", body: "{}" }),
      result(4, "r1"),
    ]);
    expect(facts.call).toEqual({ state: "pending", toolId: "p1" });
  });
});

describe("when the plan card docks", () => {
  it("does not dock without a plan reading, even with a pending call", () => {
    expect(dock([planUse(1, "p1")])).toEqual({ docked: false });
  });

  it("docks while the newest call is pending, with that call's plan", () => {
    expect(dock([planUse(1, "p1"), asking(2, PLAN_FIRST)])).toEqual({
      docked: true,
      reading: readingOf(PLAN_FIRST),
      call: "p1",
    });
  });

  it("docks when the reading arrives before the call's record", () => {
    // The pane draws the dialog before Claude Code writes the record.
    expect(dock([asking(1, PLAN_FIRST), planUse(2, "p1")])).toEqual({
      docked: true,
      reading: readingOf(PLAN_FIRST),
      call: "p1",
    });
  });

  it("docks as 'Loading the plan…' while the call is not in the transcript yet", () => {
    expect(dock([ev({ id: 1, kind: "user", body: "plan it" }), asking(2, PLAN_FIRST)])).toEqual({
      docked: true,
      reading: readingOf(PLAN_FIRST),
      call: null,
    });
  });

  it("docks as loading when the newest call was resolved before the reading arrived", () => {
    // That reading belongs to a dialog whose call is not written yet, so the
    // resolved call's plan is not the one on screen.
    expect(dock([planUse(1, "p1"), result(2, "p1", true), asking(3, PLAN_FIRST)])).toEqual({
      docked: true,
      reading: readingOf(PLAN_FIRST),
      call: null,
    });
  });

  it("does not dock when the newest call was resolved after the reading", () => {
    // The dialog has just been answered and the watcher has not withdrawn its
    // reading yet.
    expect(dock([planUse(1, "p1"), asking(2, PLAN_FIRST), result(3, "p1")])).toEqual({
      docked: false,
    });
  });

  it.each([
    ["text", ev({ id: 3, kind: "text", body: "Here is the plan." })],
    ["thinking", ev({ id: 3, kind: "thinking", body: "hm" })],
    ["user", ev({ id: 3, kind: "user", body: "queued words" })],
    ["another tool", ev({ id: 3, kind: "tool_use", tool: "Read", toolId: "r1", body: "{}" })],
    ["turn_end", ev({ id: 3, kind: "turn_end" })],
    ["a mode marker", ev({ id: 3, kind: "meta", meta: "permission-mode", body: "plan" })],
  ])("keeps docking after a %s event: transcript events do not reset the reading", (_, after) => {
    expect(dock([planUse(1, "p1"), asking(2, PLAN_FIRST), after])).toMatchObject({
      docked: true,
      call: "p1",
    });
  });

  it("stops docking once the watcher withdraws the reading", () => {
    expect(dock([planUse(1, "p1"), asking(2, PLAN_FIRST), asking(3, "")])).toEqual({
      docked: false,
    });
  });

  it("stops docking when a question reading takes over", () => {
    expect(dock([planUse(1, "p1"), asking(2, PLAN_FIRST), asking(3, QUESTION)])).toEqual({
      docked: false,
    });
  });

  it("does not dock a reading it cannot trust whole", () => {
    const broken = JSON.stringify({
      kind: "plan",
      options: [{ number: 1, label: "Yes" }],
      feedbackRow: 1,
    });
    expect(dock([planUse(1, "p1"), asking(2, broken)])).toEqual({ docked: false });
  });

  it("docks the second of two byte-identical dialogs once its call lands", () => {
    // Feedback on the first dialog, and Claude presents a revised plan whose
    // dialog reads the same. The watcher saw no change, so it published once.
    const events = [planUse(1, "p1"), asking(2, PLAN_FIRST), result(3, "p1", true)];
    expect(dock(events)).toEqual({ docked: false });
    expect(dock([...events, planUse(4, "p2")])).toEqual({
      docked: true,
      reading: readingOf(PLAN_FIRST),
      call: "p2",
    });
  });

  it("docks the second identical dialog as loading when the watcher saw it go and come back", () => {
    const events = [
      planUse(1, "p1"),
      asking(2, PLAN_FIRST),
      result(3, "p1", true),
      asking(4, ""),
      asking(5, PLAN_FIRST),
    ];
    expect(dock(events)).toEqual({ docked: true, reading: readingOf(PLAN_FIRST), call: null });
  });

  it("counts an identical reading repeated without a withdrawal as the same arrival", () => {
    // The watcher appends only when the reading changes, so a repeat of the
    // same body is a replay, not a new dialog.
    const events = [
      planUse(1, "p1"),
      asking(2, PLAN_FIRST),
      result(3, "p1"),
      asking(4, PLAN_FIRST),
    ];
    expect(dock(events)).toEqual({ docked: false });
  });

  it("follows a reading that changes while the call is open", () => {
    expect(dock([planUse(1, "p1"), asking(2, PLAN_FIRST), asking(3, PLAN_NO_AUTO)])).toEqual({
      docked: true,
      reading: readingOf(PLAN_NO_AUTO),
      call: "p1",
    });
  });
});

describe("the reading this client just answered", () => {
  const pending: PlanDockFacts = {
    reading: readingOf(PLAN_FIRST),
    call: { state: "pending", toolId: "p1" },
  };

  it("does not re-dock an identical reading while that answer is settling", () => {
    expect(
      decidePlanDock(pending, { key: planReadingKey(readingOf(PLAN_FIRST)), settling: true }),
    ).toEqual({
      docked: false,
    });
  });

  it("docks it again once the answer has settled", () => {
    expect(
      decidePlanDock(pending, { key: planReadingKey(readingOf(PLAN_FIRST)), settling: false }),
    ).toMatchObject({ docked: true, call: "p1" });
  });

  it("docks a different reading while the answer is settling", () => {
    expect(
      decidePlanDock(pending, { key: planReadingKey(readingOf(PLAN_NO_AUTO)), settling: true }),
    ).toMatchObject({ docked: true, call: "p1" });
  });

  it("holds a settling answer back in the loading case too", () => {
    const loading: PlanDockFacts = { reading: readingOf(PLAN_FIRST), call: { state: "missing" } };
    expect(
      decidePlanDock(loading, { key: planReadingKey(readingOf(PLAN_FIRST)), settling: true }),
    ).toEqual({
      docked: false,
    });
  });
});

describe("a plan reading's key", () => {
  it("is the same for readings with the same content", () => {
    expect(planReadingKey(readingOf(PLAN_FIRST))).toBe(
      planReadingKey(readingOf(JSON.stringify(JSON.parse(PLAN_FIRST)))),
    );
  });

  it.each([
    ["a label", { options: [{ number: 1, label: "Yes, auto-accept edits" }] }],
    ["the feedback row", { feedbackRow: 5 }],
    ["the plan path", { planPath: "~/.claude/plans/other.md" }],
  ])("changes with %s", (_, change) => {
    const base = readingOf(PLAN_FIRST);
    expect(planReadingKey({ ...base, ...change })).not.toBe(planReadingKey(base));
  });
});
