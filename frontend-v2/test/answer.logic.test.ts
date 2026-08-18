import { describe, expect, it } from "vitest";
import {
  batched,
  CHAT_LABEL,
  complete,
  landed,
  MAX_ANSWER_KEYS,
  OTHER_LABEL,
  optionIndex,
  planAnswer,
  REVIEW_MARKER,
  runAnswer,
  shownOptions,
  submitsImmediately,
  type DraftAnswer,
} from "../src/components/answer.logic";
import type { Question } from "../src/components/canonicalize";

function q(over: Partial<Question> = {}): Question {
  return {
    question: "Where should the parse live?",
    header: "Parse home",
    multiSelect: false,
    options: [
      { label: "All Go", description: "" },
      { label: "All TypeScript", description: "" },
      { label: "Split", description: "" },
    ],
    ...over,
  };
}

const pick = (...chosen: string[]): DraftAnswer => ({ chosen });

describe("shownOptions", () => {
  // The tool always appends these two; a plan that counted only the transcript's
  // options would send the wrong digit for anything after them.
  it("includes the Other and Chat options the tool always adds", () => {
    expect(shownOptions(q())).toEqual([
      "All Go",
      "All TypeScript",
      "Split",
      OTHER_LABEL,
      CHAT_LABEL,
    ]);
  });

  it("puts Other at the position its digit selects", () => {
    expect(optionIndex(q(), OTHER_LABEL)).toBe(3);
    expect(optionIndex(q(), CHAT_LABEL)).toBe(4);
  });
});

describe("submitsImmediately", () => {
  // This is the ONE shape the text view could answer before this work: the CLI
  // submits it without a review screen.
  it("is true for a single single-select question", () => {
    expect(submitsImmediately([q()])).toBe(true);
  });

  it("is false for a multi-select question", () => {
    expect(submitsImmediately([q({ multiSelect: true })])).toBe(false);
  });

  it("is false for more than one question", () => {
    expect(submitsImmediately([q(), q()])).toBe(false);
  });
});

describe("planAnswer — a single single-select question", () => {
  it("sends the option's digit and nothing else", () => {
    const steps = planAnswer([q()], [pick("All TypeScript")]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.batches).toEqual([["2"]]);
  });

  // The dialog is gone by then; the transcript is what confirms the answer.
  it("has nothing to verify afterwards", () => {
    expect(planAnswer([q()], [pick("Split")])[0]!.expect).toBe("");
  });

  it("sends nothing at all when nothing was chosen", () => {
    expect(planAnswer([q()], [pick()])).toEqual([]);
  });
});

describe("planAnswer — multi-select", () => {
  const multi = q({ multiSelect: true });

  it("navigates and toggles with Space, then leaves the question", () => {
    // "All Go" is index 0 (already focused), "Split" is index 2.
    const steps = planAnswer([multi], [pick("All Go", "Split")]);
    expect(steps[0]!.batches[0]).toEqual(["Space", "Down", "Down", "Space"]);
    expect(steps[0]!.batches[1]).toEqual(["Enter"]);
  });

  it("toggles in list order however the reader picked them", () => {
    const a = planAnswer([multi], [pick("Split", "All Go")])[0]!;
    const b = planAnswer([multi], [pick("All Go", "Split")])[0]!;
    expect(a.batches).toEqual(b.batches);
  });

  // Multi-select does not submit on its own, so it reaches the review screen.
  it("expects the review screen, and adds the final Submit", () => {
    const steps = planAnswer([multi], [pick("All Go")]);
    expect(steps[0]!.expect).toBe(REVIEW_MARKER);
    expect(steps.at(-1)!.batches).toEqual([["Enter"]]);
    expect(steps.at(-1)!.what).toContain("submitting");
  });
});

