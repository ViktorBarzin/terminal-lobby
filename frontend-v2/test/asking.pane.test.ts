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
  askingFromPane,
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

describe("askingFromPane", () => {
  it("reports the question the pane is showing", () => {
    const a = askingFromPane([asking(dialog)]);
    expect(a?.questions[0]?.question).toBe("Which colour should the badge be?");
    expect(a?.questions[0]?.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    expect(a?.partial).toBe(false);
  });

  it("lets go the moment the dialog does", () => {
    expect(askingFromPane([asking(dialog), asking("")])).toBeNull();
  });

  it("keeps only the newest reading", () => {
    const other = JSON.stringify({
      questions: [
        {
          question: "Which shape?",
          header: "Shape",
          multiSelect: false,
          options: [{ label: "Circle", description: "" }],
        },
      ],
      count: 1,
    });
    expect(askingFromPane([asking(dialog), asking(other)])?.questions[0]?.question).toBe(
      "Which shape?",
    );
  });

  it("carries the headers of a call the pane can only show one question of", () => {
    const multi = JSON.stringify({
      questions: [
        {
          question: "Pick fruits",
          header: "",
          multiSelect: true,
          options: [{ label: "Apple", description: "" }],
        },
      ],
      headers: ["Fruit", "Drink"],
      count: 2,
      partial: true,
    });
    const a = askingFromPane([asking(multi)]);
    expect(a?.partial).toBe(true);
    expect(a?.headers).toEqual(["Fruit", "Drink"]);
    expect(a?.count).toBe(2);
  });

  it("ignores a body that is not a dialog", () => {
    expect(askingFromPane([asking("not json")])).toBeNull();
    expect(askingFromPane([asking("{}")])).toBeNull();
  });

  it("does not put a row in the transcript", () => {
    const rows = deriveRows([asking(dialog)]);
    expect(rows.filter((r) => r.kind === "question")).toHaveLength(0);
    expect(pendingQuestion(rows)).toBeNull();
  });
});

/**
 * A reading is only good while nothing has happened since.
 *
 * Same rule the transcript's own questions follow: a question is being asked
 * only while it is the last thing that happened. The server withdraws a reading
 * when the dialog goes, but a client that reconnects mid-flight, or a server a
 * tick behind, must not dock a card over a question the session has moved past.
 */
describe("a reading the session has moved past", () => {
  const after = (kind: string): Event =>
    ({ id: ++id, kind, session: "qa", body: "" }) as unknown as Event;

  it("is dropped once the transcript shows the session moved on", () => {
    for (const kind of ["tool_result", "text", "turn_end", "user"]) {
      expect(askingFromPane([asking(dialog), after(kind)])).toBeNull();
    }
  });

  it("survives a mode marker, which says nothing about the question", () => {
    const mode = {
      id: ++id,
      kind: "meta",
      meta: "permission-mode",
      body: "bypassPermissions",
      session: "qa",
    } as unknown as Event;
    expect(askingFromPane([asking(dialog), mode])?.questions[0]?.header).toBe("Colour");
  });
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
  it("gives the question card no questions", () => {
    expect(askingFromPane([asking(planFirst)])).toBeNull();
    expect(askingFromPane([asking(planNoAuto)])).toBeNull();
  });

  it("puts no question row in the transcript and leaves nothing pending", () => {
    const rows = deriveRows([asking(planFirst)]);
    expect(rows.filter((r) => r.kind === "question")).toHaveLength(0);
    expect(pendingQuestion(rows)).toBeNull();
  });

  it("replaces a question reading, since the newest reading wins across the kinds", () => {
    expect(askingFromPane([asking(dialog), asking(planFirst)])).toBeNull();
  });

  it("is ignored by the question card even if it carried questions", () => {
    // The kind is what tells the two apart, not the absence of a field.
    const odd = JSON.stringify({
      ...JSON.parse(planFirst),
      questions: JSON.parse(dialog).questions,
    });
    expect(askingFromPane([asking(odd)])).toBeNull();
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
