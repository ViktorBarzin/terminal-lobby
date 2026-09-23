/**
 * A multi-select row, and the decoration that once swallowed the whole view.
 *
 * WHAT THIS FILE USED TO PIN. The card collected a local draft, so a
 * multi-select had to hold several picks at once and toggle them off again.
 * Found 2026-08-29 by a 16-agent scenario sweep, in 7 of 14 scenarios: picking
 * ONE option in a multi-select made the whole text view unclickable. Every
 * following tap — another option, Review, Show all, Type a message instead,
 * even the composer — was delivered to the chip just chosen and un-picked it.
 * So a multi-select could hold exactly one answer and could never be advanced.
 *
 * The cause was a rule added the day before, meaning to give the chip a
 * checkbox look and giving it no look at all:
 *
 *   .tl-qcard-option[data-multi][data-chosen] .tl-qcard-key::after {
 *     content: ""; position: absolute; inset: 0;
 *   }
 *
 * Nothing between that pseudo-element and `.tl-textview` is positioned, and
 * `.tl-textview` is `position: relative` (it anchors the pinch size pill), so
 * `inset: 0` resolved against the WHOLE VIEW. It painted nothing and caught
 * every click.
 *
 * The lesson, and why this test names it: an absolutely-positioned pseudo
 * element is only as small as its nearest positioned ancestor. If a decoration
 * has no positioned parent it is not a decoration, it is a page-sized button.
 *
 * WHAT IT PINS NOW. A click on a multi-select row TOGGLES that row and stays on
 * the question. Leaving the question is a separate button at the right end of
 * the actions row, labelled with the pane's own commit row: "Next", or
 * "Submit" on the last question.
 *
 * From 2026-09-11 to 2026-09-23 a click was a whole answer. It carried the set
 * the question should end up holding, and the server then walked to the CLI's
 * unnumbered commit row and pressed Enter, so the first click committed the
 * question and a one-question call went straight to the review screen.
 * Viktor's report: "multi answer questions now move on to the next step on the
 * first selection and the user can't select more than one answer."
 *
 * Each toggle is still one request, and the ticks are still the ones the pane
 * draws, so the card holds no model of the dialog. What it does hold is the
 * ORDER of clicks made faster than the pane answers: each waits for the reply
 * before it and is worked out against that reply's reading when it goes. The
 * CSS guard at the bottom is unchanged, because a page-sized pseudo-element
 * would break this card exactly as it broke the old one.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { QuestionCard } from "../src/components/QuestionCard";
import { FREE_TEXT_LABEL, type DialogQuestionView, type DialogView } from "../src/lib/answer-api";

/** dialog-multi.txt's first question, as ParseDialog reports it. */
const multi: DialogView = {
  questions: [
    {
      header: "Fruit",
      question: "Which do you want?",
      multiSelect: true,
      options: [
        { label: "Apple", description: "" },
        { label: "Pear", description: "" },
        { label: "Plum", description: "" },
      ],
    },
  ],
  headers: ["Fruit", "Drink"],
  count: 2,
  answered: 0,
};

/** The same question with `ticked` filled, as the pane draws it after Space. */
const holding = (...ticked: string[]): DialogView => ({
  ...multi,
  questions: [
    {
      ...multi.questions[0]!,
      options: multi.questions[0]!.options.map((o) => ({
        ...o,
        checked: ticked.includes(o.label),
      })),
    },
  ],
  answered: ticked.length > 0 ? 1 : 0,
});

/** `view` with more of its question read off the pane: the free-text row, the commit row. */
const drawnWith = (view: DialogView, more: Partial<DialogQuestionView>): DialogView => ({
  ...view,
  questions: [{ ...view.questions[0]!, ...more }],
});

/** Question 2 of the same call, which is what a commit on question 1 lands on. */
const drink: DialogView = {
  questions: [
    {
      header: "Drink",
      question: "Pick one drink",
      options: [
        { label: "Tea", description: "" },
        { label: "Coffee", description: "" },
      ],
    },
  ],
  headers: ["Fruit", "Drink"],
  count: 2,
  answered: 1,
};

const rows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>(".tl-qcard-option"));
const row = (c: HTMLElement, label: string) =>
  rows(c).find((r) => r.querySelector(".tl-qcard-label")?.textContent === label)!;
const commitButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".tl-qcard-next");
const field = (c: HTMLElement) => c.querySelector<HTMLInputElement>(".tl-qcard-other");
/** The field's own action, found by what it says rather than by where it sits. */
const fieldAction = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    /^(Add|Update)$/.test(b.textContent?.trim() ?? ""),
  );
/** The row's digit carries the app's "work is happening" pulse. */
const pulsing = (r: HTMLElement) =>
  (r.querySelector<HTMLElement>(".tl-qcard-key")?.style.animation ?? "").includes("tl-pulse");

/** Let every queued microtask run, so a settled request has cleared its mark. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * The card as TextView drives it.
 *
 * `busy` is up while a request is in flight, and a reply lands in the order
 * TextView's `put` lands it: `busy` drops, the card is handed the reading the
 * reply carried, and only then does the request's promise settle. The order is
 * what makes "worked out against the previous reply" testable here.
 */
function mount(first: DialogView = multi) {
  const [dialog, setDialog] = createSignal(first);
  const [busy, setBusy] = createSignal(false);
  const replies: Array<() => void> = [];
  const request = () => {
    setBusy(true);
    return new Promise<void>((res) => replies.push(res));
  };
  const onToggle = vi.fn((_h: string, _c: string[], _t?: string) => request());
  const onChoose = vi.fn((_h: string, _c: string[], _t?: string) => request());
  const r = render(() => (
    <QuestionCard
      dialog={dialog()}
      busy={busy()}
      onChoose={onChoose}
      onToggle={onToggle}
      onBack={async () => {}}
      onSubmit={async () => {}}
      onKeys={async () => {}}
      onChat={() => {}}
    />
  ));
  /** Land the oldest request in flight, carrying `reading`. */
  const land = async (reading: DialogView) => {
    setBusy(false);
    setDialog(reading);
    replies.shift()?.();
    await settle();
  };
  return { ...r, onToggle, onChoose, land, inFlight: () => replies.length };
}

describe("a click on a multi-select row toggles that row and stays", () => {
  it("sends the set the question should hold, as a toggle and never as an answer", () => {
    const v = mount();
    fireEvent.click(row(v.container, "Pear"));
    expect(v.onToggle).toHaveBeenCalledTimes(1);
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", ["Pear"], undefined]);
    expect(v.onChoose, "a click must not commit the question").not.toHaveBeenCalled();
  });

  it("draws no tick until the pane shows one, and pulses the row until then", async () => {
    const v = mount();
    fireEvent.click(row(v.container, "Apple"));
    const apple = () => row(v.container, "Apple");
    expect(
      apple().dataset.chosen,
      "the card does not guess what the pane will draw",
    ).toBeUndefined();
    expect(apple().getAttribute("aria-busy")).toBe("true");
    expect(pulsing(apple())).toBe(true);

    await v.land(holding("Apple"));
    expect(apple().dataset.chosen).toBe("true");
    expect(apple().getAttribute("aria-pressed")).toBe("true");
    expect(apple().getAttribute("aria-busy")).toBeNull();
    expect(pulsing(apple())).toBe(false);
  });

  it("keeps the clicked row, and the keyboard focus on it, across the reply", async () => {
    // Every reply brings new option objects. Rows keyed on the object were
    // rebuilt on each one, which a toggle makes routine: a reader ticking
    // three answers from the keyboard lost focus after every one.
    const v = mount();
    const apple = row(v.container, "Apple");
    apple.focus();
    fireEvent.click(apple);
    await v.land(holding("Apple"));
    expect(row(v.container, "Apple"), "the same button, updated in place").toBe(apple);
    expect(document.activeElement).toBe(apple);
  });

  it("adds to what the reading says the question already holds", () => {
    // The request is still the desired final state, so the server's diff
    // toggles only the row that was clicked. Measured 2026-09-11 with Apple
    // ticked and the cursor on its row: naming Pear alone planned a Space on
    // Apple as well, and the reader's first fruit went.
    const v = mount(holding("Apple"));
    fireEvent.click(row(v.container, "Pear"));
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", ["Apple", "Pear"], undefined]);
  });

  it("takes a ticked row back out", () => {
    const v = mount(holding("Apple", "Pear"));
    fireEvent.click(row(v.container, "Apple"));
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", ["Pear"], undefined]);
  });

  it("unticks the last pick like any checkbox", () => {
    // Until 2026-09-23 the last pick re-confirmed itself, because a click was
    // also the Enter that left the question and an empty question could not
    // be left. A toggle leaves nothing, so the only honest meaning of clicking
    // your one tick is taking it away.
    const v = mount(holding("Apple"));
    fireEvent.click(row(v.container, "Apple"));
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", [], undefined]);
  });

  it("keeps the free-text pick when another row is toggled", () => {
    // The request is the whole desired state, the free-text row included, and
    // a set without it asks the server to clear the words out of it.
    const v = mount(drawnWith(holding(), { typed: "Mango", typedChecked: true }));
    fireEvent.click(row(v.container, "Apple"));
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", ["Apple", FREE_TEXT_LABEL], "Mango"]);
  });

  it("leaves a single-select question answering on one click", () => {
    // A single-select list draws no boxes, so the click is the answer, and
    // TextView spells it as `choice` on the wire exactly as before.
    const v = mount({ ...multi, questions: [{ ...multi.questions[0]!, multiSelect: false }] });
    fireEvent.click(row(v.container, "Plum"));
    expect(v.onChoose.mock.calls[0]).toEqual(["Fruit", ["Plum"]]);
    expect(v.onToggle).not.toHaveBeenCalled();
    expect(row(v.container, "Plum").dataset.multi).toBeUndefined();
    expect(
      commitButton(v.container),
      "one click answers, so there is nothing to commit",
    ).toBeNull();
  });
});

