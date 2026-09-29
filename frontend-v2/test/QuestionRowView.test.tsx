/**
 * An answered question in the conversation's history. Found live on
 * 2026-09-27: every answer was listed under every question, and a
 * multi-select's picks were never marked, since the CLI records them as one
 * string joined by ", ".
 */
import { describe, it, expect } from "vitest";
import { render } from "@solidjs/testing-library";
import { QuestionRowView } from "../src/components/rows";
import type { QuestionRow } from "../src/components/timeline.logic";

const row: QuestionRow = {
  kind: "question",
  key: "q",
  id: 1,
  toolId: "q2",
  turnKey: "t1",
  pending: false,
  questions: [
    {
      question: "Which drink do you want?",
      header: "Drink",
      multiSelect: false,
      options: [
        { label: "Tea", description: "" },
        { label: "Coffee", description: "" },
      ],
    },
    {
      question: "Which fruits do you want?",
      header: "Fruit",
      multiSelect: true,
      options: [
        { label: "Apple", description: "" },
        { label: "Pear", description: "" },
        { label: "Plum", description: "" },
      ],
    },
  ],
  answers: ["Coffee", "Apple, Plum"],
};

describe("<QuestionRowView> once answered", () => {
  it("shows each question's own answer under it", () => {
    const r = render(() => <QuestionRowView row={row} />);
    const qs = r.container.querySelectorAll(".tl-question");
    expect(qs[0]!.querySelector(".tl-question-answer")?.textContent).toBe("answered: Coffee");
    expect(qs[1]!.querySelector(".tl-question-answer")?.textContent).toBe("answered: Apple, Plum");
  });

  it("marks every pick of a multi-select", () => {
    const r = render(() => <QuestionRowView row={row} />);
    const chosen = [...r.container.querySelectorAll('.tl-question-option[data-chosen="true"]')].map(
      (o) => o.querySelector(".tl-option-label")?.textContent,
    );
    expect(chosen).toEqual(["Coffee", "Apple", "Plum"]);
  });

  // Deployed review round 3 of the T3 pass (2026-09-29): "Tabs, but sticky on
  // scroll" typed through "Type your own answer" drew the Tabs row as picked,
  // because the ", " split meant for a multi-select's picks read free text too.
  it("marks no option for typed words that start with a label and a comma", () => {
    const r = render(() => (
      <QuestionRowView
        row={{ ...row, answers: ["Coffee, but decaf please", "Apple, and a plum if ripe"] }}
      />
    ));
    expect(r.container.querySelectorAll('.tl-question-option[data-chosen="true"]')).toHaveLength(0);
    const qs = r.container.querySelectorAll(".tl-question");
    expect(qs[0]!.querySelector(".tl-question-answer")?.textContent).toBe(
      "answered: Coffee, but decaf please",
    );
  });

  it("marks no option for typed words that hold ', <label>'", () => {
    const r = render(() => (
      <QuestionRowView row={{ ...row, answers: ["None, Tea", "Fig, Pear"] }} />
    ));
    expect(r.container.querySelectorAll('.tl-question-option[data-chosen="true"]')).toHaveLength(0);
  });

  it("says nothing under a question the answer left out", () => {
    const r = render(() => <QuestionRowView row={{ ...row, answers: ["Tea", ""] }} />);
    const qs = r.container.querySelectorAll(".tl-question");
    expect(qs[1]!.querySelector(".tl-question-answer")).toBeNull();
  });
});

describe("<QuestionRowView> after Chat about this", () => {
  it("shows the words the reader sent instead of an answer, once", () => {
    const r = render(() => (
      <QuestionRowView row={{ ...row, answers: [], replied: "Why do you ask?" }} />
    ));
    const lines = [...r.container.querySelectorAll(".tl-question-answer")].map(
      (e) => e.textContent,
    );
    expect(lines).toEqual(["replied instead: Why do you ask?"]);
  });

  it("says the questions were declined when no words came with it", () => {
    const r = render(() => <QuestionRowView row={{ ...row, answers: [], replied: "" }} />);
    const lines = [...r.container.querySelectorAll(".tl-question-answer")].map(
      (e) => e.textContent,
    );
    expect(lines).toEqual(["not answered: you chose to talk about it instead"]);
  });
});
