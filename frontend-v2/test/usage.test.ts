import { describe, it, expect } from "vitest";
import {
  BUCKETS,
  DAYS_KEPT,
  MODELLED_BUCKETS,
  MONTHS_KEPT,
  USAGE_STORAGE_KEY,
  aggregate,
  combined,
  commitWindow,
  emptyStore,
  foldInto,
  formatBytes,
  readStore,
  resetStore,
  writeStore,
  type Bucket,
  type BucketTotals,
  type NetKind,
  type UsageBucket,
  type UsageStore,
  type WindowBytes,
} from "../src/diagnostics/usage";

function store(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

const throwing: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

/** Read one bucket map, failing the test rather than the type checker when the
 *  fold under test did not create the bucket the assertion is about. */
function day(s: UsageStore, key: string): BucketTotals {
  const t = s.days[key];
  if (!t) throw new Error(`no daily bucket for ${key}`);
  return combined(t);
}

/** One day's bytes in ONE network kind, for the assertions that are about the
 *  attribution rather than about the arithmetic. */
function dayKind(s: UsageStore, key: string, kind: NetKind): BucketTotals {
  const t = s.days[key];
  if (!t) throw new Error(`no daily bucket for ${key}`);
  return t[kind];
}

function month(s: UsageStore, key: string): BucketTotals {
  const t = s.months[key];
  if (!t) throw new Error(`no monthly bucket for ${key}`);
  return combined(t);
}

/** Nth entry of the breakdown, same reason. */
function nth(a: { buckets: UsageBucket[] }, i: number): UsageBucket {
  const b = a.buckets[i];
  if (!b) throw new Error(`no bucket at index ${i}`);
  return b;
}

/** Local time on purpose: "today" means the day the person is having. */
const at = (s: string) => new Date(s);

const w = (over: WindowBytes = {}): WindowBytes => ({ ...over });

/**
 * The store is written by every lobby tab and by the terminal iframe's window
 * totals relayed through its parent, and read by one settings panel. These are
 * the pure halves: folding, aggregation and pruning, with storage injected the
 * way connection.ts already does it.
 */
describe("usage store — folding", () => {
  it("creates today's bucket from an empty store", () => {
    const s = foldInto(emptyStore(), w({ term: 100, app: 50 }), at("2026-08-28T10:00:00"));
    expect(day(s, "2026-08-28").term).toBe(100);
    expect(day(s, "2026-08-28").app).toBe(50);
  });

  it("accumulates rather than replacing", () => {
    let s = foldInto(emptyStore(), w({ term: 100 }), at("2026-08-28T10:00:00"));
    s = foldInto(s, w({ term: 40 }), at("2026-08-28T10:01:00"));
    expect(day(s, "2026-08-28").term).toBe(140);
  });

  it("mirrors every fold into the month total", () => {
    let s = foldInto(emptyStore(), w({ api: 10 }), at("2026-08-28T10:00:00"));
    s = foldInto(s, w({ api: 5 }), at("2026-08-29T10:00:00"));
    expect(month(s, "2026-08").api).toBe(15);
  });

  it("puts a window folded after local midnight in the new day", () => {
    let s = foldInto(emptyStore(), w({ term: 7 }), at("2026-08-28T23:59:30"));
    s = foldInto(s, w({ term: 3 }), at("2026-08-29T00:00:30"));
    expect(day(s, "2026-08-28").term).toBe(7);
    expect(day(s, "2026-08-29").term).toBe(3);
  });

  it("sums contributions from two tabs, because both fold into one store", () => {
    let s = foldInto(emptyStore(), w({ app: 1_000 }), at("2026-08-28T10:00:00"));
    s = foldInto(s, w({ app: 250 }), at("2026-08-28T10:00:05"));
    expect(day(s, "2026-08-28").app).toBe(1_250);
  });

  it("ignores buckets it does not know and non-finite counts", () => {
    const s = foldInto(
      emptyStore(),
      { term: 10, nonsense: 99, app: Number.NaN } as unknown as WindowBytes,
      at("2026-08-28T10:00:00"),
    );
    expect(day(s, "2026-08-28").term).toBe(10);
    expect(day(s, "2026-08-28").app).toBe(0);
    expect((day(s, "2026-08-28") as unknown as Record<string, number>).nonsense).toBeUndefined();
  });

  it("never lets a negative count reduce a total", () => {
    let s = foldInto(emptyStore(), w({ term: 100 }), at("2026-08-28T10:00:00"));
    s = foldInto(s, w({ term: -50 }), at("2026-08-28T10:01:00"));
    expect(day(s, "2026-08-28").term).toBe(100);
  });
});

describe("usage store — pruning", () => {
  it(`keeps at most ${DAYS_KEPT} daily buckets`, () => {
    let s = emptyStore();
    for (let i = 0; i < 60; i++) {
      const d = new Date("2026-06-01T10:00:00");
      d.setDate(d.getDate() + i);
      s = foldInto(s, w({ term: 1 }), d);
    }
    expect(Object.keys(s.days).length).toBe(DAYS_KEPT);
  });

  it("prunes the oldest days, not the newest", () => {
    let s = emptyStore();
    for (let i = 0; i < 40; i++) {
      const d = new Date("2026-06-01T10:00:00");
      d.setDate(d.getDate() + i);
      s = foldInto(s, w({ term: 1 }), d);
    }
    const keys = Object.keys(s.days).sort();
    expect(keys[keys.length - 1]).toBe("2026-07-10");
    expect(s.days["2026-06-01"]).toBeUndefined();
  });

  it(`keeps at most ${MONTHS_KEPT} monthly totals`, () => {
    let s = emptyStore();
    for (let i = 0; i < 20; i++) {
      const d = new Date("2025-01-15T10:00:00");
      d.setMonth(d.getMonth() + i);
      s = foldInto(s, w({ term: 1 }), d);
    }
    expect(Object.keys(s.months).length).toBe(MONTHS_KEPT);
  });
});

describe("usage store — aggregation", () => {
  const seed = (): UsageStore => {
    let s = emptyStore();
    // today
    s = foldInto(s, w({ term: 900_000, app: 5_100_000, api: 100_000 }), at("2026-08-28T10:00:00"));
    // six days before today, all inside the last-7 window
    for (let i = 1; i <= 6; i++) {
      const d = at("2026-08-28T10:00:00");
      d.setDate(d.getDate() - i);
      s = foldInto(s, w({ term: 1_000_000 }), d);
    }
    // a day outside the last-7 window but inside this month
    s = foldInto(s, w({ term: 500_000 }), at("2026-08-10T10:00:00"));
    // last month
    s = foldInto(s, w({ term: 1_800_000_000 }), at("2026-07-15T10:00:00"));
    return s;
  };

  it("totals today across buckets", () => {
    expect(aggregate(seed(), at("2026-08-28T18:00:00")).today.all).toBe(6_100_000);
  });

  it("totals the last 7 days inclusive of today", () => {
    // today 6,100,000 + six days of 1,000,000
    expect(aggregate(seed(), at("2026-08-28T18:00:00")).last7.all).toBe(12_100_000);
  });

  it("totals the calendar month, including days outside the 7-day window", () => {
    expect(aggregate(seed(), at("2026-08-28T18:00:00")).thisMonth.all).toBe(12_600_000);
  });

  it("totals last calendar month and names it", () => {
    const a = aggregate(seed(), at("2026-08-28T18:00:00"));
    expect(a.lastMonth.all).toBe(1_800_000_000);
    expect(a.lastMonthLabel).toBe("July");
  });

  it("crosses a year boundary when naming last month, and says which year", () => {
    // MONTHS_KEPT spans a year, so a bare "December" read in January is
    // ambiguous between the December just gone and the one before it.
    let s = foldInto(emptyStore(), w({ term: 42 }), at("2025-12-15T10:00:00"));
    s = foldInto(s, w({ term: 1 }), at("2026-01-05T10:00:00"));
    const a = aggregate(s, at("2026-01-05T10:00:00"));
    expect(a.lastMonth.all).toBe(42);
    expect(a.lastMonthLabel).toBe("December 2025");
  });

  it("leaves the year off when it is the current one", () => {
    expect(aggregate(emptyStore(), at("2026-08-28T10:00:00")).lastMonthLabel).toBe("July");
  });

  it("still reports last month after its daily buckets have been pruned", () => {
    let s = foldInto(emptyStore(), w({ term: 1_800_000_000 }), at("2026-07-15T10:00:00"));
    // 40 days of activity pushes every July day out of the 31-day window
    for (let i = 0; i < 40; i++) {
      const d = at("2026-08-01T10:00:00");
      d.setDate(d.getDate() + i);
      s = foldInto(s, w({ term: 1 }), d);
    }
    expect(s.days["2026-07-15"]).toBeUndefined();
    expect(aggregate(s, at("2026-08-15T10:00:00")).lastMonth.all).toBe(1_800_000_000);
  });

  it("reports zeros for an empty store rather than raising", () => {
    const a = aggregate(emptyStore(), at("2026-08-28T10:00:00"));
    expect(a.today.all).toBe(0);
    expect(a.last7.all).toBe(0);
    expect(a.thisMonth.all).toBe(0);
    expect(a.lastMonth.all).toBe(0);
    expect(a.buckets.every((b) => b.bytes === 0)).toBe(true);
  });

  it("returns today's breakdown for every bucket, largest first", () => {
    const a = aggregate(seed(), at("2026-08-28T18:00:00"));
    expect(a.buckets.length).toBe(BUCKETS.length);
    expect(nth(a, 0).key).toBe("app");
    expect(nth(a, 0).bytes).toBe(5_100_000);
    expect(a.buckets.map((b) => b.bytes)).toEqual(
      [...a.buckets.map((b) => b.bytes)].sort((x, y) => y - x),
    );
  });

  it("marks the compressed streams as modelled and the rest as measured", () => {
    const a = aggregate(seed(), at("2026-08-28T18:00:00"));
    const modelled = a.buckets.filter((b) => b.modelled).map((b) => b.key);
    expect(new Set(modelled)).toEqual(new Set(MODELLED_BUCKETS));
    expect(modelled).not.toContain("app");
  });
});

describe("usage store — persistence", () => {
  it("round-trips through storage", () => {
    const s = store();
    writeStore(foldInto(emptyStore(), w({ term: 123 }), at("2026-08-28T10:00:00")), s);
    expect(day(readStore(s), "2026-08-28").term).toBe(123);
  });

  it("uses the versioned key", () => {
    const s = store();
    writeStore(emptyStore(), s);
    expect(s.getItem(USAGE_STORAGE_KEY)).not.toBeNull();
  });

  it("returns an empty store when nothing is stored", () => {
    expect(readStore(store()).days).toEqual({});
  });

  it("returns an empty store rather than raising on unparseable content", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, "{not json");
    expect(readStore(s).days).toEqual({});
  });

  it("discards a stored payload of the wrong shape", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify({ v: 1, days: "nope", months: 7 }));
    expect(readStore(s).days).toEqual({});
    expect(readStore(s).months).toEqual({});
  });

  it("discards a payload from a future schema version", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify({ v: 99, days: { x: { term: 1 } }, months: {} }));
    expect(readStore(s).days).toEqual({});
  });

  it("degrades to an empty store when storage throws", () => {
    expect(readStore(throwing).days).toEqual({});
    expect(() => writeStore(emptyStore(), throwing)).not.toThrow();
    expect(() => resetStore(throwing)).not.toThrow();
  });

  it("degrades when there is no storage at all", () => {
    expect(readStore(null).days).toEqual({});
    expect(() => writeStore(emptyStore(), null)).not.toThrow();
  });

  it("reset clears what the panel reads", () => {
    const s = store();
    writeStore(foldInto(emptyStore(), w({ term: 123 }), at("2026-08-28T10:00:00")), s);
    resetStore(s);
    expect(aggregate(readStore(s), at("2026-08-28T10:00:00")).today.all).toBe(0);
  });
});

