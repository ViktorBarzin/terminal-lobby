/**
 * The card renders ONE reading and sends ONE choice.
 *
 * What it used to do: hold a walk. Four questions, a local draft per question,
 * a Next between them, a review of what was about to be sent, and a Send that
 * typed the lot. The walk predicted each next screen and over 10 days of field
 * data four-question answers failed 4 times in 5, every failure the prediction
 * missing (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md).
 *
 * So there is no draft here to assert on any more. A tap is a request; the
 * reply is a fresh reading of the pane; the card draws that. These tests are
 * about the three things that survive from the old presentation — numbered
 * rows, descriptions kept on screen, an action that cannot scroll away — plus
 * the three that are new: chips you can go back through, a row that shows it
 * is in flight, and a screen we could not read shown as itself.
 *
 * The 2026-08-29 presentation review still holds and is not re-litigated here:
 * head and footer pinned with only the options scrolling, rows numbered with
 * the digit the CLI is listening for, descriptions clamped to two lines and
 * expanded on the chosen row, "Chat about this" an action rather than an
 * answer, and "Submit" rather than "Send answers" so it does not read like the
 * composer's Send a hundred pixels below it.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { QuestionCard } from "../src/components/QuestionCard";
import { FREE_TEXT_LABEL, type DialogView } from "../src/lib/answer-api";

/** dialog-single.txt, as ParseDialog reports it. */
const single: DialogView = {
  questions: [
    {
      header: "Font",
      question: "Which font should the badge use?",
      options: [
        { label: "Sans", description: "A sans-serif typeface." },
        { label: "Serif", description: "A serif typeface." },
      ],
    },
  ],
  count: 1,
};

/**
 * dialog-multi.txt: two questions, the pane drawing the first.
 *
 * The header is filled in here because a multi-question dialog does not draw
 * one — which tab is current is drawn in colour and `capture-pane -p` does not
 * carry colour — so TextView places the drawn question against the call the
 * transcript recorded and hands the card the answer. The card treats that
 * header as the identity of the question on screen and sends it with every
 * request; the server refuses anything that does not match what it can see.
 */
const multi: DialogView = {
  questions: [
    {
      header: "Fruit",
      question: "Pick fruits",
      multiSelect: true,
      options: [
        { label: "Apple", description: "Include apples." },
        { label: "Pear", description: "Include pears." },
        { label: "Plum", description: "Include plums." },
      ],
    },
  ],
  headers: ["Fruit", "Drink"],
  count: 2,
  partial: true,
  answered: 0,
};

/** dialog-multi-review.txt: both boxes filled, waiting for a Submit. */
const review: DialogView = {
  questions: [{ question: "Ready to submit your answers?", options: [] }],
  headers: ["Fruit", "Drink"],
  count: 2,
  partial: true,
  answered: 2,
};

const mount = (props: Partial<ComponentProps<typeof QuestionCard>> = {}) =>
  render(() => (
    <QuestionCard
      dialog={single}
      busy={false}
      onChoose={async () => {}}
      onBack={async () => {}}
      onSubmit={async () => {}}
      onKeys={async () => {}}
      onChat={() => {}}
      {...props}
    />
  ));

const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".tl-qcard-option"));
const labels = (c: HTMLElement) =>
  rows(c).map((r) => r.querySelector(".tl-qcard-label")?.textContent ?? "");
const chips = (c: HTMLElement) => Array.from(c.querySelectorAll(".tl-qcard-tab"));

