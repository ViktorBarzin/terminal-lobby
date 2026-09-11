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
 *
 * The card takes a READING now rather than a call's question list, and a tap
 * on a row is a request rather than a draft — so "expanded only the chosen
 * row" has become "expanded only the row whose request is in flight", and the
 * toggle is the only way to read all of them at rest. That makes this control
 * matter more than it did, not less
 * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { QuestionCard } from "../src/components/QuestionCard";
import { QuestionRowView } from "../src/components/rows";
import type { DialogView } from "../src/lib/answer-api";
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

/** The same question as the pane draws it back to the card. */
const reading = (q: Question): DialogView => ({ questions: [q], count: 1 });

const card = (dialog: DialogView) =>
  render(() => (
    <QuestionCard
      dialog={dialog}
      busy={false}
      onChoose={async () => {}}
      onBack={async () => {}}
      onSubmit={async () => {}}
      onKeys={async () => {}}
      onChat={() => {}}
    />
  ));

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
    const { container } = card(reading(questions[0]!));
    expect(container.querySelector(".tl-qcard-options")!.getAttribute("data-full")).toBeNull();
  });

  it("unclamps all of them on one press, and says how to go back", () => {
    const { container, getByText } = card(reading(questions[0]!));
    fireEvent.click(getByText(/show all/i));
    expect(container.querySelector(".tl-qcard-options")!.getAttribute("data-full")).toBe("true");
    fireEvent.click(getByText(/show less/i));
    expect(container.querySelector(".tl-qcard-options")!.getAttribute("data-full")).toBeNull();
  });

  it("offers the toggle only when something is actually clamped", () => {
    const short = { ...questions[0]!, options: [{ label: "Yes", description: "" }] };
    const { queryByText } = card(reading(short));
    expect(queryByText(/show all/i)).toBeNull();
  });

  it("offers no toggle on the review screen, which has no descriptions", () => {
    // The review screen's reading carries no options at all, so the head would
    // otherwise show a control that expands nothing.
    const { queryByText } = render(() => (
      <QuestionCard
        dialog={{
          questions: [{ question: "Ready to submit your answers?", options: [] }],
          headers: ["Push path", "Lane"],
          count: 2,
          answered: 2,
        }}
        review
        busy={false}
        onChoose={async () => {}}
        onBack={async () => {}}
        onSubmit={async () => {}}
        onKeys={async () => {}}
        onChat={() => {}}
      />
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