describe("committing a window", () => {
  // What diag.js's onWindow actually calls, from the lobby and — relayed over
  // postMessage — from the terminal iframe.
  it("persists a window so the panel can read it back", async () => {
    const s = store();
    await commitWindow({ term: 500, app: 100 }, "unknown", at("2026-08-28T10:00:00"), s);
    expect(aggregate(readStore(s), at("2026-08-28T12:00:00")).today.all).toBe(600);
  });

  it("accumulates windows from more than one caller", async () => {
    const s = store();
    await commitWindow({ app: 1_000 }, "unknown", at("2026-08-28T10:00:00"), s);
    await commitWindow({ term: 250 }, "unknown", at("2026-08-28T10:01:00"), s);
    const a = aggregate(readStore(s), at("2026-08-28T12:00:00"));
    expect(a.today.all).toBe(1_250);
    expect(a.buckets.find((b) => b.key === "app")?.bytes).toBe(1_000);
    expect(a.buckets.find((b) => b.key === "term")?.bytes).toBe(250);
  });

  it("does not raise when storage refuses", async () => {
    await expect(
      commitWindow({ term: 1 }, "unknown", at("2026-08-28T10:00:00"), throwing),
    ).resolves.toBeUndefined();
  });

  it("serializes concurrent commits rather than losing one", async () => {
    // Several tabs fold into one key. Without the lock this is a read-modify-
    // write race; jsdom has no Web Locks, so this also covers the fallback.
    const s = store();
    await Promise.all(
      Array.from({ length: 20 }, () => commitWindow({ api: 10 }, "unknown", at("2026-08-28T10:00:00"), s)),
    );
    expect(aggregate(readStore(s), at("2026-08-28T12:00:00")).today.all).toBe(200);
  });
});

