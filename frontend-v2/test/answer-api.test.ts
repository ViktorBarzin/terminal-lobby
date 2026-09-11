/**
 * The two label rules in the answer contract, which both halves have to agree
 * on.
 *
 * `lib/answer-api.ts` mirrors `sessionio/answerapi.go`, and these two
 * functions are the only behaviour on the TS side of that mirror: everything
 * else there is a type or the fetch. Their opposite numbers in Go are
 * `isFreeTextLabel` and the option filter in `ParseDialog`, tested against
 * real captures in `sessionio/answerplan_test.go`. A rule that drifts apart
 * here fails quietly — the card offers a row the server then refuses as
 * `unknown-option` — so it is pinned on both sides rather than one.
 */
import { describe, it, expect } from "vitest";
import {
  CHAT_LABEL,
  FREE_TEXT_LABEL,
  LEGACY_FREE_TEXT_LABEL,
  answerableOptions,
  isFreeText,
  type DialogQuestionView,
} from "../src/lib/answer-api";

describe("isFreeText", () => {
  it("knows the label CLI 2.1.267 draws", () => {
    expect(isFreeText(FREE_TEXT_LABEL)).toBe(true);
  });

  it("takes the trailing period the CLI puts on a single-question row", () => {
    // Measured 2026-09-10: "3. Type something." in a single-question dialog,
    // "4. [ ] Type something" in a multi-select one. Same row, two spellings.
    expect(isFreeText("Type something.")).toBe(true);
  });

  it("still takes the name the frontend used until 2026-09-10", () => {
    // A client and a server on different builds have to mean the same row.
    // The old name was harmless only because the digit position happened to
    // match, which is the drift the marker fingerprint now watches for.
    expect(isFreeText(LEGACY_FREE_TEXT_LABEL)).toBe(true);
  });

  it("is not fooled by a label that merely mentions typing", () => {
    expect(isFreeText("Type something else")).toBe(false);
    expect(isFreeText("Other options")).toBe(false);
  });
});

describe("answerableOptions", () => {
  const q = (labels: string[]): DialogQuestionView => ({
    question: "Which fruit?",
    header: "Fruit",
    options: labels.map((label) => ({ label })),
  });

  it("drops the chat row, which abandons the question rather than answering it", () => {
    const kept = answerableOptions(q(["Apple", "Pear", CHAT_LABEL]));
    expect(kept.map((o) => o.label)).toEqual(["Apple", "Pear"]);
  });

  it("keeps every real option in the order the CLI drew them", () => {
    // Order is the digit: option n is answered by pressing n, so a filter that
    // reordered would answer a different question than the reader tapped.
    const kept = answerableOptions(q(["Apple", "Pear", "Plum"]));
    expect(kept.map((o) => o.label)).toEqual(["Apple", "Pear", "Plum"]);
  });

  it("leaves the free-text row in, since it is a row a reader can pick", () => {
    const kept = answerableOptions(q(["Apple", FREE_TEXT_LABEL, CHAT_LABEL]));
    expect(kept.map((o) => o.label)).toEqual(["Apple", FREE_TEXT_LABEL]);
  });
});