describe("planAnswer — several questions", () => {
  const first = q({ question: "Which lane?", header: "Lane" });
  const second = q({ question: "Where should the parse live?", header: "Parse home" });
  const third = q({ question: "How does it land?", header: "Landing" });

  it("walks each question, then submits from the review screen", () => {
    const steps = planAnswer(
      [first, second, third],
      [pick("All Go"), pick("Split"), pick("All TypeScript")],
    );
    expect(steps).toHaveLength(4);
    expect(steps[0]!.batches).toEqual([["1"]]);
    expect(steps[1]!.batches).toEqual([["3"]]);
    expect(steps[2]!.batches).toEqual([["2"]]);
    expect(steps[3]!.batches).toEqual([["Enter"]]);
  });

  // This is what makes the sequence checkable at all: the next question's text
  // comes from the transcript, so we know what the pane should show.
  it("expects the NEXT question's text after each answer", () => {
    const steps = planAnswer([first, second, third], [pick("All Go"), pick("Split"), pick("Split")]);
    expect(steps[0]!.expect).toBe("Where should the parse live?");
    expect(steps[1]!.expect).toBe("How does it land?");
    expect(steps[2]!.expect).toBe(REVIEW_MARKER);
    expect(steps[3]!.expect).toBe("");
  });
});

describe("planAnswer — the free-text Other option", () => {
  it("focuses the option, types the text, then confirms", () => {
    const steps = planAnswer([q()], [{ chosen: [OTHER_LABEL], other: "none of these" }]);
    expect(steps[0]!.batches).toEqual([["4"]]);
    expect(steps[0]!.text).toBe("none of these");
    expect(steps[0]!.after).toEqual(["Enter"]);
  });

  it("trims the text, since a trailing newline would submit it early", () => {
    const steps = planAnswer([q()], [{ chosen: [OTHER_LABEL], other: "  my answer  " }]);
    expect(steps[0]!.text).toBe("my answer");
  });

  it("falls back to the plain option path when no text was typed", () => {
    const steps = planAnswer([q()], [{ chosen: [OTHER_LABEL], other: "   " }]);
    expect(steps[0]!.text).toBeUndefined();
    expect(steps[0]!.batches).toEqual([["4"]]);
  });
});

describe("batched", () => {
  // The cap is the server's, and it is there to stop a browser typing a
  // paragraph into somebody's shell. A wizard walk is no reason to widen it.
  it("never exceeds the server's cap", () => {
    const keys = Array.from({ length: 19 }, () => "Down");
    const out = batched(keys);
    expect(out.every((b) => b.length <= MAX_ANSWER_KEYS)).toBe(true);
    expect(out.flat()).toEqual(keys);
  });

  it("is empty for no keys", () => {
    expect(batched([])).toEqual([]);
  });
});

describe("complete", () => {
  it("needs every question answered before Send is offered", () => {
    expect(complete([q(), q()], [pick("Split")])).toBe(false);
    expect(complete([q(), q()], [pick("Split"), pick("All Go")])).toBe(true);
  });

  it("treats Other with no text as unanswered", () => {
    expect(complete([q()], [{ chosen: [OTHER_LABEL] }])).toBe(false);
    expect(complete([q()], [{ chosen: [OTHER_LABEL], other: "because" }])).toBe(true);
  });

  it("rejects a label the dialog does not show", () => {
    expect(complete([q()], [pick("Something else entirely")])).toBe(false);
  });

  it("is false when there is nothing to answer", () => {
    expect(complete([], [])).toBe(false);
  });
});

describe("landed", () => {
  // The CLI wraps a long question to the dialog's width, so the pane holds the
  // same words with different whitespace. Matching the exact string would read
  // a correct step as a desync at 80 columns.
  it("matches across the CLI's own wrapping", () => {
    const pane = "│ Where should the\n│ parse live?\n│  1. All Go\n";
    expect(landed(pane, "Where should the parse live?")).toBe(true);
  });

  it("matches a truncated question by its opening", () => {
    const pane = "│ Where should the parse live? The dialog's wording ch…\n";
    expect(
      landed(pane, "Where should the parse live? The dialog's wording changes whenever it restyles"),
    ).toBe(true);
  });

  it("is false when the pane moved somewhere else", () => {
    expect(landed("│ 1. Yes\n│ 2. No\n", "Where should the parse live?")).toBe(false);
  });

  it("is true when there is nothing to expect", () => {
    expect(landed("anything at all", "")).toBe(true);
  });
});