describe("clicks made while a toggle is in flight queue", () => {
  it("sends two quick clicks in order, the second worked out against the first reply", async () => {
    const v = mount();
    fireEvent.click(row(v.container, "Apple"));
    fireEvent.click(row(v.container, "Pear"));
    // TextView drops a request while one is in flight, so the second waits.
    expect(v.onToggle).toHaveBeenCalledTimes(1);
    const pear = () => row(v.container, "Pear");
    expect(pear().dataset.chosen, "queued is not ticked").toBeUndefined();
    expect(pear().getAttribute("aria-busy")).toBe("true");
    expect(pulsing(pear())).toBe(true);

    await v.land(holding("Apple"));
    expect(v.onToggle).toHaveBeenCalledTimes(2);
    expect(v.onToggle.mock.calls[1]).toEqual(["Fruit", ["Apple", "Pear"], undefined]);

    await v.land(holding("Apple", "Pear"));
    expect(v.onToggle).toHaveBeenCalledTimes(2);
    expect(pear().dataset.chosen).toBe("true");
    expect(pulsing(pear())).toBe(false);
  });

  it("keeps the rows clickable while a toggle is in flight", () => {
    const v = mount();
    fireEvent.click(row(v.container, "Apple"));
    expect(rows(v.container).every((r) => !r.disabled)).toBe(true);
  });

  it("loses no click: three in a row each go out after the one before", async () => {
    const v = mount();
    fireEvent.click(row(v.container, "Apple"));
    fireEvent.click(row(v.container, "Pear"));
    fireEvent.click(row(v.container, "Plum"));
    await v.land(holding("Apple"));
    await v.land(holding("Apple", "Pear"));
    expect(v.onToggle.mock.calls.map((c) => c[1])).toEqual([
      ["Apple"],
      ["Apple", "Pear"],
      ["Apple", "Pear", "Plum"],
    ]);
  });

  it("drops a queued click when the reply shows a different question", async () => {
    // Whatever moved the pane, the click was made for question 1 and cannot be
    // spent on question 2, which may offer a row with the same name.
    const v = mount();
    fireEvent.click(row(v.container, "Apple"));
    fireEvent.click(row(v.container, "Pear"));
    await v.land(drink);
    await settle();
    expect(v.onToggle).toHaveBeenCalledTimes(1);
    expect(v.inFlight(), "nothing was sent for the question that went").toBe(0);
  });
});

