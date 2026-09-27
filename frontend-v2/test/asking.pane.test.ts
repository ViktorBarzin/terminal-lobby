/**
 * The question the PANE reports, for the window where the transcript has not
 * caught up.
 *
 * Claude Code does not always write the AskUserQuestion record while its dialog
 * is up — two of five consecutive calls in one session were written only when
 * the question was answered, 112 s later in one case (measured 2026-08-28). The
 * server reads the pane for those and reports it as a `meta: "asking"` event;
 * the transcript still wins whenever it holds the call.
 */
import { describe, it, expect } from "vitest";
import {
  deriveRows,
  pendingQuestion,
  planFromPane,
} from "../src/components/timeline.logic";
import type { DialogView } from "../src/lib/answer-api";
import type { Event } from "../src/types/events";

let id = 0;
const asking = (body: string): Event =>
  ({ id: ++id, kind: "meta", meta: "asking", body, session: "qa" }) as unknown as Event;

const dialog = JSON.stringify({
  questions: [
    {
      question: "Which colour should the badge be?",
      header: "Colour",
      multiSelect: false,
      options: [
        { label: "Red", description: "Make it red." },
        { label: "Blue", description: "" },
      ],
    },
  ],
  count: 1,
});

/**
 * The plan approval travels on the same `asking` meta as a question reading,
 * so the newest reading wins across the two kinds and one empty body withdraws
 * either (docs/plans/2026-09-24-text-composer-redesign.md, contract 2).
 *
 * The readings below are what `sessionio.ParsePlanDialog` makes of its
 * captures, byte for byte: `plan-first.txt` and `plan-no-auto.txt` in
 * sessionio/testdata, the second pinned by TestPlanReadingWireShape.
 */
const planFirst = JSON.stringify({
  kind: "plan",
  options: [
    { number: 1, label: "Yes, clear context (6% used) and use auto mode" },
    { number: 2, label: "Yes, and use auto mode" },
    { number: 3, label: "Yes, manually approve edits" },
  ],
  feedbackRow: 4,
  planPath: "~/.claude/plans/plan-how-to-create-calm-starfish.md",
});
const planNoAuto =
  '{"kind":"plan","options":[{"number":1,"label":"Yes, auto-accept edits"},' +
  '{"number":2,"label":"Yes, manually approve edits"}],"feedbackRow":3,' +
  '"planPath":"~/.claude/plans/plan-do-not-execute-delightful-whisper.md"}';

describe("a plan reading on the asking meta", () => {
  it("puts no question row in the transcript and leaves nothing pending", () => {
    const rows = deriveRows([asking(planFirst)]);
    expect(rows.filter((r) => r.kind === "question")).toHaveLength(0);
    expect(pendingQuestion(rows)).toBeNull();
  });

});

describe("planFromPane", () => {
  it("reads the three approve rows and the feedback row of the usual layout", () => {
    expect(planFromPane(planFirst)).toEqual({
      options: [
        { number: 1, label: "Yes, clear context (6% used) and use auto mode" },
        { number: 2, label: "Yes, and use auto mode" },
        { number: 3, label: "Yes, manually approve edits" },
      ],
      feedbackRow: 4,
      planPath: "~/.claude/plans/plan-how-to-create-calm-starfish.md",
    });
  });

  it("reads two approve rows when the session has no auto mode and no clear context", () => {
    const p = planFromPane(planNoAuto);
    expect(p?.options.map((o) => o.number)).toEqual([1, 2]);
    expect(p?.options.map((o) => o.label)).toEqual([
      "Yes, auto-accept edits",
      "Yes, manually approve edits",
    ]);
    expect(p?.feedbackRow).toBe(3);
  });

  it("takes the reading an answer reply carries, already decoded", () => {
    // POST /answer returns the same reading as its `dialog`, so the card reads
    // both through one accessor.
    const view = JSON.parse(planNoAuto) as DialogView;
    expect(planFromPane(view)).toEqual(planFromPane(planNoAuto));
  });

  it("reads a footer that names no plan file as an empty path", () => {
    const { planPath: _, ...rest } = JSON.parse(planFirst) as Record<string, unknown>;
    expect(planFromPane(JSON.stringify(rest))?.planPath).toBe("");
  });

  it("is null for a question reading, which has no kind", () => {
    expect(planFromPane(dialog)).toBeNull();
  });

  it("is null for the empty body that withdraws a reading, and for no reading", () => {
    expect(planFromPane("")).toBeNull();
    expect(planFromPane(null)).toBeNull();
    expect(planFromPane(undefined)).toBeNull();
  });

  it("is null for a plan reading it cannot trust, so nothing offers a row the pane does not draw", () => {
    const base = JSON.parse(planFirst) as Record<string, unknown>;
    for (const broken of [
      "not json",
      JSON.stringify({ ...base, options: [] }),
      JSON.stringify({ ...base, options: "1. Yes" }),
      JSON.stringify({ ...base, options: [{ number: "1", label: "Yes" }] }),
      JSON.stringify({ ...base, options: [{ number: 1, label: "" }] }),
      JSON.stringify({ ...base, options: [{ number: 1.5, label: "Yes" }] }),
      JSON.stringify({ ...base, feedbackRow: undefined }),
      JSON.stringify({ ...base, feedbackRow: 2 }),
    ]) {
      expect(planFromPane(broken)).toBeNull();
    }
  });
});