/** A promise the test decides when to settle, so "in flight" can be observed. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((res) => {
    release = res;
  });
  return { promise, release };
}

describe("<QuestionCard> — one question, one request", () => {
  it("offers the drawn question's options and the CLI's free-text row", () => {
    const { container } = mount();
    // The parser drops the CLI's own "Type something" and "Chat about this"
    // rows (dialog.go), so the card puts the free-text one back at the number
    // the widget drew it at: 3, right after Sans and Serif.
    expect(labels(container)).toEqual(["Sans", "Serif", FREE_TEXT_LABEL]);
    const keys = rows(container).map((r) => r.querySelector(".tl-qcard-key")?.textContent);
    expect(keys).toEqual(["1", "2", "3"]);
  });

  it("sends the choice on the tap, with the header that names the question", async () => {
    const onChoose = vi.fn(async () => {});
    const { container } = mount({ onChoose });
    fireEvent.click(rows(container)[1]!);
    expect(onChoose).toHaveBeenCalledWith("Font", ["Serif"]);
  });

  it("has no Next and no draft to submit", () => {
    const { container } = mount({ dialog: multi });
    fireEvent.click(rows(container)[0]!);
    expect(container.querySelector(".tl-qcard-next"), "no walk to advance").toBeNull();
    expect(container.querySelector(".tl-qcard-send"), "nothing held back to send").toBeNull();
  });

  it("marks the tapped row in flight and lets no second tap through", () => {
    const gate = deferred();
    const onChoose = vi.fn(() => gate.promise);
    const { container } = mount({ onChoose });
    fireEvent.click(rows(container)[0]!);
    expect(rows(container)[0]!.getAttribute("aria-busy")).toBe("true");
    expect(rows(container)[1]!.getAttribute("aria-busy")).toBeNull();
    fireEvent.click(rows(container)[1]!);
    expect(onChoose).toHaveBeenCalledTimes(1);
    gate.release();
  });

  it("tells a multi-select reader that a tap answers and a revisit adds", () => {
    // A tap is one Space and the Enter that leaves the question, so a second
    // fruit still means coming back. What the hint may no longer say is that
    // the second one replaces the first: the request carries the whole
    // desired set, so the ticks already on screen survive it.
    const { container } = mount({ dialog: multi });
    const hint = container.querySelector(".tl-qcard-hint")?.textContent ?? "";
    expect(hint).toMatch(/come back/i);
    expect(hint, "the wording the wire could not deliver").not.toMatch(/one pick per tap/i);
  });

  it("keeps every description on screen, clamped", () => {
    const { container } = mount();
    const descs = container.querySelectorAll(".tl-qcard-desc");
    expect(descs.length, "one per option that has one").toBe(2);
    expect(descs[0]!.textContent).toContain("A sans-serif typeface.");
  });

  it("puts the options in their own scroller, not the whole card", () => {
    const { container } = mount();
    const card = container.querySelector(".tl-qcard")!;
    expect(card.querySelector(":scope > .tl-qcard-head")).not.toBeNull();
    expect(card.querySelector(":scope > .tl-qcard-actions")).not.toBeNull();
    expect(container.querySelector(".tl-qcard-options")!.closest(".tl-qcard-body")).not.toBeNull();
  });
});

describe("<QuestionCard> — the tab bar as chips", () => {
  it("draws one chip per header and ticks the answered ones", () => {
    const { container } = mount({
      dialog: { ...multi, headers: ["Fruit", "Drink", "Size"], count: 3, answered: 1 },
    });
    expect(chips(container).map((c) => c.textContent)).toEqual(["Fruit", "Drink", "Size"]);
    expect(chips(container).map((c) => c.getAttribute("data-done"))).toEqual(["true", null, null]);
  });

  it("goes back to an answered question when its chip is tapped", () => {
    const onBack = vi.fn(async () => {});
    const { container } = mount({
      dialog: {
        ...multi,
        questions: [{ ...multi.questions[0]!, header: "Drink", question: "Pick one drink" }],
        answered: 1,
      },
      onBack,
    });
    fireEvent.click(chips(container)[0]!);
    expect(onBack).toHaveBeenCalledWith("Fruit");
  });

  it("does nothing when the chip for the question on screen is tapped", () => {
    const onBack = vi.fn(async () => {});
    const { container } = mount({ dialog: { ...multi, answered: 0 }, onBack });
    fireEvent.click(chips(container)[0]!);
    expect(onBack).not.toHaveBeenCalled();
    expect(chips(container)[0]!.getAttribute("data-current")).toBe("true");
  });

  it("never reads the answered count as a position", () => {
    // Measured 2026-09-10 against CLI 2.1.267: a multi-select question's box
    // flips to ☒ on the FIRST Space, before the Enter that leaves it. So the
    // pane can read `☒ Fruit ☐ Drink` while it is still drawing "Pick fruits",
    // and answered-th is question 2 while the reader is on question 1. Taking
    // it as an index is how a choice for one question lands in the next.
    const { container } = mount({ dialog: { ...multi, answered: 1 } });
    const current = chips(container).map((c) => c.getAttribute("data-current"));
    expect(current, "the drawn header decides, not the tally").toEqual(["true", null]);
    // Its own chip is ticked and still not a way back: going back to where you
    // already are is not a request worth making.
    const onBack = vi.fn(async () => {});
    const { container: c2 } = mount({ dialog: { ...multi, answered: 1 }, onBack });
    fireEvent.click(chips(c2)[0]!);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("offers no way forward to a question that has not been drawn", () => {
    const onBack = vi.fn(async () => {});
    const { container } = mount({ dialog: multi, onBack });
    fireEvent.click(chips(container)[1]!);
    expect(onBack).not.toHaveBeenCalled();
  });

  /**
   * A chip is a way back only when it is BEHIND the question on screen.
   *
   * The tick and the tap used to read the same thing, the ☒ tally, so an
   * answered question AHEAD of the drawn one was an enabled button: the reader
   * who answers Fruit and Drink, taps the Fruit chip to revise, and then wants
   * Drink back sees a live Drink chip. Server-side, ← only walks backwards —
   * leftPresses refuses a header ahead of the walk (answerplan.go:320) and
   * answerBack replies AnswerNotDrawn with the same reading — and TextView
   * reports nothing, because the CALL succeeded. So the tap did nothing at
   * all, with nothing on screen to say why.
   */
  it("offers no way back to a question the pane has already moved past", () => {
    const onBack = vi.fn(async () => {});
    const { container } = mount({
      dialog: { ...multi, headers: ["Fruit", "Drink", "Size"], count: 3, answered: 2 },
      onBack,
    });
    const drink = chips(container)[1] as HTMLButtonElement;
    expect(drink.getAttribute("data-done"), "the pane draws its box as ☒").toBe("true");
    expect(drink.disabled, "and ← still cannot reach it from question 1").toBe(true);
    fireEvent.click(drink);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("stays a way back once the pane is past it", () => {
    // The same three chips with the pane drawing the LAST one: everything
    // before it is behind the walk, so every one of them is ← reachable.
    const onBack = vi.fn(async () => {});
    const { container } = mount({
      dialog: {
        ...multi,
        questions: [{ ...multi.questions[0]!, header: "Size", question: "Which size?" }],
        headers: ["Fruit", "Drink", "Size"],
        count: 3,
        answered: 2,
      },
      onBack,
    });
    expect(chips(container).map((c) => (c as HTMLButtonElement).disabled)).toEqual([
      false,
      false,
      true,
    ]);
    fireEvent.click(chips(container)[1]!);
    expect(onBack).toHaveBeenCalledWith("Drink");
  });
});

