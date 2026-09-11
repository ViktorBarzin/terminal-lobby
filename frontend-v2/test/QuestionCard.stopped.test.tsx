/**
 * The card has no stopped state any more. These are the tests that keep it
 * gone.
 *
 * WHAT USED TO HAPPEN. The browser planned the whole walk, typed each step's
 * keys and then checked the pane. When a check missed, some answers were in,
 * the dialog sat half-answered, and pressing Send again replayed the plan from
 * step 0 — question 1's answer into whatever question the dialog had moved on
 * to. There was no way to make a second press safe, so the card latched: Send
 * disappeared, and the copy said to finish it in the Terminal.
 *
 * WHY IT CAN GO. Nothing is planned now. A tap sends one choice, naming the
 * question by its header, and the server refuses anything that is not the
 * question the pane is drawing — with the current reading attached. So the
 * worst outcome of a stale card is one wasted round trip and a re-render,
 * which needs no latch and no warning. Over 10 days of field data every one of
 * the six failures was this desync, and four of them stopped at the first step
 * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
 *
 * The file keeps its name because this is where that regression lives.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal, type Component } from "solid-js";
import { QuestionCard } from "../src/components/QuestionCard";
import type { DialogView } from "../src/lib/answer-api";

const colour: DialogView = {
  questions: [
    {
      header: "Colour",
      question: "Which colour should the badge be?",
      options: [
        { label: "Blue", description: "" },
        { label: "Green", description: "" },
      ],
    },
  ],
  count: 1,
};

const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".tl-qcard-option"));

/** Let every queued microtask run, so a settled request has cleared its mark. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A card whose only moving part is the request, so a failed one is visible. */
const mount = (onChoose: (h: string, c: string[], t?: string) => Promise<void>) =>
  render(() => (
    <QuestionCard
      dialog={colour}
      busy={false}
      onChoose={onChoose}
      onBack={async () => {}}
      onSubmit={async () => {}}
      onKeys={async () => {}}
      onChat={() => {}}
      onTerminal={() => {}}
    />
  ));

describe("<QuestionCard> — a request that did not land", () => {
  it("is tappable again the moment the request settles", async () => {
    // A refusal is a normal reply carrying a fresh reading, so the only thing
    // to undo is the in-flight mark on the row.
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose);
    fireEvent.click(rows(container)[0]!);
    await settle();
    expect(rows(container)[0]!.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(rows(container)[1]!);
    expect(onChoose).toHaveBeenCalledTimes(2);
    expect(onChoose.mock.calls[1]).toEqual(["Colour", ["Green"]]);
  });

  it("does not spin for ever when the request throws", async () => {
    const onChoose = vi.fn(async () => {
      throw new Error("the pane could not be read");
    });
    const { container } = mount(onChoose);
    fireEvent.click(rows(container)[0]!);
    await settle();
    expect(rows(container)[0]!.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(rows(container)[0]!);
    expect(onChoose).toHaveBeenCalledTimes(2);
  });

  it("never tells the reader to finish the answer somewhere else", () => {
    const { container } = mount(async () => {});
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/finish it in the terminal/i);
    expect(text).not.toMatch(/answer the wrong question/i);
    expect(text).not.toMatch(/half/i);
    expect(container.querySelector(".tl-qcard-stopped")).toBeNull();
  });
});

/**
 * The card is a function of the reading it is handed.
 *
 * The old one held a walk, so a new reading arriving mid-walk was a problem to
 * be survived — TextView keyed the card on the CONTENT of every question in
 * the call so a half-finished walk would carry through the pane-to-transcript
 * handover, and a multi-question call produced different keys from its two
 * sources and rebuilt the card. There is no walk to carry now, so a new
 * reading is simply the next thing to draw.
 */
