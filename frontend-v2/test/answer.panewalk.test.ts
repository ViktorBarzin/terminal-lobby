/**
 * Answering a multi-question call from the pane, one question at a time.
 *
 * Viktor, 2026-09-04, on a screenshot of a 4-question call: *"not all question
 * tools work in text mode… it's a multi select prompt that can't be handled in
 * text mode"*. multi-select works; the shape that handed over to the Terminal is
 * the multi-question one, and only while the transcript record had not landed.
 *
 * 22.4% of the 1,045 calls in this box's corpus carry more than one question,
 * and waiting for the record is not a fix: of five calls watched directly on
 * 2026-08-28, two records were written only when the question was answered, one
 * of them 112 seconds later.
 *
 * The pane draws one question at a time and marks the tab bar `☒` as each is
 * answered, so the walk is: answer what is drawn, wait for that header's box to
 * fill, let the next reading bring the next question.
 */
import { describe, it, expect } from "vitest";
import {
  OTHER_LABEL,
  planPaneStep,
  runAnswer,
  type AnswerIO,
  type PaneDialog,
} from "../src/components/answer.logic";

const FRUIT = {
  question: "Pick fruits",
  header: "Fruit",
  multiSelect: true,
  options: [
    { label: "Apple", description: "Include apples." },
    { label: "Pear", description: "" },
    { label: "Plum", description: "" },
  ],
};

const DRINK = {
  question: "Pick one drink",
  header: "Drink",
  multiSelect: false,
  options: [
    { label: "Tea", description: "" },
    { label: "Coffee", description: "" },
  ],
};

const atFruit: PaneDialog = {
  questions: [FRUIT],
  headers: ["Fruit", "Drink"],
  count: 2,
  answered: 0,
  partial: true,
};

const atDrink: PaneDialog = {
  questions: [DRINK],
  headers: ["Fruit", "Drink"],
  count: 2,
  answered: 1,
  partial: true,
};

const atReview: PaneDialog = {
  questions: [{ question: "Ready to submit your answers?", header: "", multiSelect: false, options: [] }],
  headers: ["Fruit", "Drink"],
  count: 2,
  answered: 2,
  partial: true,
};

describe("planPaneStep", () => {
  it("waits for the answered box of the question it just answered", () => {
    const steps = planPaneStep(atFruit, { chosen: ["Tea"] });
    // Tea is not one of Fruit's options, so nothing is typed.
    expect(steps).toEqual([]);
  });

  it("types a single-select answer as its dialog digit", () => {
    const steps = planPaneStep(atDrink, { chosen: ["Coffee"] });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.batches).toEqual([["2"]]);
    expect(steps[0]!.expect).toBe("☒ Drink");
  });

  it("toggles a multi-select answer and leaves with Enter", () => {
    const steps = planPaneStep(atFruit, { chosen: ["Apple", "Plum"] });
    expect(steps[0]!.batches).toEqual([["Space", "Down", "Down", "Space"], ["Enter"]]);
    expect(steps[0]!.expect).toBe("☒ Fruit");
  });

  it("focuses the free-text option, types, then confirms", () => {
    // OTHER_LABEL is the transcript's word for it ("Other"); the pane draws it
    // as "Type something" and ParseDialog strips it, so the card re-offers it at
    // the same index and the digit typed is the digit the CLI is listening for.
    const steps = planPaneStep(atDrink, { chosen: [OTHER_LABEL], other: "Water" });
    expect(steps[0]!.batches).toEqual([["3"]]);
    expect(steps[0]!.text).toBe("Water");
    expect(steps[0]!.after).toEqual(["Enter"]);
    expect(steps[0]!.expect).toBe("☒ Drink");
  });

  it("submits at the review screen and expects the dialog to be gone", () => {
    const steps = planPaneStep(atReview, { chosen: [] });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.batches).toEqual([["Enter"]]);
    expect(steps[0]!.expect).toBe("");
    expect(steps[0]!.what).toMatch(/submit/i);
  });

  it("sends nothing when nothing is chosen", () => {
    expect(planPaneStep(atFruit, { chosen: [] })).toEqual([]);
  });

  it("sends nothing when the free-text option is picked with no text", () => {
    expect(planPaneStep(atDrink, { chosen: [OTHER_LABEL], other: "  " })).toEqual([]);
  });

  it("expects the header of the question it answered, not the next one", () => {
    // The tab bar marks the question just left, so the wait is on `☒ Fruit`
    // rather than on anything about Drink — the next question's own text is
    // undrawn and unknown until this one lands.
    expect(planPaneStep(atFruit, { chosen: ["Apple"] })[0]!.expect).toBe("☒ Fruit");
  });

  it("falls back to no expectation when the tab bar named no header", () => {
    // A tab bar the parser could not read leaves nothing to wait for. Sending
    // one question with no check is still better than refusing the call, and it
    // stops after that one question either way.
    const noHeaders: PaneDialog = { ...atDrink, headers: [] };
    expect(planPaneStep(noHeaders, { chosen: ["Tea"] })[0]!.expect).toBe("");
  });
});

