import { describe, it, expect } from "vitest";
import {
  SLOW_PROBE_MS,
  SLOW_THROUGHPUT_BYTES_PER_MS,
  SLOW_TTFB_MS,
  TIER_PREF_STORAGE_KEY,
  TIER_STORAGE_KEY,
  classify,
  effectiveTier,
  openWindowTurns,
  readStoredTier,
  readTierPreference,
  storeTier,
  writeTierPreference,
  type ConnectionSample,
} from "../src/diagnostics/connection";

const sample = (over: Partial<ConnectionSample> = {}): ConnectionSample => ({
  // A healthy home load of the lobby: 1.2 MB in 900 ms.
  navBytes: 1_200_000,
  ttfbMs: 120,
  navEndMs: 1_020,
  probeMs: 40,
  ...over,
});

function store(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/**
 * The verdict has to come from measurement, because the thing that would
 * normally answer it does not exist on the target device: 200 of 200 iPhone
 * diagnostic records carry no navigator.connection at all, Safari has never
 * shipped it, and there is no prefers-reduced-data either.
 */
describe("connection tier — classification", () => {
  it("calls a healthy load full", () => {
    expect(classify(sample())).toBe("full");
  });

  it("calls the 400kbps case slow", () => {
    // 50,000 B/s = 50 B/ms. 1.2 MB therefore takes ~24 s.
    expect(classify(sample({ ttfbMs: 300, navEndMs: 24_300, probeMs: 300 }))).toBe("slow");
  });

  it("calls the real slow attach slow — the one the first threshold missed", () => {
    // Measured from term.ready: 473,998 B in 7,910 ms with a 230 ms first byte,
    // i.e. 61.7 B/ms. The original 60 B/ms threshold sat just underneath it, so
    // the worst load actually observed was handed the full experience.
    expect(
      classify({ navBytes: 473_998, ttfbMs: 230, navEndMs: 7_910, probeMs: null }),
    ).toBe("slow");
  });

  it("leaves the ordinary link alone", () => {
    // The slowest of a dozen ordinary attaches: 474,760 B in 1,111 ms = 537 B/ms.
    expect(
      classify({ navBytes: 474_760, ttfbMs: 228, navEndMs: 1_111, probeMs: null }),
    ).toBe("full");
  });

  it("trusts a slow round trip even when bandwidth looks fine", () => {
    // Long-haul: plenty of throughput, but every sequential request costs.
    expect(classify(sample({ probeMs: SLOW_PROBE_MS }))).toBe("slow");
  });

  it("trusts a slow first byte before any payload has moved", () => {
    expect(classify(sample({ ttfbMs: SLOW_TTFB_MS, probeMs: null }))).toBe("slow");
  });

  it("says nothing when the load measured nothing", () => {
    // A cache hit transfers 0 bytes, so there is no throughput to read. Guessing
    // from nothing is how a fast link ends up degraded.
    expect(classify(sample({ navBytes: 0, probeMs: null }))).toBeNull();
  });

  it("ignores a transfer too small or too quick to divide", () => {
    expect(classify(sample({ navBytes: 300, navEndMs: 121, probeMs: null }))).toBeNull();
  });

  it("puts the boundary where the constant says it is", () => {
    const justUnder = { navBytes: 100_000, ttfbMs: 0, navEndMs: 0, probeMs: null };
    justUnder.navEndMs = Math.ceil(100_000 / (SLOW_THROUGHPUT_BYTES_PER_MS - 1));
    expect(classify(justUnder)).toBe("slow");
    const justOver = { ...justUnder };
    justOver.navEndMs = Math.floor(100_000 / (SLOW_THROUGHPUT_BYTES_PER_MS + 1));
    expect(classify(justOver)).toBe("full");
  });
});

describe("connection tier — what THIS load applies", () => {
  it("uses the full experience on a first-ever visit", () => {
    // A fast link must never be punished for being unmeasured.
    expect(effectiveTier("auto", null)).toBe("full");
  });

  it("applies the verdict from last time, since measuring comes too late", () => {
    expect(effectiveTier("auto", "slow")).toBe("slow");
  });

  it("lets a pin win over any measurement", () => {
    expect(effectiveTier("full", "slow")).toBe("full");
    expect(effectiveTier("slow", "full")).toBe("slow");
  });
});

describe("connection tier — storage", () => {
  it("round-trips a verdict", () => {
    const s = store();
    expect(readStoredTier(s)).toBeNull();
    storeTier("slow", s);
    expect(readStoredTier(s)).toBe("slow");
    expect(s.getItem(TIER_STORAGE_KEY)).toBe("slow");
  });

  it("round-trips a pin, and clears it back to auto", () => {
    const s = store();
    expect(readTierPreference(s)).toBe("auto");
    writeTierPreference("slow", s);
    expect(readTierPreference(s)).toBe("slow");
    writeTierPreference("auto", s);
    expect(s.getItem(TIER_PREF_STORAGE_KEY)).toBeNull();
    expect(readTierPreference(s)).toBe("auto");
  });

  it("ignores a stored value that is not a tier", () => {
    const s = store();
    s.setItem(TIER_STORAGE_KEY, "turbo");
    expect(readStoredTier(s)).toBeNull();
  });

  it("survives storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("partitioned");
      },
      setItem: () => {
        throw new Error("partitioned");
      },
      removeItem: () => {
        throw new Error("partitioned");
      },
    };
    expect(readStoredTier(throwing)).toBeNull();
    expect(readTierPreference(throwing)).toBe("auto");
    expect(() => storeTier("slow", throwing)).not.toThrow();
    expect(effectiveTier("auto", readStoredTier(throwing))).toBe("full");
  });
});

describe("connection tier — the levers it drives", () => {
  it("opens the Text view on fewer turns when the link is slow", () => {
    // 20 turns measured 766,661-2,098,703 bytes per open, up to 42 s at 400kbps.
    expect(openWindowTurns("full")).toBe(20);
    expect(openWindowTurns("slow")).toBeLessThan(20);
    expect(openWindowTurns("slow")).toBeGreaterThan(0);
  });
});
