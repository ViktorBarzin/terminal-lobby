/**
 * What the card OFFERS as an answer, versus what the dialog's list IS.
 *
 * `shownOptions` is the dialog's own list — the caller's options, then "Type
 * something", then "Chat about this" — and it is what `keysFor` counts to work
 * out which digit to inject. It is a contract with the pty and must not move.
 *
 * The card renders something slightly different: "Chat about this" is not an
 * answer. It abandons the question and hands the reader the composer, and it
 * takes effect the moment it is pressed, while every other row is a draft that
 * nothing acts on until Submit. Sitting in the same list, told apart by an
 * arrow, it read like a fifth option. So it moves to the footer, and the list
 * holds only things you can actually answer with.
 *
 * The number beside a row stays the DIALOG's number either way — it is the key
 * we are about to type, so it has to be the key the CLI is listening for.
 */
import { describe, it, expect } from "vitest";
import {
  CHAT_LABEL,
  OTHER_LABEL,
  answerableOptions,
  optionIndex,
  shownOptions,
} from "../src/components/answer.logic";
import type { Question } from "../src/components/canonicalize";

const q: Question = {
  header: "Push path",
  question: "Which mechanism?",
  multiSelect: false,
  options: [
    { label: "Woodpecker", description: "a runner asks it to deploy" },
    { label: "Tailnet", description: "one hop, no broker" },
  ],
};

describe("the card's option list", () => {
  it("offers the answers and not the chat escape", () => {
    expect(answerableOptions(q)).toEqual(["Woodpecker", "Tailnet", OTHER_LABEL]);
    expect(answerableOptions(q)).not.toContain(CHAT_LABEL);
  });

  it("leaves the dialog's own list alone — it is the injection contract", () => {
    expect(shownOptions(q)).toEqual(["Woodpecker", "Tailnet", OTHER_LABEL, CHAT_LABEL]);
  });

  it("numbers a row with the digit the pty is listening for", () => {
    // The card shows one fewer row than the dialog has, but the numbers must
    // still be the dialog's, or the key we type answers a different option.
    for (const label of answerableOptions(q)) {
      const shown = optionIndex(q, label) + 1;
      expect(shown, `${label} keeps its dialog number`).toBe(
        shownOptions(q).indexOf(label) + 1,
      );
    }
    expect(optionIndex(q, OTHER_LABEL) + 1).toBe(3);
  });

  it("keeps the caller's order", () => {
    expect(answerableOptions(q).slice(0, 2)).toEqual(["Woodpecker", "Tailnet"]);
  });
});
