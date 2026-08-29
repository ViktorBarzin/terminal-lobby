/**
 * The card's presentation, after the 2026-08-29 review (three reviewers, one
 * proposal each; Viktor picked the two open calls).
 *
 * What changed and why:
 *  - The action was BELOW THE FOLD on both a phone and a 1280x900 desktop,
 *    because the whole card was one scroll box. Head and footer are pinned now
 *    and only the options scroll.
 *  - Rows are NUMBERED with the digit we are about to inject. The CLI answers by
 *    digit, the transcript's recorded row already numbers its options, and the
 *    card was the only surface of the three that numbered nothing — hiding the
 *    one thing it was about to type.
 *  - Descriptions are CLAMPED to two lines and the chosen row expands. The
 *    labels alone do not let you choose: on a real call, "postinst verifies;
 *    failure auto-reverts and holds" against "Alert only, fix forward" is a
 *    decision that lives entirely in the descriptions. Hiding them until a tap
 *    would make comparing serial.
 *  - "Chat about this" is an ACTION, not an answer — see answer.logic.
 *  - A single question SUBMITS, with no Review step. The CLI submits that shape
 *    immediately, and `submitsImmediately` already said so.
 *  - "Send answers" is now "Submit": the composer's own Send sits about 100px
 *    below it and does the opposite thing (it dismisses the question and Claude
 *    asks again), so the two must not read alike.
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { QuestionCard } from "../src/components/QuestionCard";
import type { Question } from "../src/components/canonicalize";

const one: Question[] = [
  {
    header: "Push path",
    question: "Which mechanism delivers the package?",
    multiSelect: false,
    options: [
      { label: "Woodpecker", description: "A runner asks it to deploy." },
      { label: "Tailnet", description: "One hop, no broker." },
    ],
  },
];

const two: Question[] = [
  one[0]!,
  {
    header: "Rollback",
    question: "Where should the rollback live?",
    multiSelect: false,
    options: [
      { label: "In the postinst", description: "" },
      { label: "In CI", description: "" },
    ],
  },
];

const mount = (props: Record<string, unknown> = {}) =>
  render(() => (
    <QuestionCard
      questions={one}
      onSend={async () => {}}
      onChat={() => {}}
      {...(props as never)}
    />
  ));

const rows = (c: HTMLElement) => Array.from(c.querySelectorAll(".tl-qcard-option"));

describe("<QuestionCard> — numbered answers", () => {
  it("numbers every answer with the dialog's own digit", () => {
    const { container } = mount();
    const keys = rows(container).map((r) => r.querySelector(".tl-qcard-key")?.textContent);
    // Two options, then "Type something" as 3 — the CLI's numbering exactly.
    expect(keys).toEqual(["1", "2", "3"]);
  });

  it("keeps the chat escape out of the answers and offers it as an action", () => {
    const onChat = vi.fn();
    const { container } = mount({ onChat });
    expect(rows(container).map((r) => r.textContent).join(" ")).not.toMatch(/chat about/i);
    const chat = container.querySelector(".tl-qcard-chat") as HTMLButtonElement;
    expect(chat, "a chat action in the footer").not.toBeNull();
    fireEvent.click(chat);
    expect(onChat).toHaveBeenCalledTimes(1);
  });
});

describe("<QuestionCard> — one question submits", () => {
  it("offers Submit and no Review step", () => {
    const { container } = mount();
    fireEvent.click(rows(container)[0]!);
    expect(container.querySelector(".tl-qcard-next"), "no Review button").toBeNull();
    const send = container.querySelector(".tl-qcard-send")!;
    expect(send.textContent!.trim()).toBe("Submit");
  });

  it("sends the answer straight from the one screen", async () => {
    const onSend = vi.fn(async () => {});
    const { container } = mount({ onSend });
    fireEvent.click(rows(container)[0]!);
    fireEvent.click(container.querySelector(".tl-qcard-send")!);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]![0]).toEqual([{ chosen: ["Woodpecker"] }]);
  });

  it("still walks when there is more than one question", () => {
    const { container } = mount({ questions: two });
    fireEvent.click(rows(container)[0]!);
    expect(container.querySelector(".tl-qcard-next"), "a walk for 2+").not.toBeNull();
  });
});

describe("<QuestionCard> — descriptions", () => {
  it("shows every description, clamped, so options can be compared", () => {
    const { container } = mount();
    const descs = container.querySelectorAll(".tl-qcard-desc");
    expect(descs.length, "one per option that has one").toBe(2);
    expect(descs[0]!.textContent).toContain("A runner asks it to deploy.");
  });

  it("marks the chosen row so its description can expand", () => {
    const { container } = mount();
    fireEvent.click(rows(container)[0]!);
    expect(rows(container)[0]!.getAttribute("data-chosen")).toBe("true");
    expect(rows(container)[1]!.getAttribute("data-chosen")).toBeNull();
  });
});

describe("<QuestionCard> — the action cannot scroll away", () => {
  it("puts the options in their own scroller, not the whole card", () => {
    const { container } = mount();
    const card = container.querySelector(".tl-qcard")!;
    const opts = container.querySelector(".tl-qcard-options")!;
    // Asserted structurally: the head and the footer are siblings of the
    // scrolling middle, so neither can be scrolled out of the card.
    expect(card.querySelector(":scope > .tl-qcard-head")).not.toBeNull();
    expect(card.querySelector(":scope > .tl-qcard-actions")).not.toBeNull();
    expect(opts.closest(".tl-qcard-body")).not.toBeNull();
  });
});

/**
 * The same question must not appear twice.
 *
 * The docked card and the timeline's inline row are built from independent
 * sources — the card from `asking()` (the pane, or the transcript), the row from
 * `deriveRows` — and nothing coordinated them. Once the transcript caught up
 * while the question was still pending, the reader got the whole question
 * rendered twice, a card's height apart. It is easy to miss because the
 * transcript lands seconds after the pane does, so a screenshot taken early
 * shows only one.
 *
 * The row is the RECORD, so while there is no answer yet it says only that much:
 * chip, question, and where the answer is being given. It becomes the full
 * record the moment the answer lands.
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
    const { container } = render(() => (
      <QuestionRowView row={row({ answers: ["Woodpecker"] })} />
    ));
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