describe("runAnswer", () => {
  // No delays in tests: the waits exist for a real TUI's repaint.
  const NO_WAIT = [0, 0];

  function io(panes: (string | null)[]) {
    const sent: string[][] = [];
    const typed: string[] = [];
    let i = 0;
    return {
      sent,
      typed,
      io: {
        keys: async (k: string[]) => {
          sent.push(k);
          return true;
        },
        text: async (t: string) => {
          typed.push(t);
          return true;
        },
        pane: async () => panes[Math.min(i++, panes.length - 1)] ?? null,
      },
    };
  }

  const first = q({ question: "Which lane?", header: "Lane" });
  const second = q({ question: "Where should the parse live?", header: "Parse home" });

  it("sends every batch in order and reports success", async () => {
    const steps = planAnswer([first, second], [pick("All Go"), pick("Split")]);
    const { io: i, sent } = io(["Where should the parse live?", REVIEW_MARKER]);
    await expect(runAnswer(steps, i, NO_WAIT)).resolves.toEqual({ ok: true });
    expect(sent).toEqual([["1"], ["3"], ["Enter"]]);
  });

  // The whole reason for checking: without it the remaining answers go into
  // whatever screen is actually there, and a wrong one gets submitted unseen.
  it("STOPS when the pane did not move on, rather than typing into it", async () => {
    const steps = planAnswer([first, second], [pick("All Go"), pick("Split")]);
    const { io: i, sent } = io(["some entirely different screen"]);
    const res = await runAnswer(steps, i, NO_WAIT);
    expect(res).toEqual({ ok: false, reason: "desync", what: 'answering "Lane"' });
    // Only the first question's keys went in; the rest were never sent.
    expect(sent).toEqual([["1"]]);
  });

  it("stops when the session refuses the keys", async () => {
    const steps = planAnswer([first, second], [pick("All Go"), pick("Split")]);
    const { io: i } = io([REVIEW_MARKER]);
    const res = await runAnswer(steps, { ...i, keys: async () => false }, NO_WAIT);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe("refused");
  });

  it("tells an unreadable pane apart from a wrong one", async () => {
    const steps = planAnswer([first, second], [pick("All Go"), pick("Split")]);
    const { io: i } = io([null, null]);
    const res = await runAnswer(steps, i, NO_WAIT);
    expect((res as { reason: string }).reason).toBe("unreadable");
  });

  it("confirms the free text reached the field before committing it", async () => {
    const steps = planAnswer([q()], [{ chosen: [OTHER_LABEL], other: "none of these" }]);
    const { io: i, sent, typed } = io(["❯ none of these"]);
    await expect(runAnswer(steps, i, NO_WAIT)).resolves.toEqual({ ok: true });
    expect(typed).toEqual(["none of these"]);
    // Focus the option, then commit — and the commit came after the check.
    expect(sent).toEqual([["4"], ["Enter"]]);
  });

  // An Enter on an empty field answers the question with nothing at all.
  it("does not commit free text that never arrived", async () => {
    const steps = planAnswer([q()], [{ chosen: [OTHER_LABEL], other: "none of these" }]);
    const { io: i, sent } = io(["❯ "]);
    const res = await runAnswer(steps, i, NO_WAIT);
    expect((res as { reason: string }).reason).toBe("desync");
    expect(sent).toEqual([["4"]]); // no Enter
  });

  it("does nothing at all for an empty plan", async () => {
    const { io: i, sent } = io([""]);
    await expect(runAnswer([], i, NO_WAIT)).resolves.toEqual({ ok: true });
    expect(sent).toEqual([]);
  });
});