const Harness: Component<{
  first: DialogView;
  second: DialogView;
  /** The second reading is the CLI's review screen. */
  secondReview?: boolean;
  onChoose?: (h: string, c: string[], t?: string) => Promise<void>;
}> = (props) => {
  const [at, setAt] = createSignal(0);
  return (
    <>
      <button type="button" data-testid="advance" onClick={() => setAt(1)}>
        next reading
      </button>
      <QuestionCard
        dialog={at() === 0 ? props.first : props.second}
        review={at() === 1 && props.secondReview === true}
        busy={false}
        onChoose={props.onChoose ?? (async () => {})}
        onBack={async () => {}}
        onSubmit={async () => {}}
        onKeys={async () => {}}
        onChat={() => {}}
      />
    </>
  );
};

const shape: DialogView = {
  questions: [
    {
      header: "Shape",
      question: "Which shape should the badge be?",
      options: [
        { label: "Circle", description: "" },
        { label: "Square", description: "" },
      ],
    },
  ],
  count: 1,
};

/** dialog-multi-review.txt: every box filled, waiting for a Submit. */
const review: DialogView = {
  questions: [{ question: "Ready to submit your answers?", options: [] }],
  headers: ["Colour", "Shape"],
  count: 2,
  answered: 2,
};

const field = (c: HTMLElement) => c.querySelector<HTMLInputElement>(".tl-qcard-other");
const send = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-qcard-send");

describe("<QuestionCard> — a new reading replaces the old one", () => {
  it("draws whatever came back, with nothing carried over", () => {
    const { container, getByTestId } = render(() => <Harness first={colour} second={shape} />);
    expect(container.querySelector(".tl-qcard-question")!.textContent).toContain("colour");
    fireEvent.click(getByTestId("advance"));
    expect(container.querySelector(".tl-qcard-question")!.textContent).toContain("shape");
    expect(rows(container).map((r) => r.querySelector(".tl-qcard-label")?.textContent)).toEqual([
      "Circle",
      "Square",
      "Type something",
    ]);
  });

  /**
   * The half-typed free-text answer is the one piece of state the card holds,
   * and it belonged to the card rather than to the question until 2026-09-11.
   *
   * Reproduced against the real component: tap "Type something" on question 1,
   * type a word, answer it, and the reply's reading of question 2 arrived into
   * a card still showing the open field, the word, and a live Answer button.
   * One tap on it sent onChoose("<question 2>", "Type something", "<question
   * 1's word>") — an answer nobody picked, committed under a header it was
   * never typed for, which is exactly what the design set out to remove.
   */
  it("does not carry a half-typed answer into the next question", () => {
    const onChoose = vi.fn(async (_h: string, _c: string[], _t?: string) => {});
    const { container, getByTestId } = render(() => (
      <Harness first={colour} second={shape} onChoose={onChoose} />
    ));
    fireEvent.click(rows(container)[2]!);
    fireEvent.input(field(container)!, { target: { value: "Mango" } });
    expect(send(container), "the field is open and answerable here").not.toBeNull();

    fireEvent.click(getByTestId("advance"));

    expect(field(container), "no field belonging to the question just left").toBeNull();
    expect(send(container), "and nothing to commit its words with").toBeNull();
    expect(rows(container)[2]!.getAttribute("data-chosen")).toBeNull();

    // Opening the new question's own free-text row starts it empty, rather
    // than handing the reader the last question's word to send by accident.
    fireEvent.click(rows(container)[2]!);
    expect(field(container)!.value).toBe("");
    expect(send(container)!.disabled, "an empty field is not an answer").toBe(true);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("puts no Answer beside Submit when the reading is the review screen", () => {
    // Same leak, landing on the screen where the only action is Submit: the
    // free-text Show was gated on typing() alone and sat outside the review
    // guard, so a field opened on the last question survived into the review
    // as a second button that answered nothing.
    const { container, getByTestId } = render(() => (
      <Harness first={colour} second={review} secondReview />
    ));
    fireEvent.click(rows(container)[2]!);
    fireEvent.input(field(container)!, { target: { value: "Teal" } });

    fireEvent.click(getByTestId("advance"));

    expect(field(container)).toBeNull();
    const actions = Array.from(container.querySelectorAll(".tl-qcard-send")).map((b) =>
      b.textContent?.trim(),
    );
    expect(actions, "Submit, and nothing wearing its screen's header").toEqual(["Submit"]);
  });
});
