/**
 * An answered question, a plan approval and a status notice stay out of a
 * finished turn's fold.
 *
 * A turn that asked a question and then replied folded the question behind a
 * row reading "1 step", Quiet line's wording, and the answer the reader chose
 * never showed (deployed review rounds 3 to 5, 2026-09-28). A background
 * notice folded the same way. They are the conversation, not Claude's work:
 * the question row names the question and shows the answer, and the fold holds
 * only the work and the earlier replies.
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import { deriveRows, type TimelineRow } from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const shape = (rows: TimelineRow[]) =>
  rows.map((r) => (r.kind === "turn-fold" ? `fold(${r.summary})` : r.kind));

const ASKED: Event[] = [
  ev({ id: 1, kind: "user", turnId: "t1", body: "pick a route", at: 1_000 }),
  ev({
    id: 2,
    kind: "tool_use",
    turnId: "t1",
    tool: "AskUserQuestion",
    toolId: "q1",
    body: '{"questions":[{"question":"Which way?","header":"Route","options":[{"label":"Left"},{"label":"Right"}]}]}',
    at: 1_100,
  }),
  ev({
    id: 3,
    kind: "tool_result",
    turnId: "t1",
    toolId: "q1",
    body: "",
    result: { answers: { "Which way?": "Right" } },
    at: 5_000,
  }),
  ev({ id: 4, kind: "text", turnId: "t1", body: "Going right.", at: 5_500 }),
  ev({ id: 5, kind: "turn_end", turnId: "t1", at: 5_600 }),
];

describe("a finished turn that asked a question", () => {
  it("keeps the answered question in view, with no '1 step' fold", () => {
    const rows = deriveRows(ASKED);
    expect(shape(rows)).toEqual(["user", "question", "message"]);
    const q = rows.find((r) => r.kind === "question");
    expect(q?.kind === "question" && q.answers).toEqual(["Right"]);
  });

  it("folds the work around it, and names what the fold holds", () => {
    const events: Event[] = [
      ...ASKED.slice(0, 1),
      ev({ id: 10, kind: "tool_use", turnId: "t1", tool: "Bash", toolId: "b1", body: '{"command":"ls"}', at: 1_050 }),
      ev({ id: 11, kind: "tool_result", turnId: "t1", toolId: "b1", body: "a", at: 1_060 }),
      ev({ id: 12, kind: "text", turnId: "t1", body: "Let me ask.", at: 1_070 }),
      ...ASKED.slice(1),
    ];
    const s = shape(deriveRows(events));
    expect(s).toContain("question");
    expect(s.join(" ")).not.toMatch(/\bsteps?\b/);
    expect(s[s.length - 1]).toBe("message");
  });
});

describe("a finished turn with a background notice", () => {
  it("keeps the notice as its line, with no '1 step' fold", () => {
    const rows = deriveRows([
      ev({ id: 1, kind: "user", turnId: "t1", body: "wait for it", at: 1_000 }),
      ev({ id: 2, kind: "state", turnId: "t1", body: 'Background command "sleep 5" completed (exit code 0)', at: 2_000 }),
      ev({ id: 3, kind: "text", turnId: "t1", body: "Done.", at: 2_100 }),
      ev({ id: 4, kind: "turn_end", turnId: "t1", at: 2_200 }),
    ]);
    expect(shape(rows)).toEqual(["user", "status", "message"]);
  });
});