describe("the commit button", () => {
  it("is labelled with the pane's own commit row", () => {
    const v = mount(drawnWith(holding("Apple"), { commit: "Submit" }));
    expect(commitButton(v.container)!.textContent!.trim()).toBe("Submit");
  });

  it("says Next when the pane drew no commit row to read", () => {
    const v = mount(holding("Apple"));
    expect(commitButton(v.container)!.textContent!.trim()).toBe("Next");
  });

  it("says Submit on the call's last question when the pane drew no commit row to read", () => {
    // Once the call's record lands, TextView draws the transcript's question,
    // which records no commit row, until the first reply brings a reading.
    // The CLI labels the last question's commit row "Submit" (2.1.280), and a
    // one-question call's only question is its last. That is the call Viktor
    // reported from, and a button reading "Next" there turned into "Submit"
    // under the reader's first click.
    const label = (view: DialogView) => commitButton(mount(view).container)!.textContent!.trim();
    expect(label({ ...multi, headers: ["Fruit"], count: 1 })).toBe("Submit");
    expect(label({ ...multi, headers: ["Drink", "Fruit"] }), "question 2 of 2").toBe("Submit");
    expect(label({ ...multi, headers: [], count: 1 }), "a call with no chips to place").toBe(
      "Submit",
    );
  });

  it("sits at the right end of the actions row, where Submit sits on the review screen", () => {
    const v = mount(holding("Apple"));
    const actions = v.container.querySelector(".tl-qcard-actions")!;
    expect(actions.lastElementChild).toBe(commitButton(v.container));
  });

  it("is disabled while nothing is ticked", () => {
    // The CLI would take a commit with nothing ticked, and the question would
    // go unanswered: Claude reads "The user did not answer the questions."
    // Measured on CLI 2.1.280.
    expect(commitButton(mount().container)!.disabled).toBe(true);
    expect(commitButton(mount(holding("Plum")).container)!.disabled).toBe(false);
    const typedOnly = drawnWith(holding(), { typed: "Mango", typedChecked: true });
    expect(commitButton(mount(typedOnly).container)!.disabled, "free text is a pick").toBe(false);
  });

  it("is disabled while a toggle is in flight or queued", async () => {
    const v = mount(holding("Apple"));
    fireEvent.click(row(v.container, "Pear"));
    expect(commitButton(v.container)!.disabled, "in flight").toBe(true);
    fireEvent.click(row(v.container, "Plum"));
    await v.land(holding("Apple", "Pear"));
    expect(commitButton(v.container)!.disabled, "Plum is now in flight").toBe(true);
    await v.land(holding("Apple", "Pear", "Plum"));
    expect(commitButton(v.container)!.disabled).toBe(false);
  });

  it("commits the set the card shows, as an answer rather than a toggle", () => {
    const v = mount(holding("Apple", "Pear"));
    fireEvent.click(commitButton(v.container)!);
    expect(v.onChoose.mock.calls[0]).toEqual(["Fruit", ["Apple", "Pear"], undefined]);
    expect(v.onToggle).not.toHaveBeenCalled();
  });

  it("commits the free-text pick with the others", () => {
    const v = mount(drawnWith(holding("Apple"), { typed: "Mango", typedChecked: true }));
    fireEvent.click(commitButton(v.container)!);
    expect(v.onChoose.mock.calls[0]).toEqual(["Fruit", ["Apple", FREE_TEXT_LABEL], "Mango"]);
  });

  it("holds the rows while the commit is in flight", () => {
    // A toggle queued behind a commit would land on whatever the commit
    // leaves on screen.
    const v = mount(holding("Apple"));
    fireEvent.click(commitButton(v.container)!);
    expect(rows(v.container).every((r) => r.disabled)).toBe(true);
    fireEvent.click(row(v.container, "Pear"));
    expect(v.onToggle).not.toHaveBeenCalled();
  });
});

