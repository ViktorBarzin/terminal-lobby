/**
 * A multi-select must accept more than one answer.
 *
 * Found 2026-08-29 by a 16-agent scenario sweep, in 7 of 14 scenarios: picking
 * ONE option in a multi-select made the whole text view unclickable. Every
 * following tap — another option, Review, Show all, Type a message instead, even
 * the composer — was delivered to the chip just chosen and un-picked it. So a
 * multi-select could hold exactly one answer and could never be advanced.
 *
 * The cause was a rule I added the day before, meaning to give the chip a
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
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, fireEvent } from "@solidjs/testing-library";
import { QuestionCard } from "../src/components/QuestionCard";
import type { Question } from "../src/components/canonicalize";

const multi: Question[] = [
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
];

const rows = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>(".tl-qcard-option"));

describe("a multi-select holds several answers", () => {
  it("keeps the first pick when a second is made", () => {
    const { container } = render(() => (
      <QuestionCard questions={multi} onSend={async () => {}} onChat={() => {}} />
    ));
    fireEvent.click(rows(container)[0]!);
    fireEvent.click(rows(container)[1]!);
    expect(rows(container)[0]!.dataset.chosen, "Apple still chosen").toBe("true");
    expect(rows(container)[1]!.dataset.chosen, "Pear chosen too").toBe("true");
  });

  it("sends every pick", async () => {
    const sent: unknown[] = [];
    const { container } = render(() => (
      <QuestionCard
        questions={multi}
        onSend={async (a) => {
          sent.push(a);
        }}
        onChat={() => {}}
      />
    ));
    fireEvent.click(rows(container)[0]!);
    fireEvent.click(rows(container)[2]!);
    // A multi-select goes through the review, as it does in the CLI: only a
    // single SINGLE-select question submits straight from its one screen.
    fireEvent.click(container.querySelector(".tl-qcard-next")!);
    fireEvent.click(container.querySelector(".tl-qcard-send")!);
    expect(sent[0]).toEqual([{ chosen: ["Apple", "Plum"] }]);
  });

  it("still toggles a pick off when it is tapped again", () => {
    const { container } = render(() => (
      <QuestionCard questions={multi} onSend={async () => {}} onChat={() => {}} />
    ));
    fireEvent.click(rows(container)[0]!);
    fireEvent.click(rows(container)[0]!);
    expect(rows(container)[0]!.dataset.chosen).toBeUndefined();
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
