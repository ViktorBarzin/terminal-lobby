import { describe, it, expect } from "vitest";
import {
  BUCKETS,
  DAYS_KEPT,
  MODELLED_BUCKETS,
  MONTHS_KEPT,
  NETWORKS_SHOWN,
  NET_EARLIER,
  NET_LAN,
  NET_OTHER,
  NET_UNKNOWN,
  USAGE_STORAGE_KEY,
  aggregate,
  combined,
  commitResetSince,
  commitWindow,
  emptyStore,
  foldInto,
  formatBytes,
  netLabel,
  readStore,
  rememberNet,
  resetStore,
  totalOf,
  writeStore,
  type Bucket,
  type BucketTotals,
  type PeriodKey,
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

/** One day's bytes on ONE network, for the assertions that are about the
 *  attribution rather than about the arithmetic. */
function dayNet(s: UsageStore, key: string, net: string): BucketTotals {
  const t = s.days[key];
  if (!t) throw new Error(`no daily bucket for ${key}`);
  return t[net] ?? { term: 0, app: 0, text: 0, files: 0, api: 0 };
}

function month(s: UsageStore, key: string): BucketTotals {
  const t = s.months[key];
  if (!t) throw new Error(`no monthly bucket for ${key}`);
  return combined(t);
}

/** One period's total out of an aggregate. */
function period(a: { periods: { key: PeriodKey; bytes: number }[] }, key: PeriodKey): number {
  const row = a.periods.find((p) => p.key === key);
  if (!row) throw new Error(`no period ${key}`);
  return row.bytes;
}

/** The label a period row carries. */
function periodLabel(a: { periods: { key: PeriodKey; label: string }[] }, key: PeriodKey): string {
  return a.periods.find((p) => p.key === key)?.label ?? "";
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

/** Round-trip a store through storage, which is how the panel actually reads
 *  one — and the only way to exercise the directory pruning. */
function roundTrip(s: UsageStore) {
  const m = store();
  writeStore(s, m);
  return m;
}

/** A store whose resettable period was reset at a given moment. */
function resetSinceAt(when: Date): UsageStore {
  const m = store();
  writeStore(foldInto(emptyStore(), { term: 1 }, when), m);
  const s = readStore(m);
  return { ...s, since: { at: when.getTime(), totals: s.since.totals } };
}

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
    expect(period(aggregate(seed(), at("2026-08-28T18:00:00")), "today")).toBe(6_100_000);
  });

  it("totals the last 7 days inclusive of today", () => {
    // today 6,100,000 + six days of 1,000,000
    expect(period(aggregate(seed(), at("2026-08-28T18:00:00")), "last7")).toBe(12_100_000);
  });

  it("totals the calendar month, including days outside the 7-day window", () => {
    expect(period(aggregate(seed(), at("2026-08-28T18:00:00")), "thisMonth")).toBe(12_600_000);
  });

  it("totals last calendar month and names it", () => {
    const a = aggregate(seed(), at("2026-08-28T18:00:00"));
    expect(period(a, "lastMonth")).toBe(1_800_000_000);
    expect(periodLabel(a, "lastMonth")).toBe("July");
  });

  it("crosses a year boundary when naming last month, and says which year", () => {
    // MONTHS_KEPT spans a year, so a bare "December" read in January is
    // ambiguous between the December just gone and the one before it.
    let s = foldInto(emptyStore(), w({ term: 42 }), at("2025-12-15T10:00:00"));
    s = foldInto(s, w({ term: 1 }), at("2026-01-05T10:00:00"));
    const a = aggregate(s, at("2026-01-05T10:00:00"));
    expect(period(a, "lastMonth")).toBe(42);
    expect(periodLabel(a, "lastMonth")).toBe("December 2025");
  });

  it("leaves the year off when it is the current one", () => {
    expect(periodLabel(aggregate(emptyStore(), at("2026-08-28T10:00:00")), "lastMonth")).toBe(
      "July",
    );
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
    expect(period(aggregate(s, at("2026-08-15T10:00:00")), "lastMonth")).toBe(1_800_000_000);
  });

  it("reports zeros for an empty store rather than raising", () => {
    const a = aggregate(emptyStore(), at("2026-08-28T10:00:00"));
    expect(period(a, "today")).toBe(0);
    expect(period(a, "last7")).toBe(0);
    expect(period(a, "thisMonth")).toBe(0);
    expect(period(a, "lastMonth")).toBe(0);
    expect(a.buckets.every((b) => b.bytes === 0)).toBe(true);
  });

  it("returns the selected period's breakdown for every bucket, largest first", () => {
    const a = aggregate(seed(), at("2026-08-28T18:00:00"), "today");
    expect(a.buckets.length).toBe(BUCKETS.length);
    expect(nth(a, 0).key).toBe("app");
    expect(nth(a, 0).bytes).toBe(5_100_000);
    expect(a.buckets.map((b) => b.bytes)).toEqual(
      [...a.buckets.map((b) => b.bytes)].sort((x, y) => y - x),
    );
  });

  it("marks the compressed streams as modelled and the rest as measured", () => {
    const a = aggregate(seed(), at("2026-08-28T18:00:00"), "today");
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
    expect(period(aggregate(readStore(s), at("2026-08-28T10:00:00")), "today")).toBe(0);
  });
});

