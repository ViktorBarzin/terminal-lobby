/**
 * A prompt a Stop took back leaves the conversation.
 *
 * A Stop that lands before Claude has written anything puts the prompt back on
 * Claude Code's input line, and its own view no longer shows it (CLI 2.1.283,
 * measured 2026-09-28). The transcript keeps the prompt's record, so the
 * server marks it (`meta: "rewound"`, the turn it opened), and the Text view
 * draws no bubble for it. Kept, it read as sent, and the next turn's reply
 * landed under it as its answer (found in the T3 pass's live check).
 */
import { describe, it, expect } from "vitest";
import type { Event } from "../src/types/events";
import { deriveRows, sessionWorking } from "../src/components/timeline.logic";

const ev = (e: Partial<Event> & Pick<Event, "id" | "kind">): Event => ({ session: "s", ...e });

const ANSWERED: Event[] = [
  ev({ id: 1, kind: "user", turnId: "t1", body: "hello", at: 1_000 }),
  ev({ id: 2, kind: "text", turnId: "t1", body: "Hi.", at: 1_500 }),
  ev({ id: 3, kind: "turn_end", turnId: "t1", at: 1_600 }),
];

const bubbles = (events: Event[]) =>
  deriveRows(events).flatMap((r) => (r.kind === "user" ? [r.body] : []));

describe("deriveRows: a prompt a Stop took back", () => {
  it("draws no bubble for it, and nothing is left running", () => {
    const events = [
      ...ANSWERED,
      ev({ id: 4, kind: "user", turnId: "t2", body: "Write a long story", at: 2_000 }),
      ev({ id: 5, kind: "turn_end", turnId: "t2", at: 3_500 }),
      ev({
        id: 6,
        kind: "meta",
        meta: "rewound",
        turnId: "t2",
        body: "Write a long story",
        at: 3_500,
      }),
    ];
    expect(bubbles(events)).toEqual(["hello"]);
    expect(sessionWorking(deriveRows(events))).toBe(false);
  });

  it("does not hang the next turn's reply under it", () => {
    const events = [
      ...ANSWERED,
      ev({ id: 4, kind: "user", turnId: "t2", body: "Write a long story", at: 2_000 }),
      ev({
        id: 5,
        kind: "meta",
        meta: "rewound",
        turnId: "t2",
        body: "Write a long story",
        at: 9_000,
      }),
      ev({ id: 6, kind: "turn_end", turnId: "t2", at: 9_000 }),
      ev({ id: 7, kind: "user", turnId: "t3", body: "Just say OK", at: 9_000 }),
      ev({ id: 8, kind: "text", turnId: "t3", body: "OK", at: 9_500 }),
    ];
    expect(bubbles(events)).toEqual(["hello", "Just say OK"]);
    const rows = deriveRows(events);
    const reply = rows.findIndex((r) => r.kind === "message" && r.body === "OK");
    expect(rows[reply - 1]?.kind).toBe("user");
  });

  // Deployed review round 4 (2026-09-28): a Stop took back two queued prompts
  // the CLI ran as one batch, each opening a turn of its own. The Stop ends
  // only the last one's turn, so the first one's, left with nothing but its
  // marker, read as running: "Working…" and a spinner after the Stop.
  it("leaves nothing running after it takes back a batch", () => {
    const events = [
      ...ANSWERED,
      ev({ id: 4, kind: "user", turnId: "t2", body: "queued msg 1", at: 2_000 }),
      ev({ id: 5, kind: "user", turnId: "t3", body: "queued msg 2", at: 2_001 }),
      ev({ id: 6, kind: "turn_end", turnId: "t3", at: 2_700 }),
      ev({ id: 7, kind: "meta", meta: "rewound", turnId: "t2", body: "queued msg 1", at: 2_700 }),
      ev({ id: 8, kind: "meta", meta: "rewound", turnId: "t3", body: "queued msg 2", at: 2_700 }),
    ];
    expect(bubbles(events)).toEqual(["hello"]);
    expect(sessionWorking(deriveRows(events))).toBe(false);
  });

  it("leaves every other turn's prompt alone", () => {
    const events = [
      ...ANSWERED,
      ev({ id: 4, kind: "meta", meta: "rewound", turnId: "t9", body: "hello", at: 5_000 }),
    ];
    expect(bubbles(events)).toEqual(["hello"]);
  });
});
