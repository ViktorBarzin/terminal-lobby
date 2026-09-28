/**
 * The CLI's <pasted_content> marker never reaches the reader.
 *
 * Claude Code 2.1.283 records a long paste as
 * `\n\n<pasted_content id="ed39">\n…\n</pasted_content id="ed39">\n`. The user
 * bubble drew that as it was, two blank lines and both tags around the words
 * (deployed review round 3, 2026-09-28), and Up in the composer brought the
 * marker back into the field. Only the Stop hand-back took it off.
 */
import { describe, it, expect } from "vitest";
import type { Event, SessionState } from "../src/types/events";
import {
  deriveRows,
  promptHistory,
  queuedPrompts,
  visibleRows,
  type UserRow,
} from "../src/components/timeline.logic";

let seq = 0;
const ev = (e: Partial<Event> & { kind: Event["kind"] }): Event => ({
  id: ++seq,
  session: "demo",
  turnId: `t${seq}`,
  ...e,
});

const wrapped = (id: string, inner: string) =>
  `\n\n<pasted_content id="${id}">\n${inner}\n</pasted_content id="${id}">\n`;

const userBodies = (events: Event[]): string[] => {
  const rows = deriveRows(events);
  return visibleRows(rows, new Set(rows.filter((r) => r.kind === "turn-fold").map((r) => r.turnKey)))
    .filter((r): r is UserRow => r.kind === "user")
    .map((r) => r.body);
};

describe("a wrapped paste", () => {
  it("draws in the bubble as the words alone", () => {
    const body = wrapped("ed39", "first line of a long draft\nsecond line\nthird line");
    expect(userBodies([ev({ kind: "user", body })])).toEqual([
      "first line of a long draft\nsecond line\nthird line",
    ]);
  });

  it("keeps the words typed before the paste", () => {
    const body = `look at this log${wrapped("ab12", "line one\nline two\nline three")}`;
    expect(userBodies([ev({ kind: "user", body })])).toEqual([
      "look at this log\n\nline one\nline two\nline three",
    ]);
  });

  it("leaves a message with no marker exactly as it was", () => {
    const body = "  indented\n\nkept as typed  ";
    expect(userBodies([ev({ kind: "user", body })])).toEqual([body]);
  });

  it("comes back from history without the marker", () => {
    const body = wrapped("c2e6", "Reply with KIWI.\nline two\nline three");
    expect(promptHistory([ev({ kind: "user", body })])).toEqual(["Reply with KIWI.\nline two\nline three"]);
  });

  it("comes back from the history the server seeded without the marker", () => {
    const seed: SessionState = { at: 0, queue: [], prompts: [wrapped("0a0b", "older\nwrapped\nprompt")] };
    expect(promptHistory([], seed)).toEqual(["older\nwrapped\nprompt"]);
  });

  it("draws as a queued ghost without the marker", () => {
    const body = `<pasted_content id="bae7">\nqueued\npaste\nhere\n</pasted_content id="bae7">`;
    expect(queuedPrompts([ev({ kind: "meta", meta: "queued", body })])).toEqual(["queued\npaste\nhere"]);
  });
});
