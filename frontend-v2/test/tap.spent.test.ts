import { describe, it, expect } from "vitest";
import {
  spentSessions,
  pickTap,
  tagFor,
  RECEIPT_MAX_AGE_MS,
  TAP_MAX_AGE_MS,
  type StoredRecord,
} from "../src/pwa/tap";

/**
 * Which records are finished with and safe to delete?
 *
 * Narrower than "not actionable", and the gap between those two is a regression
 * that already shipped: a version deleted every record the actionable test
 * refused, which includes the ones whose banner was still sitting in the shade.
 * Opening the app by its icon therefore erased the record behind every
 * notification on screen, and the tap that came minutes later found nothing.
 * Over 72 hours on that build 44 of 237 stash reads came back `absent`, 16 of
 * them with a record written inside the window.
 */
const NOW = 1_700_000_000_000;
const S = 1000;
const MIN = 60 * S;

const rec = (session: string, ageMs: number, tapped = false): StoredRecord =>
  tapped ? { session, ts: NOW - ageMs, tapped: true } : { session, ts: NOW - ageMs };

describe("spentSessions", () => {
  it("keeps a live receipt whose banner is still on screen", () => {
    // THE REGRESSION: this record is not actionable yet and is not spent either.
    const records = [rec("issues", 20 * MIN)];
    expect(pickTap(records, [tagFor("issues")], NOW).session).toBeNull();
    expect(spentSessions(records, NOW)).toEqual([]);
  });

  it("keeps a live receipt whose banner has gone (the caller acts on it instead)", () => {
    expect(spentSessions([rec("issues", 20 * MIN)], NOW)).toEqual([]);
  });

  it("keeps a click still inside its outer window", () => {
    expect(spentSessions([rec("issues", 40 * MIN, true)], NOW)).toEqual([]);
  });

  it("drops a receipt past the receipt window", () => {
    expect(spentSessions([rec("issues", RECEIPT_MAX_AGE_MS + S)], NOW)).toEqual(["issues"]);
  });

  it("keeps a receipt one second short of its window", () => {
    expect(spentSessions([rec("issues", RECEIPT_MAX_AGE_MS - S)], NOW)).toEqual([]);
  });

  it("drops a click past the outer window", () => {
    expect(spentSessions([rec("issues", TAP_MAX_AGE_MS + S, true)], NOW)).toEqual(["issues"]);
  });

  it("keeps a click that a receipt-aged record would have lost", () => {
    // The single largest failure bucket: 201 of 795 reads in a week read
    // `stale` under one 15 min window for both kinds of record.
    const records = [rec("issues", RECEIPT_MAX_AGE_MS + MIN, true)];
    expect(spentSessions(records, NOW)).toEqual([]);
    expect(pickTap(records, [tagFor("issues")], NOW).session).toBe("issues");
  });

  it("drops the session the caller acted on, even though its window is open", () => {
    const records = [rec("issues", 30 * S), rec("ux", 30 * S)];
    expect(spentSessions(records, NOW, "issues")).toEqual(["issues"]);
  });

  it("names an acted session that is not in the list (the legacy mirror slot)", () => {
    expect(spentSessions([], NOW, "issues")).toEqual(["issues"]);
  });

  it("reports each session once, whatever the store held", () => {
    const records = [
      rec("issues", 2 * RECEIPT_MAX_AGE_MS),
      rec("issues", 3 * RECEIPT_MAX_AGE_MS),
      rec("ux", 30 * S),
    ];
    expect(spentSessions(records, NOW, "ux")).toEqual(["issues", "ux"]);
  });

  it("keeps a duplicated session while its newest copy is live", () => {
    const records = [rec("issues", 2 * RECEIPT_MAX_AGE_MS), rec("issues", 30 * S)];
    expect(spentSessions(records, NOW)).toEqual([]);
  });

  it("is pure and does not reorder the caller's array", () => {
    const records = [rec("ux", 4 * MIN), rec("issues", 2 * RECEIPT_MAX_AGE_MS)];
    const before = [...records];
    expect(spentSessions(records, NOW)).toEqual(spentSessions(records, NOW));
    expect(records).toEqual(before);
  });
});

/**
 * Junk rows ARE spent: they can never route anything, and the key they sit
 * under is the session string itself, so a row whose session is not a usable
 * string cannot be named for deletion at all.
 */
const junk: readonly (readonly [string, StoredRecord | null | undefined, string[]])[] = [
  ["a name with a space", { session: "not a name", ts: NOW - 5 * S }, ["not a name"]],
  ["a name over 32 characters", { session: "x".repeat(33), ts: NOW - 5 * S }, ["x".repeat(33)]],
  ["a string ts", { session: "issues", ts: "1700000000000" }, ["issues"]],
  ["a NaN ts", { session: "issues", ts: Number.NaN }, ["issues"]],
  ["a ts in the future", { session: "issues", ts: NOW + 5 * S }, ["issues"]],
  ["no ts", { session: "issues" }, ["issues"]],
  ["an empty name", { session: "", ts: NOW - 5 * S }, []],
  ["no session at all", { ts: NOW - 5 * S }, []],
  ["a numeric session", { session: 7, ts: NOW - 5 * S }, []],
  ["null", null, []],
  ["undefined", undefined, []],
  ["an empty object", {}, []],
];

describe("spentSessions on a malformed record", () => {
  it.each(junk)("%s", (_what, bad, want) => {
    expect(spentSessions([bad], NOW)).toEqual(want);
  });

  it.each(junk)("%s leaves a live record beside it alone", (_what, bad, want) => {
    expect(spentSessions([bad, rec("issues-live", 30 * S)], NOW)).toEqual(want);
  });
});
