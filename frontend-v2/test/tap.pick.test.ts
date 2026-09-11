import { describe, it, expect } from "vitest";
import {
  pickTap,
  tagFor,
  RECEIPT_FRESH_MS,
  RECEIPT_MAX_AGE_MS,
  TAP_MAX_AGE_MS,
  type StoredRecord,
  type TapReason,
} from "../src/pwa/tap";

/**
 * Which of the outstanding notifications did the user tap?
 *
 * On iOS nothing says. An installed PWA gets no notificationclick, and being
 * brought to the foreground carries no argument. What iOS does do is CLEAR the
 * banner that was tapped and leave the others, so a record whose banner has gone
 * is the tap, read after the fact.
 *
 * The shape that started this, measured on Viktor's phone 2026-09-02: pushes for
 * issues, cache-omages and ux inside 80 s, he tapped the oldest, and the app
 * landed on the newest. Seven days of journal after the per-session fix:
 * acted 51, already 11, untapped 156, stale 201, absent 376. Only 51 of 795 reads
 * routed, and `stale` alone threw away 201 real records.
 */
const NOW = 1_700_000_000_000;
const S = 1000;
const MIN = 60 * S;

const rec = (session: string, ageMs: number, tapped = false): StoredRecord =>
  tapped ? { session, ts: NOW - ageMs, tapped: true } : { session, ts: NOW - ageMs };

/** The shade as the caller reads it: one getNotifications(), mapped to tags. */
const shown = (...sessions: string[]): string[] => sessions.map(tagFor);

interface Case {
  readonly what: string;
  readonly records: readonly StoredRecord[];
  /** null = getNotifications could not be read at all. */
  readonly shade: readonly string[] | null;
  readonly session: string | null;
  readonly reason: TapReason;
}

