/**
 * What the plan card says after a reply, and what the composer's text becomes
 * before it goes out as feedback
 * (docs/plans/2026-09-24-text-composer-redesign.md, "When the card docks, and
 * what it shows" and "The composer while the plan card is docked").
 *
 * Both are pure, so the card only renders what they decide and the caller
 * that sends the answer uses the same rules.
 */
import { describe, it, expect } from "vitest";
import { planFeedback, planReplyNotice } from "../src/components/plan.logic";
import type { AnswerReason, AnswerResponse } from "../src/lib/answer-api";

const refused = (reason: AnswerReason): AnswerResponse => ({ applied: false, reason });

describe("planReplyNotice", () => {
  it("says nothing once the answer is applied", () => {
    expect(planReplyNotice({ applied: true, done: true })).toBeNull();
  });

  it("asks for a new pick when the labels changed under the reader", () => {
    expect(planReplyNotice(refused("unknown-option"))).toBe("changed");
  });

  it.each(["not-drawn", "no-dialog"] as const)("reads %s as the plan having gone", (reason) => {
    expect(planReplyNotice(refused(reason))).toBe("gone");
  });

  it.each(["unverified", "refused"] as const)(
    "reads %s as an answer that may have landed",
    (reason) => {
      // `refused` is tmux not taking a key, which can happen after an earlier
      // key of the same answer went in, so the card cannot say nothing landed.
      expect(planReplyNotice(refused(reason))).toBe("unverified");
    },
  );

  it("reads a failed call as an answer that may have landed", () => {
    // The request may have timed out after the server pressed its keys.
    expect(planReplyNotice(null)).toBe("unverified");
  });
});

describe("planFeedback", () => {
  it("sends one line as it is, trimmed", () => {
    expect(planFeedback("  use the existing helper \n")).toEqual({
      text: "use the existing helper",
      joined: false,
      tooLong: false,
    });
  });

  it("turns line breaks into spaces and says it did", () => {
    expect(planFeedback("first\nsecond\r\n\n  third")).toEqual({
      text: "first second third",
      joined: true,
      tooLong: false,
    });
  });

  it("allows exactly 2,000 bytes", () => {
    expect(planFeedback("a".repeat(2000)).tooLong).toBe(false);
  });

  it("refuses more than 2,000 bytes, counted in UTF-8", () => {
    expect(planFeedback("a".repeat(2001)).tooLong).toBe(true);
    // 667 three-byte characters are 2,001 bytes and only 667 UTF-16 units.
    expect(planFeedback("€".repeat(667)).tooLong).toBe(true);
    expect(planFeedback("€".repeat(666)).tooLong).toBe(false);
  });

  it("measures the text that will be sent, after the line breaks go", () => {
    // 1,000 + 1,000 with a CRLF between is 2,002 bytes typed and 2,001 sent.
    expect(planFeedback(`${"a".repeat(1000)}\r\n${"b".repeat(1000)}`).tooLong).toBe(true);
    expect(planFeedback(`${"a".repeat(1000)}\n${"b".repeat(999)}`).tooLong).toBe(false);
  });
});