describe("<QuestionCard> — the review screen", () => {
  it("lists what the review screen shows and offers Submit", () => {
    const onSubmit = vi.fn(async () => {});
    const { container } = mount({ dialog: review, review: true, onSubmit });
    expect(rows(container), "the review screen has no answers to give").toHaveLength(0);
    const listed = Array.from(container.querySelectorAll(".tl-qcard-reviewq")).map(
      (e) => e.textContent,
    );
    expect(listed).toEqual(["Fruit", "Drink"]);
    const submit = container.querySelector(".tl-qcard-send") as HTMLButtonElement;
    expect(submit.textContent!.trim()).toBe("Submit");
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("still lets a chip take you back to change an answer", () => {
    const onBack = vi.fn(async () => {});
    const { container } = mount({ dialog: review, review: true, onBack });
    fireEvent.click(chips(container)[1]!);
    expect(onBack).toHaveBeenCalledWith("Drink");
  });
});

describe("<QuestionCard> — the free-text row", () => {
  it("opens a field instead of sending", () => {
    const onChoose = vi.fn(async () => {});
    const { container } = mount({ onChoose });
    fireEvent.click(rows(container)[2]!);
    expect(onChoose, "nothing to send until something is typed").not.toHaveBeenCalled();
    expect(container.querySelector(".tl-qcard-other")).not.toBeNull();
  });

  it("sends the typed text with the free-text label", () => {
    const onChoose = vi.fn(async () => {});
    const { container } = mount({ onChoose });
    fireEvent.click(rows(container)[2]!);
    const field = container.querySelector(".tl-qcard-other") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "Berkeley Mono" } });
    fireEvent.click(container.querySelector(".tl-qcard-send")!);
    expect(onChoose).toHaveBeenCalledWith("Font", [FREE_TEXT_LABEL], "Berkeley Mono");
  });

  it("will not send an empty field", () => {
    const onChoose = vi.fn(async () => {});
    const { container } = mount({ onChoose });
    fireEvent.click(rows(container)[2]!);
    const send = container.querySelector(".tl-qcard-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(onChoose).not.toHaveBeenCalled();
  });
});

