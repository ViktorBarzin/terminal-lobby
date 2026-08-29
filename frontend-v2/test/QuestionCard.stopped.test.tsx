/**
 * A send that stopped partway must not offer to do it again.
 *
 * runAnswer walks the dialog in verified chunks and STOPS the moment the pane
 * does not show what it expected — deliberately, because "typing the rest of the
 * answers into whatever screen is actually there is how a wrong answer gets
 * submitted without anyone seeing it happen" (answer.logic.ts). What it leaves
 * behind is a HALF-ANSWERED dialog: question 1 answered, the pane now on
 * question 2.
 *
 * The card did not know that. It cleared `busy`, toasted "finish it in
 * Terminal", and left Send enabled on the review step — and Send replays
 * planAnswer FROM STEP 0. Worse, runAnswer sends each step's keys BEFORE
 * checking the pane, so the replay types question 1's answer into question 2 and
 * only then notices the desync. The verification protects a sequence in flight;
 * it cannot protect a sequence started again from the top.
 *
 * So a stopped send latches: the walk is over, and the only way on is the
 * Terminal, where the reader can see what actually happened.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { QuestionCard } from "../src/components/QuestionCard";
import type { Question } from "../src/components/canonicalize";

const oneQuestion: Question[] = [
  {
    header: "Colour",
    question: "Which colour should the badge be?",
    multiSelect: false,
    options: [
      { label: "Blue", description: "" },
      { label: "Green", description: "" },
    ],
  },
];

/** Choose the first option and walk to wherever Send lives. */
function answerAndReachSend(container: HTMLElement) {
  fireEvent.click(container.querySelectorAll(".tl-qcard-option")[0]!);
  const next = container.querySelector(".tl-qcard-next");
  if (next) fireEvent.click(next);
}

describe("<QuestionCard> — a send that stopped partway", () => {
  it("does not offer Send again after a failed send", async () => {
    const onSend = vi.fn(async () => {});
    const { container } = render(() => (
      <QuestionCard questions={oneQuestion} onSend={onSend} onChat={() => {}} stopped />
    ));
    answerAndReachSend(container);
    expect(container.querySelector(".tl-qcard-send"), "Send is gone").toBeNull();
  });

  it("says the dialog was left half-answered, and where to finish it", () => {
    const { container } = render(() => (
      <QuestionCard
        questions={oneQuestion}
        onSend={async () => {}}
        onChat={() => {}}
        onTerminal={() => {}}
        stopped
      />
    ));
    const text = container.textContent ?? "";
    expect(text).toMatch(/terminal/i);
    expect(container.querySelector(".tl-qcard-send, .tl-qcard-terminal")).not.toBeNull();
  });

  it("hands over to the Terminal when asked", () => {
    const onTerminal = vi.fn();
    const { container } = render(() => (
      <QuestionCard
        questions={oneQuestion}
        onSend={async () => {}}
        onChat={() => {}}
        onTerminal={onTerminal}
        stopped
      />
    ));
    const btn = container.querySelector(".tl-qcard-terminal") as HTMLButtonElement;
    expect(btn, "a way through to the Terminal").not.toBeNull();
    fireEvent.click(btn);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("still offers Send normally when nothing has failed", () => {
    const { container } = render(() => (
      <QuestionCard questions={oneQuestion} onSend={async () => {}} onChat={() => {}} />
    ));
    answerAndReachSend(container);
    expect(container.querySelector(".tl-qcard-send")).not.toBeNull();
  });
});
