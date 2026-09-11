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
 * WHAT IT PINS NOW. There is no draft left to hold several picks in: a tap is
 * a request, not a local toggle, and the Enter that ends it leaves the
 * question, so a second fruit means coming back to the chip
 * (docs/plans/2026-09-10-text-mode-answers-dialogs-design.md). What the tap
 * SENDS changed on 2026-09-11: every label the question should end up
 * holding, rather than the one that was tapped. With one label, coming back to
 * add a second fruit deleted the first — measured with Apple ticked and the
 * cursor on its row, the plan for Pear opens with a Space on Apple — while the
 * card promised "One pick per tap. Come back to this question to add another".
 * The accumulation is therefore what the multi-select half of this file pins,
 * alongside the CSS guard, which is unchanged: a page-sized pseudo-element
 * would break the new card exactly as it broke the old one.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, fireEvent } from "@solidjs/testing-library";
import { QuestionCard } from "../src/components/QuestionCard";
import type { DialogView } from "../src/lib/answer-api";

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

const rows = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>(".tl-qcard-option"));

/** Let every queued microtask run, so a settled request has cleared its mark. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const mount = (
  onChoose: (h: string, c: string[], t?: string) => Promise<void>,
  dialog: DialogView = multi,
) =>
  render(() => (
    <QuestionCard
      dialog={dialog}
      busy={false}
      onChoose={onChoose}
      onBack={async () => {}}
      onSubmit={async () => {}}
      onKeys={async () => {}}
      onChat={() => {}}
    />
  ));

describe("a multi-select pick is a request, not a toggle", () => {
  it("sends the tapped label with the question's header", () => {
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose);
    fireEvent.click(rows(container)[1]!);
    expect(onChoose).toHaveBeenCalledWith("Fruit", ["Pear"]);
  });

  it("leaves no pick latched on the card once the request has settled", async () => {
    // The pane holds the ☒, not this card. A row that stayed marked after its
    // request landed would be the card claiming to know something about the
    // dialog that it had not read, which is the class of state the design
    // removed.
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose);
    fireEvent.click(rows(container)[0]!);
    await settle();
    expect(rows(container)[0]!.dataset.chosen).toBeUndefined();
  });

  it("takes the second pick as its own request, on the reading that came back", async () => {
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose);
    fireEvent.click(rows(container)[0]!);
    await settle();
    fireEvent.click(rows(container)[2]!);
    expect(onChoose.mock.calls).toEqual([
      ["Fruit", ["Apple"]],
      ["Fruit", ["Plum"]],
    ]);
  });
});

/** The same question after one pick, as the pane draws it on a revisit. */
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
  answered: 1,
});

describe("a second pick adds to the first", () => {
  it("sends every label the question should end up holding", () => {
    // THE BUG THIS CLOSES. The request used to carry the tapped label alone,
    // and the server answers a multi-select by toggling the rows that differ
    // from what it is asked for — so "Pear" against a question holding Apple
    // meant a Space on Apple as well, and the reader's first fruit went. The
    // card promised the opposite in the same breath: "One pick per tap. Come
    // back to this question to add another."
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose, holding("Apple"));
    fireEvent.click(rows(container)[1]!);
    expect(onChoose).toHaveBeenCalledWith("Fruit", ["Apple", "Pear"]);
  });

  it("shows the reader what is being held, from the reading and not from itself", () => {
    // The tick is the pane's. It is also what the set above is built from, so
    // a reader who cannot see it cannot predict what their tap will send.
    const { container } = mount(async () => {}, holding("Apple"));
    expect(rows(container)[0]!.dataset.chosen).toBe("true");
    expect(rows(container)[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(rows(container)[1]!.dataset.chosen).toBeUndefined();
    expect(rows(container)[1]!.getAttribute("aria-pressed")).toBe("false");
    // The tick is drawn by the CSS that has been waiting for this attribute
    // since the card was written, rather than by a rule of its own.
    expect(rows(container)[0]!.dataset.multi).toBe("true");
  });

  it("takes a pick back out when its row is tapped again", () => {
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose, holding("Apple", "Pear"));
    fireEvent.click(rows(container)[0]!);
    expect(onChoose).toHaveBeenCalledWith("Fruit", ["Pear"]);
  });

  it("keeps the last pick rather than asking for a question with nothing chosen", () => {
    // Enter is what leaves a multi-select question and it does not fire on an
    // empty one (measured; sessionio/answerplan.go). So the only thing an
    // empty set could produce is a request that cannot land, and tapping your
    // own single answer means what it has always meant here: keep it, and
    // move on.
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose, holding("Apple"));
    fireEvent.click(rows(container)[0]!);
    expect(onChoose).toHaveBeenCalledWith("Fruit", ["Apple"]);
  });

  it("leaves a single-select question sending one label", () => {
    // A single-select list draws no boxes, so nothing is ever ticked in the
    // reading and the set is the tapped label on its own — which TextView
    // spells as `choice` on the wire, exactly as before.
    const onChoose = vi.fn(async (_h: string, _c: string[]) => {});
    const { container } = mount(onChoose, {
      ...multi,
      questions: [{ ...multi.questions[0]!, multiSelect: false }],
    });
    fireEvent.click(rows(container)[2]!);
    expect(onChoose).toHaveBeenCalledWith("Fruit", ["Plum"]);
    expect(rows(container)[2]!.dataset.multi).toBeUndefined();
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