describe("running one step against a pane", () => {
  const io = (panes: string[]): AnswerIO & { typed: string[][] } => {
    const typed: string[][] = [];
    let read = 0;
    return {
      typed,
      keys: async (b) => {
        typed.push(b);
        return true;
      },
      text: async () => true,
      pane: async () => panes[Math.min(read++, panes.length - 1)] ?? null,
    };
  };

  it("lands when the answered box fills", async () => {
    const box = io(["←  ☒ Fruit  ☐ Drink  ✔ Submit  →\n\nPick one drink"]);
    const res = await runAnswer(planPaneStep(atFruit, { chosen: ["Apple"] }), box, [0]);
    expect(res).toEqual({ ok: true });
    expect(box.typed).toEqual([["Space"], ["Enter"]]);
  });

  it("stops when the box did not fill, rather than typing on", async () => {
    const box = io(["←  ☐ Fruit  ☐ Drink  ✔ Submit  →\n\nPick fruits"]);
    const res = await runAnswer(planPaneStep(atFruit, { chosen: ["Apple"] }), box, [0, 0]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("desync");
  });

  // Measured against Claude Code on 2026-09-04, and recorded because it bounds
  // what the check is worth: a multi-select question's tab box fills on the
  // FIRST toggle, not on the Enter that leaves it. `←  ☐ Picks  ☐ One` became
  // `←  ☒ Picks  ☐ One` with a single Space sent and no Enter.
  it("passes on a multi-select box that filled before its Enter", async () => {
    const box = io(["←  ☒ Fruit  ☐ Drink  ✔ Submit  →\n\nPick fruits"]);
    const res = await runAnswer(planPaneStep(atFruit, { chosen: ["Apple"] }), box, [0]);
    // Still ok, and that is the known limit rather than a surprise: the card
    // answers whatever the next reading draws, so a step number one ahead of
    // the screen is the whole cost.
    expect(res).toEqual({ ok: true });
  });

  it("still catches a question where nothing landed at all", async () => {
    const box = io(["←  ☐ Fruit  ☐ Drink  ✔ Submit  →\n\nPick fruits"]);
    const res = await runAnswer(planPaneStep(atFruit, { chosen: ["Apple"] }), box, [0, 0]);
    expect(res.ok).toBe(false);
  });

  it("reports an unreadable pane apart from a wrong one", async () => {
    const blind: AnswerIO = {
      keys: async () => true,
      text: async () => true,
      pane: async () => null,
    };
    const res = await runAnswer(planPaneStep(atFruit, { chosen: ["Apple"] }), blind, [0, 0]);
    expect(res.ok === false && res.reason).toBe("unreadable");
  });
});