describe("byte formatting", () => {
  // Decimal units, because that is how a data plan is billed.
  it.each<[number, string]>([
    [0, "0 B"],
    [512, "512 B"],
    [999, "999 B"],
    [1_000, "1.0 kB"],
    [1_536, "1.5 kB"],
    [6_400_000, "6.4 MB"],
    [412_000_000, "412.0 MB"],
    [1_830_000_000, "1.8 GB"],
  ])("formats %i as %s", (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });

  it("never renders a negative or non-finite count as a number", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("bucket vocabulary", () => {
  it("names the five feature buckets the panel renders", () => {
    expect([...BUCKETS].sort()).toEqual(["api", "app", "files", "term", "text"] as Bucket[]);
  });

  it("models exactly the two buckets the server compresses", () => {
    expect([...MODELLED_BUCKETS].sort()).toEqual(["term", "text"] as Bucket[]);
  });
});

/**
 * The network dimension: which link the bytes crossed. Every assertion here is
 * about a person on a metered connection being able to trust the cellular
 * figure — that nothing lands in it that did not cross a cellular link, and
 * that nothing which did is quietly missing.
 */
describe("usage store — attribution by network", () => {
  it("keeps each kind's bytes apart within one day", () => {
    let s = foldInto(emptyStore(), w({ term: 100 }), at("2026-08-28T10:00:00"), "wifi");
    s = foldInto(s, w({ term: 40 }), at("2026-08-28T10:01:00"), "cell");
    expect(dayKind(s, "2026-08-28", "wifi").term).toBe(100);
    expect(dayKind(s, "2026-08-28", "cell").term).toBe(40);
    expect(day(s, "2026-08-28").term).toBe(140);
  });

  it("attributes a window with no stated network to unknown", () => {
    const s = foldInto(emptyStore(), w({ app: 7 }), at("2026-08-28T10:00:00"));
    expect(dayKind(s, "2026-08-28", "unknown").app).toBe(7);
    expect(dayKind(s, "2026-08-28", "wifi").app).toBe(0);
  });

  it("treats a kind it does not recognise as unknown rather than dropping it", () => {
    // A byte that crossed the link is a byte spent, whatever a caller said
    // about the network.
    const s = foldInto(
      emptyStore(),
      w({ app: 7 }),
      at("2026-08-28T10:00:00"),
      "satellite" as unknown as NetKind,
    );
    expect(day(s, "2026-08-28").app).toBe(7);
    expect(dayKind(s, "2026-08-28", "unknown").app).toBe(7);
  });

  it("splits every period, and the parts add up to the whole", () => {
    let s = foldInto(emptyStore(), w({ term: 900 }), at("2026-08-28T10:00:00"), "wifi");
    s = foldInto(s, w({ term: 100 }), at("2026-08-28T11:00:00"), "cell");
    s = foldInto(s, w({ term: 7 }), at("2026-08-28T12:00:00"));
    const a = aggregate(s, at("2026-08-28T18:00:00"));
    for (const p of [a.today, a.last7, a.thisMonth]) {
      expect(p.wifi).toBe(900);
      expect(p.cell).toBe(100);
      expect(p.unknown).toBe(7);
      expect(p.all).toBe(p.wifi + p.cell + p.unknown);
    }
  });

  it("splits last month too, so a bill can be checked after it arrives", () => {
    let s = foldInto(emptyStore(), w({ term: 2_000 }), at("2026-07-15T10:00:00"), "cell");
    s = foldInto(s, w({ term: 500 }), at("2026-07-16T10:00:00"), "wifi");
    const a = aggregate(s, at("2026-08-28T10:00:00"));
    expect(a.lastMonth.cell).toBe(2_000);
    expect(a.lastMonth.wifi).toBe(500);
  });

  it("narrows the breakdown to one kind without moving the period totals", () => {
    let s = foldInto(emptyStore(), w({ term: 900, app: 10 }), at("2026-08-28T10:00:00"), "wifi");
    s = foldInto(s, w({ term: 100, app: 300 }), at("2026-08-28T11:00:00"), "cell");
    const bytes = (a: ReturnType<typeof aggregate>, k: Bucket) =>
      a.buckets.find((b) => b.key === k)?.bytes;

    const cell = aggregate(s, at("2026-08-28T18:00:00"), "cell");
    expect(bytes(cell, "term")).toBe(100);
    expect(bytes(cell, "app")).toBe(300);
    // Largest first is per-filter, not a fixed order: on cellular, app is the
    // bucket worth acting on.
    expect(nth(cell, 0).key).toBe("app");
    // The four headline figures are the same whatever the breakdown shows.
    expect(cell.today.all).toBe(aggregate(s, at("2026-08-28T18:00:00")).today.all);

    const all = aggregate(s, at("2026-08-28T18:00:00"), "all");
    expect(bytes(all, "term")).toBe(1_000);
    expect(all.filter).toBe("all");
  });

  it("reports zeros for a kind that saw no traffic", () => {
    const s = foldInto(emptyStore(), w({ term: 900 }), at("2026-08-28T10:00:00"), "wifi");
    const a = aggregate(s, at("2026-08-28T18:00:00"), "cell");
    expect(a.buckets.every((b) => b.bytes === 0)).toBe(true);
    expect(a.today.cell).toBe(0);
    expect(a.today.wifi).toBe(900);
  });

  it("commits a window under the kind the caller was on", async () => {
    const s = store();
    await commitWindow({ term: 500 }, "cell", at("2026-08-28T10:00:00"), s);
    await commitWindow({ term: 200 }, "wifi", at("2026-08-28T10:01:00"), s);
    const a = aggregate(readStore(s), at("2026-08-28T12:00:00"));
    expect(a.today.cell).toBe(500);
    expect(a.today.wifi).toBe(200);
  });
});

describe("usage store — upgrading from the unattributed schema", () => {
  // Counters written before the network was known are kept: someone upgrading
  // mid-month would otherwise lose the month they are in the middle of.
  const legacy = {
    v: 1,
    days: { "2026-08-28": { term: 900, app: 100, text: 0, files: 0, api: 0 } },
    months: { "2026-08": { term: 900, app: 100, text: 0, files: 0, api: 0 } },
  };

  it("lifts stored v1 totals into the unknown kind", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify(legacy));
    const read = readStore(s);
    expect(dayKind(read, "2026-08-28", "unknown").term).toBe(900);
    expect(dayKind(read, "2026-08-28", "wifi").term).toBe(0);
    expect(day(read, "2026-08-28").app).toBe(100);
  });

  it("keeps the lifted bytes in the totals but out of both named columns", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify(legacy));
    const a = aggregate(readStore(s), at("2026-08-28T18:00:00"));
    expect(a.today.all).toBe(1_000);
    expect(a.today.unknown).toBe(1_000);
    expect(a.today.wifi).toBe(0);
    expect(a.today.cell).toBe(0);
  });

  it("writes the new schema back, so the lift happens once", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify(legacy));
    writeStore(foldInto(readStore(s), { term: 1 }, at("2026-08-28T12:00:00"), "cell"), s);
    const raw = JSON.parse(s.getItem(USAGE_STORAGE_KEY) ?? "{}");
    expect(raw.v).toBe(2);
    const read = readStore(s);
    expect(dayKind(read, "2026-08-28", "unknown").term).toBe(900);
    expect(dayKind(read, "2026-08-28", "cell").term).toBe(1);
  });
});