describe("committing a window", () => {
  // What diag.js's onWindow actually calls, from the lobby and — relayed over
  // postMessage — from the terminal iframe.
  it("persists a window so the panel can read it back", async () => {
    const s = store();
    await commitWindow({ term: 500, app: 100 }, NET_UNKNOWN, at("2026-08-28T10:00:00"), s);
    expect(period(aggregate(readStore(s), at("2026-08-28T12:00:00")), "today")).toBe(600);
  });

  it("accumulates windows from more than one caller", async () => {
    const s = store();
    await commitWindow({ app: 1_000 }, NET_UNKNOWN, at("2026-08-28T10:00:00"), s);
    await commitWindow({ term: 250 }, NET_UNKNOWN, at("2026-08-28T10:01:00"), s);
    const a = aggregate(readStore(s), at("2026-08-28T12:00:00"));
    expect(period(a, "today")).toBe(1_250);
    expect(a.buckets.find((b) => b.key === "app")?.bytes).toBe(1_000);
    expect(a.buckets.find((b) => b.key === "term")?.bytes).toBe(250);
  });

  it("does not raise when storage refuses", async () => {
    await expect(
      commitWindow({ term: 1 }, NET_UNKNOWN, at("2026-08-28T10:00:00"), throwing),
    ).resolves.toBeUndefined();
  });

  it("serializes concurrent commits rather than losing one", async () => {
    // Several tabs fold into one key. Without the lock this is a read-modify-
    // write race; jsdom has no Web Locks, so this also covers the fallback.
    const s = store();
    await Promise.all(
      Array.from({ length: 20 }, () => commitWindow({ api: 10 }, NET_UNKNOWN, at("2026-08-28T10:00:00"), s)),
    );
    expect(period(aggregate(readStore(s), at("2026-08-28T12:00:00")), "today")).toBe(200);
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
 * The network dimension: which link the bytes crossed. Networks are NAMED, not
 * categorised — an earlier version guessed WiFi against cellular from the
 * operator's name and the guess was the only unreliable part of the feature.
 * Everything asserted here is about a figure a person can act on: nothing lands
 * under a network it did not cross, and nothing goes missing.
 */
describe("usage store — attribution by network", () => {
  it("keeps each network's bytes apart within one day", () => {
    let s = foldInto(emptyStore(), w({ term: 100 }), at("2026-08-28T10:00:00"), NET_LAN);
    s = foldInto(s, w({ term: 40 }), at("2026-08-28T10:01:00"), "as8374");
    expect(dayNet(s, "2026-08-28", NET_LAN).term).toBe(100);
    expect(dayNet(s, "2026-08-28", "as8374").term).toBe(40);
    expect(day(s, "2026-08-28").term).toBe(140);
  });

  it("attributes a window with no stated network to unknown", () => {
    const s = foldInto(emptyStore(), w({ app: 7 }), at("2026-08-28T10:00:00"));
    expect(dayNet(s, "2026-08-28", NET_UNKNOWN).app).toBe(7);
  });

  it("treats an unusable network id as unknown rather than dropping the bytes", () => {
    // A byte that crossed the link is a byte spent, whatever a caller said
    // about the network.
    for (const bad of ["", "Not A Net", "a".repeat(60), 7 as unknown as string]) {
      const s = foldInto(emptyStore(), w({ app: 7 }), at("2026-08-28T10:00:00"), bad);
      expect(day(s, "2026-08-28").app).toBe(7);
      expect(dayNet(s, "2026-08-28", NET_UNKNOWN).app).toBe(7);
    }
  });

  it("lists the networks in a period, largest first, and they add up", () => {
    let s = foldInto(emptyStore(), w({ term: 900 }), at("2026-08-28T10:00:00"), NET_LAN);
    s = foldInto(s, w({ term: 100 }), at("2026-08-28T11:00:00"), "as8374");
    s = foldInto(s, w({ term: 7 }), at("2026-08-28T12:00:00"));
    const a = aggregate(s, at("2026-08-28T18:00:00"), "today");
    expect(a.networks.map((n) => n.id)).toEqual([NET_LAN, "as8374", NET_UNKNOWN]);
    expect(a.networks.reduce((n, r) => n + r.bytes, 0)).toBe(period(a, "today"));
  });

  it("narrows the buckets to one network without moving any period total", () => {
    let s = foldInto(emptyStore(), w({ term: 900, app: 10 }), at("2026-08-28T10:00:00"), NET_LAN);
    s = foldInto(s, w({ term: 100, app: 300 }), at("2026-08-28T11:00:00"), "as8374");
    const bytes = (a: ReturnType<typeof aggregate>, k: Bucket) =>
      a.buckets.find((b) => b.key === k)?.bytes;

    const all = aggregate(s, at("2026-08-28T18:00:00"), "today");
    expect(bytes(all, "term")).toBe(1_000);

    const cell = aggregate(s, at("2026-08-28T18:00:00"), "today", "as8374");
    expect(bytes(cell, "term")).toBe(100);
    expect(bytes(cell, "app")).toBe(300);
    // Largest-first is per selection: on that network it is app that costs.
    expect(nth(cell, 0).key).toBe("app");
    // The headline figures are the same whatever the breakdown shows.
    expect(period(cell, "today")).toBe(period(all, "today"));
  });

  it("narrows to nothing for a network that carried nothing in the period", () => {
    const s = foldInto(emptyStore(), w({ term: 900 }), at("2026-08-28T10:00:00"), NET_LAN);
    const a = aggregate(s, at("2026-08-28T18:00:00"), "today", "as8374");
    expect(a.buckets.every((b) => b.bytes === 0)).toBe(true);
    expect(period(a, "today")).toBe(900);
  });

  it("splits last month too, so a bill can be checked after it arrives", () => {
    let s = foldInto(emptyStore(), w({ term: 2_000 }), at("2026-07-15T10:00:00"), "as8374");
    s = foldInto(s, w({ term: 500 }), at("2026-07-16T10:00:00"), NET_LAN);
    const a = aggregate(s, at("2026-08-28T10:00:00"), "lastMonth");
    expect(a.networks.map((n) => [n.id, n.bytes])).toEqual([
      ["as8374", 2_000],
      [NET_LAN, 500],
    ]);
  });

  it("commits a window under the network the caller was on", async () => {
    const s = store();
    await commitWindow({ term: 500 }, "as8374", at("2026-08-28T10:00:00"), s);
    await commitWindow({ term: 200 }, NET_LAN, at("2026-08-28T10:01:00"), s);
    const a = aggregate(readStore(s), at("2026-08-28T12:00:00"), "today");
    expect(a.networks.find((n) => n.id === "as8374")?.bytes).toBe(500);
    expect(a.networks.find((n) => n.id === NET_LAN)?.bytes).toBe(200);
  });

  it(`folds everything past ${NETWORKS_SHOWN} networks into one Other row`, () => {
    let s = emptyStore();
    // Ten networks, descending, so the fold is unambiguous.
    for (let i = 0; i < 10; i++) {
      s = foldInto(s, w({ term: (10 - i) * 1_000 }), at("2026-08-28T10:00:00"), `as${i}`);
    }
    const a = aggregate(s, at("2026-08-28T18:00:00"), "today");
    expect(a.networks.length).toBe(NETWORKS_SHOWN + 1);
    const other = a.networks[a.networks.length - 1]!;
    expect(other.id).toBe(NET_OTHER);
    // 4 + 3 + 2 + 1 thousand, and it is a sum rather than a network.
    expect(other.bytes).toBe(10_000);
    expect(other.selectable).toBe(false);
    expect(a.networks.reduce((n, r) => n + r.bytes, 0)).toBe(period(a, "today"));
  });

  it("every network is kept in the store even when the panel folds it", () => {
    let s = emptyStore();
    for (let i = 0; i < 10; i++) {
      s = foldInto(s, w({ term: 1 }), at("2026-08-28T10:00:00"), `as${i}`);
    }
    expect(Object.keys(s.days["2026-08-28"] ?? {}).length).toBe(10);
  });
});

describe("naming a network", () => {
  it("names the reserved ones in code, needing no server", () => {
    const s = emptyStore();
    expect(netLabel(s, NET_LAN)).toBe("Home network");
    expect(netLabel(s, NET_UNKNOWN)).toBe("Unknown network");
    expect(netLabel(s, NET_EARLIER)).toBe("Earlier");
  });

  it("uses the operator and its registered country once the server has said", () => {
    const s = rememberNet(emptyStore(), "as8374", { label: "Polkomtel", cc: "PL" });
    expect(netLabel(s, "as8374")).toBe("Polkomtel (PL)");
  });

  it("falls back to the id rather than inventing a name", () => {
    expect(netLabel(emptyStore(), "as8374")).toBe("AS8374");
  });

  it("keeps two unresolved networks apart on screen", () => {
    const s = emptyStore();
    expect(netLabel(s, "ip-7f3a1b2c")).toBe("Unnamed network (7f3a)");
    expect(netLabel(s, "ip-9e4d5c6b")).not.toBe(netLabel(s, "ip-7f3a1b2c"));
  });

  it("survives leaving the network, which is when the row is read", () => {
    let s = rememberNet(emptyStore(), "as8374", { label: "Polkomtel", cc: "PL" });
    s = foldInto(s, w({ term: 10 }), at("2026-07-15T10:00:00"), "as8374");
    // Two months later, somewhere else entirely.
    const a = aggregate(readStore(roundTrip(s)), at("2026-07-20T10:00:00"), "thisMonth");
    expect(a.networks[0]!.label).toBe("Polkomtel (PL)");
  });

  it("keeps the name of the network you are on before its first window folds", () => {
    // The server names a network as soon as you arrive on it, which is before
    // any window has closed. Dropping it in that gap would leave the row
    // reading AS8374 until the next lookup happened to land.
    const s = rememberNet(emptyStore(), "as8374", { label: "Polkomtel", cc: "PL" });
    expect(netLabel(readStore(roundTrip(s)), "as8374")).toBe("Polkomtel (PL)");
  });

  it("forgets a name that is neither referenced nor recently seen", () => {
    let s = rememberNet(emptyStore(), "as8374", { label: "Old café", cc: "FR" }, new Date(0));
    s = rememberNet(s, "as1", { label: "Used", cc: "GB" });
    s = foldInto(s, w({ term: 1 }), at("2026-08-28T10:00:00"), "as1");
    expect(Object.keys(readStore(roundTrip(s)).nets).sort()).toEqual(["as1"]);
  });
});

describe("the resettable period", () => {
  it("accumulates alongside the calendar periods", () => {
    let s = foldInto(emptyStore(), w({ term: 100 }), at("2026-08-28T10:00:00"), NET_LAN);
    s = foldInto(s, w({ term: 40 }), at("2026-08-29T10:00:00"), NET_LAN);
    expect(totalOf(s.since.totals)).toBe(140);
  });

  it("starts when counting started, not when the store was made", () => {
    const s = foldInto(emptyStore(), w({ term: 1 }), at("2026-08-28T10:00:00"));
    expect(s.since.at).toBe(at("2026-08-28T10:00:00").getTime());
    // A later fold does not move the start.
    const later = foldInto(s, w({ term: 1 }), at("2026-08-29T10:00:00"));
    expect(later.since.at).toBe(s.since.at);
  });

  it("zeroes on reset and leaves every other figure standing", async () => {
    const s = store();
    await commitWindow({ term: 1_000 }, NET_LAN, at("2026-08-28T10:00:00"), s);
    await commitResetSince(at("2026-08-28T12:00:00"), s);
    await commitWindow({ term: 25 }, NET_LAN, at("2026-08-28T13:00:00"), s);

    const a = aggregate(readStore(s), at("2026-08-28T18:00:00"), "today");
    expect(period(a, "since")).toBe(25);
    expect(period(a, "today")).toBe(1_025);
    expect(period(a, "thisMonth")).toBe(1_025);
  });

  it("names itself by the date it was reset", () => {
    const s = resetSinceAt(at("2026-08-24T09:12:00"));
    const label = aggregate(s, at("2026-08-28T18:00:00")).periods.find((p) => p.key === "since")!
      .label;
    expect(label).toContain("Since");
    expect(label).toMatch(/24/);
  });
});

describe("usage store — upgrading from the unattributed schemas", () => {
  // Counters written before this existed are kept: someone upgrading mid-month
  // would otherwise lose the month they are in the middle of. They cannot be
  // turned into a network without inventing data, so they say "Earlier".
  const v1 = {
    v: 1,
    days: { "2026-08-28": { term: 900, app: 100, text: 0, files: 0, api: 0 } },
    months: { "2026-08": { term: 900, app: 100, text: 0, files: 0, api: 0 } },
  };
  const v2 = {
    v: 2,
    days: {
      "2026-08-28": {
        wifi: { term: 500, app: 0, text: 0, files: 0, api: 0 },
        cell: { term: 400, app: 0, text: 0, files: 0, api: 0 },
        unknown: { term: 0, app: 100, text: 0, files: 0, api: 0 },
      },
    },
    months: {
      "2026-08": {
        wifi: { term: 500, app: 0, text: 0, files: 0, api: 0 },
        cell: { term: 400, app: 0, text: 0, files: 0, api: 0 },
        unknown: { term: 0, app: 100, text: 0, files: 0, api: 0 },
      },
    },
  };

  it.each([
    ["schema 1", v1],
    ["schema 2", v2],
  ])("lifts %s into Earlier, preserving the totals", (_name, legacy) => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify(legacy));
    const read = readStore(s);
    expect(dayNet(read, "2026-08-28", NET_EARLIER).term).toBe(900);
    expect(day(read, "2026-08-28").app).toBe(100);
    const a = aggregate(read, at("2026-08-28T18:00:00"), "today");
    expect(period(a, "today")).toBe(1_000);
    expect(a.networks.map((n) => n.id)).toEqual([NET_EARLIER]);
  });

  it("writes the new schema back, so the lift happens once", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify(v2));
    writeStore(foldInto(readStore(s), { term: 1 }, at("2026-08-28T12:00:00"), "as8374"), s);
    const raw = JSON.parse(s.getItem(USAGE_STORAGE_KEY) ?? "{}");
    expect(raw.v).toBe(3);
    const read = readStore(s);
    expect(dayNet(read, "2026-08-28", NET_EARLIER).term).toBe(900);
    expect(dayNet(read, "2026-08-28", "as8374").term).toBe(1);
  });

  it("Earlier never grows once real networks are known", () => {
    const s = store();
    s.setItem(USAGE_STORAGE_KEY, JSON.stringify(v2));
    writeStore(foldInto(readStore(s), { term: 5 }, at("2026-08-28T12:00:00"), NET_LAN), s);
    expect(dayNet(readStore(s), "2026-08-28", NET_EARLIER).term).toBe(900);
  });
});
