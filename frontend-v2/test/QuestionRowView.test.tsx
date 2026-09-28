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

  it("says nothing under a question the answer left out", () => {
    const r = render(() => <QuestionRowView row={{ ...row, answers: ["Tea", ""] }} />);
    const qs = r.container.querySelectorAll(".tl-question");
    expect(qs[1]!.querySelector(".tl-question-answer")).toBeNull();
  });
});