describe("free text on a multi-select is one more pick", () => {
  const open = (c: HTMLElement, label = FREE_TEXT_LABEL) => fireEvent.click(row(c, label));
  const type = (c: HTMLElement, value: string) => fireEvent.input(field(c)!, { target: { value } });

  it("shows the words in the row, ticked, once the pane holds them", () => {
    const v = mount(drawnWith(holding(), { typed: "Mango", typedChecked: true }));
    const mango = row(v.container, "Mango");
    expect(mango.dataset.chosen).toBe("true");
    expect(mango.getAttribute("aria-pressed")).toBe("true");
    expect(row(v.container, FREE_TEXT_LABEL), "the row is renamed, not repeated").toBeUndefined();
  });

  it("opens the field on an empty row with nothing to add yet", () => {
    const v = mount();
    open(v.container);
    expect(field(v.container)!.value).toBe("");
    expect(fieldAction(v.container)!.textContent!.trim()).toBe("Add");
    expect(fieldAction(v.container)!.disabled).toBe(true);
    expect(v.onToggle).not.toHaveBeenCalled();
  });

  it("types the words into the CLI's row with the other ticks, and presses no Enter", () => {
    const v = mount(holding("Apple"));
    open(v.container);
    type(v.container, "Kiwi");
    fireEvent.click(fieldAction(v.container)!);
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", ["Apple", FREE_TEXT_LABEL], "Kiwi"]);
    expect(v.onChoose, "adding the words must not leave the question").not.toHaveBeenCalled();
  });

  it("takes Enter in the field as the same Add", () => {
    const v = mount();
    open(v.container);
    type(v.container, "Kiwi");
    fireEvent.keyDown(field(v.container)!, { key: "Enter" });
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", [FREE_TEXT_LABEL], "Kiwi"]);
  });

  it("opens prefilled with the words already in the row, to update them", () => {
    const v = mount(drawnWith(holding("Pear"), { typed: "Mango", typedChecked: true }));
    open(v.container, "Mango");
    expect(field(v.container)!.value).toBe("Mango");
    expect(fieldAction(v.container)!.textContent!.trim()).toBe("Update");
    expect(fieldAction(v.container)!.disabled, "nothing has changed yet").toBe(true);
    type(v.container, "Kiwi");
    fireEvent.click(fieldAction(v.container)!);
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", ["Pear", FREE_TEXT_LABEL], "Kiwi"]);
  });

  it("removes the pick when the field is cleared", () => {
    const v = mount(drawnWith(holding("Pear"), { typed: "Mango", typedChecked: true }));
    open(v.container, "Mango");
    type(v.container, "");
    fireEvent.click(fieldAction(v.container)!);
    expect(v.onToggle.mock.calls[0]).toEqual(["Fruit", ["Pear"], undefined]);
  });

  it("closes the field once the pane holds the words, and shows them as a ticked row", async () => {
    const v = mount();
    open(v.container);
    type(v.container, "Kiwi");
    fireEvent.click(fieldAction(v.container)!);
    expect(row(v.container, FREE_TEXT_LABEL).getAttribute("aria-busy")).toBe("true");
    await v.land(drawnWith(holding(), { typed: "Kiwi", typedChecked: true }));
    expect(field(v.container)).toBeNull();
    expect(row(v.container, "Kiwi").dataset.chosen).toBe("true");
  });

  it("keeps the field and its words when the pane did not take them", async () => {
    const v = mount();
    open(v.container);
    type(v.container, "Kiwi");
    fireEvent.click(fieldAction(v.container)!);
    await v.land(holding());
    expect(field(v.container)!.value, "retyping is not the reader's job").toBe("Kiwi");
  });

  it("commits words left in the open field rather than dropping them", () => {
    // Typing and pressing the commit button without Add is the obvious slip,
    // and a commit that ignored the field would send the answer without the
    // words while the reader watched them sit there.
    const v = mount(holding("Apple"));
    open(v.container);
    type(v.container, "Kiwi");
    expect(commitButton(v.container)!.disabled).toBe(false);
    fireEvent.click(commitButton(v.container)!);
    expect(v.onChoose.mock.calls[0]).toEqual(["Fruit", ["Apple", FREE_TEXT_LABEL], "Kiwi"]);
  });
});

describe("no decoration is bigger than the thing it decorates", () => {
  const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("leaves no absolutely-positioned pseudo-element inside the card without a positioned parent", () => {
    // The rule that caused this had `position: absolute; inset: 0` on a chip's
    // ::after, and the nearest positioned ancestor was the whole text view.
    const bad = [...css.matchAll(/\.tl-qcard[^{}]*::(after|before)\s*\{([^{}]*)\}/g)]
      .filter((m) => /position:\s*absolute/.test(m[2]!) && /inset:\s*0/.test(m[2]!))
      .map((m) => m[0].split("{")[0]!.trim());
    expect(bad, "page-sized pseudo elements in the answer card").toEqual([]);
  });
});
