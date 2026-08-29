/**
 * Everything an option says has to be readable.
 *
 * Viktor, 2026-08-29: "when there's a question whose answers are too long we
 * trim them and can't see everything."
 *
 * Two places lost the text, for different reasons:
 *  - the live card clamps each description to two lines and expands only the
 *    CHOSEN row. Single-select is exclusive, so exactly one description could
 *    be read at a time, and reading a fourth meant choosing it.
 *  - the transcript's recorded row never rendered descriptions at all. They
 *    were a `title` attribute — a hover tooltip, on a view whose primary
 *    device has no hover.
 *
 * Both get the same control: a toggle that unclamps every description at once,
 * so "show me everything" is one press rather than a tour. The clamp stays the
 * default because comparing four options wants four summaries, not four essays.
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { QuestionCard } from "../src/components/QuestionCard";
import { QuestionRowView } from "../src/components/rows";
import type { Question } from "../src/components/canonicalize";
import type { QuestionRow } from "../src/components/timeline.logic";

const LONG = "A long reason that runs past two lines and carries the detail the label leaves out.";

const questions: Question[] = [
  {
    header: "Push path",
    question: "Which mechanism?",
    multiSelect: false,
    options: [
      { label: "Woodpecker", description: LONG },
      { label: "Tailnet", description: LONG + " Second one." },
    ],
  },
];

const row = (over: Partial<QuestionRow> = {}): QuestionRow =>
  ({
    kind: "question",
    id: "e1",
    toolId: "t1",
    questions,
    answers: ["Woodpecker"],
    pending: false,
    ...over,
  }) as QuestionRow;

describe("the live card can show every description", () => {
  it("clamps by default", () => {
    const { container } = render(() => (
      <QuestionCard questions={questions} onSend={async () => {}} onChat={() => {}} />
    ));
    expect(container.querySelector(".tl-qcard-options")!.getAttribute("data-full")).toBeNull();
  });

  it("unclamps all of them on one press, and says how to go back", () => {
    const { container, getByText } = render(() => (
      <QuestionCard questions={questions} onSend={async () => {}} onChat={() => {}} />
    ));
    fireEvent.click(getByText(/show all/i));
    expect(container.querySelector(".tl-qcard-options")!.getAttribute("data-full")).toBe("true");
    fireEvent.click(getByText(/show less/i));
    expect(container.querySelector(".tl-qcard-options")!.getAttribute("data-full")).toBeNull();
  });

  it("offers the toggle only when something is actually clamped", () => {
    const short: Question[] = [
      { ...questions[0]!, options: [{ label: "Yes", description: "" }] },
    ];
    const { queryByText } = render(() => (
      <QuestionCard questions={short} onSend={async () => {}} onChat={() => {}} />
    ));
    expect(queryByText(/show all/i)).toBeNull();
  });
});

describe("the recorded row shows its descriptions", () => {
  it("renders them instead of hiding them in a tooltip", () => {
    const { container } = render(() => <QuestionRowView row={row()} />);
    const descs = container.querySelectorAll(".tl-option-desc");
    expect(descs.length).toBe(2);
    expect(descs[0]!.textContent).toContain("carries the detail");
  });

  it("has the same toggle", () => {
    const { container, getByText } = render(() => <QuestionRowView row={row()} />);
    fireEvent.click(getByText(/show all/i));
    expect(container.querySelector(".tl-question-options")!.getAttribute("data-full")).toBe("true");
  });

  it("stays collapsed to a line while the card below is asking it", () => {
    const { container, queryByText } = render(() => <QuestionRowView row={row({ pending: true })} />);
    expect(container.querySelectorAll(".tl-option-desc").length).toBe(0);
    expect(queryByText(/show all/i)).toBeNull();
  });
});
