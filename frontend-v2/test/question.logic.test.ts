/**
 * The question card's drafts (ADR-0034), ported from T3 Code's
 * `apps/web/src/pendingUserInput.ts` so the card behaves the way T3's does:
 * a custom answer wins over picks, a single-select holds one pick, a
 * multi-select toggles, and nothing is sent until every question has an
 * answer, because Claude reads a missing one as a skipped question.
 */
import { describe, it, expect } from "vitest";
import {
  buildAnswers,
  heldFromEvents,
  resolveAnswer,
  setCustom,
  toggle,
  type Draft,
} from "../src/components/question.logic";
import type { Question } from "../src/components/canonicalize";
import type { Event } from "../src/types/events";

const colour: Question = {
  question: "Pick a colour",
  header: "Colour",
  multiSelect: false,
  options: [
    { label: "Red", description: "" },
    { label: "Blue", description: "" },
  ],
};
const fruits: Question = {
  question: "Pick fruits",
  header: "Fruit",
  multiSelect: true,
  options: [
    { label: "Apple", description: "" },
    { label: "Pear", description: "" },
    { label: "Plum", description: "" },
  ],
};

describe("toggle", () => {
  it("holds one pick on a single-select", () => {
    let d: Draft | undefined;
    d = toggle(colour, d, "Red");
    d = toggle(colour, d, "Blue");
    expect(d.selected).toEqual(["Blue"]);
  });
  it("adds and removes picks on a multi-select, keeping their order", () => {
    let d: Draft | undefined;
    d = toggle(fruits, d, "Plum");
    d = toggle(fruits, d, "Apple");
    expect(d.selected).toEqual(["Plum", "Apple"]);
    d = toggle(fruits, d, "Plum");
    expect(d.selected).toEqual(["Apple"]);
  });
  it("clears a custom answer, since a pick is a change of mind", () => {
    const d = toggle(colour, setCustom(undefined, "green"), "Red");
    expect(d.custom).toBe("");
    expect(resolveAnswer(colour, d)).toEqual(["Red"]);
  });
});

describe("setCustom", () => {
  it("sets the picks aside under typed words, so clearing the words brings them back", () => {
    const ticked = toggle(fruits, toggle(fruits, undefined, "Apple"), "Pear");
    const typed = setCustom(ticked, "mango");
    expect(resolveAnswer(fruits, typed)).toEqual(["mango"]);
    expect(resolveAnswer(fruits, setCustom(typed, ""))).toEqual(["Apple", "Pear"]);
  });
});

describe("resolveAnswer", () => {
  it("sends typed words on one line", () => {
    expect(resolveAnswer(colour, setCustom(undefined, " green,\n  actually "))).toEqual([
      "green, actually",
    ]);
  });
  it("prefers the custom answer over any pick", () => {
    const d = setCustom(toggle(fruits, undefined, "Pear"), "  mango  ");
    expect(resolveAnswer(fruits, d)).toEqual(["mango"]);
  });
  it("falls back to the picks when the custom answer is blank", () => {
    const d = setCustom(toggle(fruits, undefined, "Pear"), "   ");
    expect(resolveAnswer(fruits, d)).toEqual(["Pear"]);
  });
  it("is null with nothing picked or typed", () => {
    expect(resolveAnswer(colour, undefined)).toBeNull();
    expect(resolveAnswer(fruits, { selected: [], custom: "" })).toBeNull();
  });
});

describe("buildAnswers", () => {
  it("keys every answer by the question's text", () => {
    const drafts = {
      "Pick a colour": toggle(colour, undefined, "Blue"),
      "Pick fruits": toggle(fruits, toggle(fruits, undefined, "Apple"), "Plum"),
    };
    expect(buildAnswers([colour, fruits], drafts)).toEqual({
      "Pick a colour": ["Blue"],
      "Pick fruits": ["Apple", "Plum"],
    });
  });
  it("is null while any question is unanswered", () => {
    expect(
      buildAnswers([colour, fruits], { "Pick a colour": toggle(colour, undefined, "Red") }),
    ).toBeNull();
  });
});

let id = 0;
const ev = (e: Partial<Event> & { kind: string }): Event =>
  ({ id: ++id, session: "qa", ...e }) as unknown as Event;
const held = (body: string): Event =>
  ev({ kind: "meta", meta: "held", body } as Partial<Event> & { kind: string });

const heldBody = JSON.stringify({
  questions: [
    {
      question: "Pick a colour",
      header: "Colour",
      options: [{ label: "Red", description: "Warm.", preview: "#f00" }, { label: "Blue" }],
    },
  ],
});

describe("heldFromEvents", () => {
  it("reads the newest held question, previews included", () => {
    const qs = heldFromEvents([held(heldBody)]);
    expect(qs?.[0]?.question).toBe("Pick a colour");
    expect(qs?.[0]?.options[0]?.preview).toBe("#f00");
    expect(qs?.[0]?.options[1]?.preview).toBeUndefined();
  });
  it("is null once the hold is withdrawn", () => {
    expect(heldFromEvents([held(heldBody), held("")])).toBeNull();
  });
  it("outlives other events, since the record lands while the question waits", () => {
    const qs = heldFromEvents([
      held(heldBody),
      ev({ kind: "tool_use", tool: "AskUserQuestion", toolId: "t1" } as Partial<Event> & {
        kind: string;
      }),
      ev({ kind: "meta", meta: "asking", body: "" } as Partial<Event> & { kind: string }),
    ]);
    expect(qs).not.toBeNull();
  });
  it("is null once the turn has ended, whatever a stale cache says", () => {
    expect(heldFromEvents([held(heldBody), ev({ kind: "turn_end" })])).toBeNull();
  });
  it("is null once the question's result is in", () => {
    expect(
      heldFromEvents([
        held(heldBody),
        ev({ kind: "tool_use", tool: "AskUserQuestion", toolId: "t1" } as Partial<Event> & {
          kind: string;
        }),
        ev({ kind: "tool_result", toolId: "t1" } as Partial<Event> & { kind: string }),
      ]),
    ).toBeNull();
  });
  it("is null for a body with no questions", () => {
    expect(heldFromEvents([held("{}")])).toBeNull();
    expect(heldFromEvents([held("not json")])).toBeNull();
  });
});
