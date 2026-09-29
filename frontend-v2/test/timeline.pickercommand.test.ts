/**
 * A model or effort change made from the model sheet.
 *
 * The sheet drives the CLI's own pickers, so applying a change types a bare
 * `/model` or `/effort` into the pane and the transcript records it as a
 * user record, followed by the CLI's receipt ("Set effort level to medium").
 * The receipt says what changed. The bare command drew a user bubble nobody
 * wrote and became a history entry that ↑ kept landing on (deployed review
 * round 5, 2026-09-29). A command typed with an argument is the writer's own
 * and stays.
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import { deriveRows, promptHistory } from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const EFFORT_CHANGE: Event[] = [
  ev({ id: 1, kind: "user", turnId: "t1", body: "hello", at: 1_000 }),
  ev({ id: 2, kind: "text", turnId: "t1", body: "Hi.", at: 1_500 }),
  ev({ id: 3, kind: "turn_end", turnId: "t1", at: 1_600 }),
  ev({ id: 4, kind: "user", turnId: "t2", body: "/effort", at: 2_000 }),
  ev({ id: 5, kind: "state", turnId: "t2", body: "Set effort level to medium", at: 2_000 }),
  ev({ id: 6, kind: "turn_end", turnId: "t2", at: 2_000 }),
  ev({ id: 7, kind: "user", turnId: "t3", body: "/model", at: 3_000 }),
  ev({ id: 8, kind: "state", turnId: "t3", body: "Set model to Haiku 4.5", at: 3_000 }),
  ev({ id: 9, kind: "turn_end", turnId: "t3", at: 3_000 }),
];

const bubbles = (events: Event[]) =>
  deriveRows(events).flatMap((r) => (r.kind === "user" ? [r.body] : []));

const flat = (events: Event[]): string => JSON.stringify(deriveRows(events));

describe("a bare /model or /effort from the sheet", () => {
  it("draws no user bubble", () => {
    expect(bubbles(EFFORT_CHANGE)).toEqual(["hello"]);
  });

  it("keeps the CLI's receipt, which says what changed", () => {
    const rows = flat(EFFORT_CHANGE);
    expect(rows).toContain("Set effort level to medium");
    expect(rows).toContain("Set model to Haiku 4.5");
  });

  it("is left out of ↑ history, from the stream and from the seed", () => {
    expect(promptHistory(EFFORT_CHANGE)).toEqual(["hello"]);
    expect(promptHistory([], { at: 0, queue: [], prompts: ["older", "/model", "/effort"] })).toEqual([
      "older",
    ]);
  });

  it("keeps a command the writer typed with an argument", () => {
    const typed = [
      ev({ id: 1, kind: "user", turnId: "t1", body: "/model haiku", at: 1_000 }),
      ev({ id: 2, kind: "state", turnId: "t1", body: "Set model to Haiku 4.5", at: 1_000 }),
      ev({ id: 3, kind: "turn_end", turnId: "t1", at: 1_000 }),
    ];
    expect(bubbles(typed)).toEqual(["/model haiku"]);
    expect(promptHistory(typed)).toEqual(["/model haiku"]);
  });
});