describe("<QuestionCard> — a screen we could not read", () => {
  it("shows the pane and its rows rather than sending the reader away", () => {
    const onKeys = vi.fn(async () => {});
    const pane = ["  1. Yes", "  2. No", "", "Enter to select · Esc to cancel"].join("\n");
    const { container } = mount({ dialog: null, pane, onKeys });
    expect(container.querySelector("pre")!.textContent).toContain("1. Yes");
    fireEvent.click(rows(container)[1]!);
    expect(onKeys).toHaveBeenCalledWith(["2"]);
  });

  it("draws nothing when there is neither a reading nor a capture", () => {
    const { container } = mount({ dialog: null });
    expect(container.querySelector(".tl-qcard")).toBeNull();
  });
});

describe("<QuestionCard> — the actions", () => {
  it("keeps the chat escape out of the answers and offers it as an action", () => {
    const onChat = vi.fn();
    const { container } = mount({ onChat });
    expect(labels(container).join(" ")).not.toMatch(/chat about/i);
    const chat = container.querySelector(".tl-qcard-chat") as HTMLButtonElement;
    fireEvent.click(chat);
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it("keeps a way through to the Terminal without ever asking for one", () => {
    const onTerminal = vi.fn();
    const { container } = mount({ onTerminal });
    const btn = container.querySelector(".tl-qcard-back") as HTMLButtonElement;
    expect(btn.textContent).toMatch(/terminal/i);
    fireEvent.click(btn);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    // The button is an offer. Nothing on the card says the answer has to be
    // finished somewhere else, which is what the removed stopped state said.
    expect(container.textContent).not.toMatch(/finish it in the terminal/i);
  });
});

/**
 * The same question must not appear twice.
 *
 * The docked card and the timeline's inline row are built from independent
 * sources — the card from the pane reading, the row from `deriveRows` — and
 * nothing coordinated them. Once the transcript caught up while the question
 * was still pending, the reader got the whole question rendered twice, a
 * card's height apart. It is easy to miss because the transcript lands seconds
 * after the pane does, so a screenshot taken early shows only one.
 *
 * The row is the RECORD, so while there is no answer yet it says only that
 * much: chip, question, and where the answer is being given. It becomes the
 * full record the moment the answer lands.
 */
import { QuestionRowView } from "../src/components/rows";
import type { QuestionRow } from "../src/components/timeline.logic";

const row = (over: Partial<QuestionRow> = {}): QuestionRow =>
  ({
    kind: "question",
    id: "e1",
    toolId: "t1",
    questions: [
      {
        header: "Push path",
        question: "Which mechanism delivers the package?",
        multiSelect: false,
        options: [
          { label: "Woodpecker", description: "" },
          { label: "Tailnet", description: "" },
        ],
      },
    ],
    answers: [],
    pending: false,
    ...over,
  }) as QuestionRow;

describe("the transcript's question row", () => {
  it("shows the options once the answer is recorded", () => {
    const { container } = render(() => <QuestionRowView row={row({ answers: ["Woodpecker"] })} />);
    expect(container.querySelectorAll(".tl-question-option").length).toBe(2);
    expect(container.querySelector(".tl-question-answering")).toBeNull();
  });

  it("collapses to a line while the card below is still asking it", () => {
    const { container } = render(() => <QuestionRowView row={row({ pending: true })} />);
    expect(container.querySelectorAll(".tl-question-option").length).toBe(0);
    // Not the question either — the card below is showing it, larger, a hundred
    // pixels away. This row marks the place until there is a record to hold.
    expect(container.textContent).not.toContain("Which mechanism delivers the package?");
    expect(container.textContent).toContain("Push path");
    expect(container.querySelector(".tl-question-answering")).not.toBeNull();
  });
});