const cases: readonly Case[] = [
  // ---- the reported shape ------------------------------------------------
  {
    what: "2026-09-02: three pushes in 80 s, the oldest was the tapped one",
    records: [rec("ux", 1 * S), rec("cache-omages", 50 * S), rec("issues", 80 * S, true)],
    shade: shown("ux", "cache-omages", "issues"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "same three, no click recorded, iOS cleared the banner it opened",
    records: [rec("ux", 1 * S), rec("cache-omages", 50 * S), rec("issues", 80 * S)],
    // All three are inside the fresh window, so the clock cannot separate them.
    // The shade can: `ux` is the one iOS cleared.
    shade: shown("cache-omages", "issues"),
    session: "ux",
    reason: "acted",
  },
  // The same shape with the tapped banner the OLDEST of the three. This is the
  // regression the per-session store was added to stop, and ranking every fresh
  // receipt by timestamp brings it straight back: `ux` is 30 s newer, still on
  // screen, and untouched.
  {
    what: "the gone banner wins over a newer fresh receipt still on screen",
    records: [rec("ux", 30 * S), rec("issues", 90 * S)],
    shade: shown("ux"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "three fresh receipts, the oldest is the one whose banner has gone",
    records: [rec("ux", 1 * S), rec("cache-omages", 50 * S), rec("issues", 80 * S)],
    shade: shown("ux", "cache-omages"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "two gone banners beside a fresher one still up: the newest GONE wins",
    records: [rec("ux", 10 * S), rec("issues", 40 * S), rec("cache-omages", 70 * S)],
    shade: shown("ux"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "a recorded click still outranks a gone banner",
    records: [rec("ux", 10 * S), rec("issues", 40 * S, true)],
    shade: shown("issues"),
    session: "issues",
    reason: "acted",
  },

  // ---- an icon launch must stay put --------------------------------------
  {
    what: "every banner still on screen, all aged: an icon launch, not a tap",
    records: [rec("ux", 5 * MIN), rec("issues", 9 * MIN)],
    shade: shown("ux", "issues"),
    session: null,
    reason: "untapped",
  },
  {
    what: "nothing pending at all",
    records: [],
    shade: [],
    session: null,
    reason: "absent",
  },

  // ---- an explicit click outlives the receipt clock ----------------------
  {
    what: "a click recorded 40 min ago still wins, banner or no banner",
    records: [rec("issues", 40 * MIN, true)],
    shade: shown("issues"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "a click beats a fresher untapped receipt",
    records: [rec("ux", 2 * S), rec("issues", 40 * MIN, true)],
    shade: [],
    session: "issues",
    reason: "acted",
  },
  {
    what: "a click just inside the outer window is still evidence",
    records: [rec("issues", TAP_MAX_AGE_MS - S, true)],
    shade: shown("issues"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "a click past the outer window is not evidence of anything",
    records: [rec("issues", TAP_MAX_AGE_MS + S, true)],
    shade: [],
    session: null,
    reason: "stale",
  },
  {
    what: "newest click wins when two were recorded",
    records: [rec("ux", 3 * MIN, true), rec("issues", 40 * MIN, true)],
    shade: [],
    session: "ux",
    reason: "acted",
  },

  // ---- receipts: tight, and only the shade widens them -------------------
  // A banner the shade still shows was not tapped, however recent it is. This
  // is the desktop yank: come back to the browser window 30 s after a push
  // nobody touched, and the old build moved the reader off the session they
  // were reading.
  {
    what: "a fresh receipt whose banner is still up did not route",
    records: [rec("ux", 30 * S)],
    shade: shown("ux"),
    session: null,
    reason: "untapped",
  },
  {
    // The fresh window only decides anything when the shade is silent, so the
    // boundary is pinned there. One second the other side of it is the
    // "shade unreadable: an aged receipt is NOT proven gone" case below.
    what: "shade unreadable: a receipt one second short of the window routes",
    records: [rec("ux", RECEIPT_FRESH_MS - S)],
    shade: null,
    session: "ux",
    reason: "acted",
  },
  {
    what: "a 20 min receipt whose banner has gone was tapped or dismissed",
    records: [rec("issues", 20 * MIN)],
    shade: [],
    session: "issues",
    reason: "acted",
  },
  {
    what: "a 20 min receipt whose banner is still up was not touched",
    records: [rec("issues", 20 * MIN)],
    shade: shown("issues"),
    session: null,
    reason: "untapped",
  },
  {
    what: "a receipt past the receipt window is spent even with its banner gone",
    records: [rec("issues", RECEIPT_MAX_AGE_MS + S)],
    shade: [],
    session: null,
    reason: "stale",
  },
  {
    what: "an unrelated banner in the shade decides nothing",
    records: [rec("issues", 20 * MIN)],
    shade: shown("trip-casia"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "of two gone banners the newest is the tap",
    records: [rec("ux", 4 * MIN), rec("issues", 9 * MIN)],
    shade: [],
    session: "ux",
    reason: "acted",
  },
  {
    what: "the one gone banner wins over a newer one still on screen",
    records: [rec("ux", 4 * MIN), rec("issues", 9 * MIN)],
    shade: shown("ux"),
    session: "issues",
    reason: "acted",
  },

  // ---- an unreadable shade proves nothing gone ---------------------------
  {
    what: "shade unreadable: a fresh receipt still routes on its own window",
    records: [rec("ux", 30 * S), rec("issues", 9 * MIN)],
    shade: null,
    session: "ux",
    reason: "acted",
  },
  {
    what: "shade unreadable: an aged receipt is NOT proven gone",
    records: [rec("issues", 9 * MIN)],
    shade: null,
    session: null,
    reason: "untapped",
  },
  {
    what: "shade unreadable: a recorded click does not need the shade",
    records: [rec("issues", 40 * MIN, true)],
    shade: null,
    session: "issues",
    reason: "acted",
  },

  // ---- stale vs untapped, the two ways of returning null -----------------
  {
    what: "one aged-out record and one live untapped one reports untapped",
    records: [rec("gone-long-ago", 2 * RECEIPT_MAX_AGE_MS), rec("issues", 9 * MIN)],
    shade: shown("issues"),
    session: null,
    reason: "untapped",
  },
  {
    what: "every record aged out reports stale",
    records: [rec("a", 2 * RECEIPT_MAX_AGE_MS), rec("b", 3 * RECEIPT_MAX_AGE_MS)],
    shade: [],
    session: null,
    reason: "stale",
  },

  // ---- ties --------------------------------------------------------------
  {
    what: "same ts: the name breaks the tie, so the answer never depends on store order",
    records: [rec("ux", 4 * MIN), rec("issues", 4 * MIN)],
    shade: [],
    session: "issues",
    reason: "acted",
  },
  {
    what: "same ts reversed: still the same answer",
    records: [rec("issues", 4 * MIN), rec("ux", 4 * MIN)],
    shade: [],
    session: "issues",
    reason: "acted",
  },
  {
    what: "same ts, one of them clicked: the click wins the tie",
    records: [rec("issues", 4 * MIN), rec("ux", 4 * MIN, true)],
    shade: [],
    session: "ux",
    reason: "acted",
  },

  // ---- duplicates (the legacy `last` slot mirrors a per-session record) ---
  {
    what: "the same session twice, one copy carrying the click",
    records: [rec("issues", 9 * MIN), rec("issues", 9 * MIN, true)],
    shade: shown("issues"),
    session: "issues",
    reason: "acted",
  },
  {
    what: "the same session twice, the newer copy sets the age",
    records: [rec("issues", 2 * RECEIPT_MAX_AGE_MS), rec("issues", 30 * S)],
    shade: [],
    session: "issues",
    reason: "acted",
  },
];

describe("pickTap", () => {
  it.each(cases.map((c) => [c.what, c] as const))("%s", (_what, c) => {
    expect(pickTap(c.records, c.shade, NOW)).toEqual({ session: c.session, reason: c.reason });
  });

  it("accepts the shade as a Set as well as an array", () => {
    const records = [rec("issues", 20 * MIN)];
    expect(pickTap(records, new Set([tagFor("issues")]), NOW).session).toBeNull();
    expect(pickTap(records, new Set<string>(), NOW).session).toBe("issues");
  });

  it("is pure: same answer twice, and it does not reorder the caller's array", () => {
    const records = [rec("ux", 4 * MIN), rec("issues", 9 * MIN)];
    const before = [...records];
    const first = pickTap(records, [], NOW);
    const second = pickTap(records, [], NOW);
    expect(second).toEqual(first);
    expect(records).toEqual(before);
  });

  it("moving the clock forward turns a live record into a stale one", () => {
    const records = [rec("issues", 20 * MIN)];
    expect(pickTap(records, [], NOW).reason).toBe("acted");
    expect(pickTap(records, [], NOW + RECEIPT_MAX_AGE_MS).reason).toBe("stale");
  });
});

/**
 * Malformed rows. A record that cannot be read is not evidence that a push
 * arrived, so it reads `absent` rather than `stale`: `absent` is already the
 * caller's word for "nothing usable was waiting", and seven days of journal
 * history keeps its meaning.
 */
const malformed: readonly (readonly [string, StoredRecord | null | undefined])[] = [
  ["a name with a space", { session: "not a name", ts: NOW - 5 * S }],
  ["a name over 32 characters", { session: "x".repeat(33), ts: NOW - 5 * S }],
  ["an empty name", { session: "", ts: NOW - 5 * S }],
  ["a name with a slash", { session: "a/b", ts: NOW - 5 * S }],
  ["no session at all", { ts: NOW - 5 * S }],
  ["a numeric session", { session: 7, ts: NOW - 5 * S }],
  ["a string ts", { session: "issues", ts: String(NOW - 5 * S) }],
  ["no ts", { session: "issues" }],
  ["a NaN ts", { session: "issues", ts: Number.NaN }],
  ["an infinite ts", { session: "issues", ts: Number.POSITIVE_INFINITY }],
  ["a ts in the future", { session: "issues", ts: NOW + 5 * S }],
  ["null", null],
  ["undefined", undefined],
  ["an empty object", {}],
];

describe("pickTap ignores a malformed record", () => {
  it.each(malformed)("%s", (_what, bad) => {
    expect(pickTap([bad], shown("issues"), NOW)).toEqual({ session: null, reason: "absent" });
  });

  it.each(malformed)("%s does not stop a good record beside it", (_what, bad) => {
    // The shade is empty so the good record is a plain GONE banner. What is
    // under test here is the junk beside it, not which tier wins.
    const records = [bad, rec("issues", 30 * S)];
    expect(pickTap(records, [], NOW)).toEqual({
      session: "issues",
      reason: "acted",
    });
  });
});

/**
 * The Declarative Web Push path (iOS/iPadOS 18.4+): the OS opens the `navigate`
 * URL itself and never dispatches notificationclick, so `?session=` is the one
 * first-hand statement of which banner was tapped. It is also the one thing in
 * this file that can be STALE — nothing rewrites the query, and an installed PWA
 * is restored at the URL it was last showing — so a live record has to back it.
 */
describe("pickTap with a navigate URL", () => {
  it("lands on the navigated session over a newer fresh receipt", () => {
    const records = [rec("ux", 20 * S), rec("issues", 90 * S)];
    expect(pickTap(records, null, NOW, "issues")).toEqual({
      session: "issues",
      reason: "acted",
    });
  });

  it("lands on the navigated session when the shade cannot be read at all", () => {
    const records = [rec("ux", 20 * S), rec("issues", 150 * S)];
    // Without the URL this is `ux`: the shade is silent and only `ux` is fresh.
    expect(pickTap(records, null, NOW).session).toBe("ux");
    expect(pickTap(records, null, NOW, "issues").session).toBe("issues");
  });

  it("ignores a stale URL whose record is gone, and lets the stash decide", () => {
    const records = [rec("ux", 20 * S)];
    expect(pickTap(records, [], NOW, "trip-casia")).toEqual({
      session: "ux",
      reason: "acted",
    });
  });

  it("ignores a URL whose record has aged out", () => {
    const records = [rec("issues", RECEIPT_MAX_AGE_MS + S)];
    expect(pickTap(records, [], NOW, "issues")).toEqual({ session: null, reason: "stale" });
  });

  it("ignores a URL that is not a session name", () => {
    const records = [rec("ux", 20 * S)];
    for (const bad of ["not a name", "a/b", "x".repeat(33), ""]) {
      expect(pickTap(records, [], NOW, bad).session).toBe("ux");
    }
  });

  it("null means no navigate URL and changes nothing", () => {
    const records = [rec("ux", 20 * S), rec("issues", 90 * S)];
    expect(pickTap(records, shown("ux"), NOW, null)).toEqual(pickTap(records, shown("ux"), NOW));
  });
});
