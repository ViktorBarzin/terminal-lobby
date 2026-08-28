/**
 * Connection diagnostics — measure the link, pick an experience, remember it.
 *
 * WHY THIS MEASURES RATHER THAN ASKS. `navigator.connection` does not exist on
 * iOS: 200 of 200 iPhone diagnostic records carry no `tl.net.*` at all, Safari
 * has never shipped the Network Information API, and there is no
 * `prefers-reduced-data` either. Where it DOES exist it is quantized to 25 kbps
 * / 25 ms steps and reported "4g" on 32-core desktops. On the device this work
 * exists for, it is not an option.
 *
 * What is available costs nothing extra:
 *  - Navigation Timing — how many bytes this document took and how long they
 *    took, which is a throughput measurement of the real link carrying the real
 *    payload. Supported everywhere, including iOS.
 *  - A 55-byte `/whoami`, which is pure round trip.
 *
 * WHY IT PERSISTS. A measurement taken during a load arrives too late to change
 * that load: by the time the numbers exist the bytes are already spent. The
 * verdict is therefore stored per device and applied to the NEXT load, and each
 * load re-measures and updates it. First-ever load gets the full experience,
 * which is the right way round — a fast link must never be punished for being
 * unmeasured.
 *
 * THRESHOLDS ARE STARTING VALUES, not measurements. They are calibrated against
 * the numbers this work was built from (a 400 kbps / 300 ms link as the case to
 * survive) and want re-checking against real devices — see the design doc's open
 * questions.
 */

/** Which experience a client gets. Deliberately two, not five: every lever this
 *  gates is either worth pulling on a bad link or is not. */
export type ConnectionTier = "full" | "slow";

/** What the user asked for, which always wins over what we measured. */
export type TierPreference = ConnectionTier | "auto";

export interface ConnectionSample {
  /** bytes this document actually cost on the wire; 0 when served from cache. */
  navBytes: number;
  /** first byte, from navigation start. */
  ttfbMs: number;
  /** last byte, from navigation start. */
  navEndMs: number;
  /** round trip from a tiny request, when one has been taken. */
  probeMs: number | null;
}

/** Below this, a link is slow. 60 kB/s is ~480 kbps: comfortably above the
 *  400 kbps case being designed for, so that case classifies as slow. */
export const SLOW_THROUGHPUT_BYTES_PER_MS = 60;
/** A round trip this long makes every sequential request hurt, whatever the
 *  bandwidth. Cellular and long-haul both land here. */
export const SLOW_PROBE_MS = 700;
/** Time to first byte this long means the link is struggling before a single
 *  byte of payload has moved. */
export const SLOW_TTFB_MS = 2000;

export const TIER_STORAGE_KEY = "tl:conn-tier:v1";
export const TIER_PREF_STORAGE_KEY = "tl:conn-tier-pref:v1";

/**
 * Classify one sample. Returns null for "no information" — a cached navigation
 * with no probe measures nothing, and guessing from nothing is how a fast link
 * ends up degraded.
 */
export function classify(s: ConnectionSample): ConnectionTier | null {
  if (s.probeMs !== null && s.probeMs >= SLOW_PROBE_MS) return "slow";
  if (s.ttfbMs >= SLOW_TTFB_MS) return "slow";
  // Throughput needs both a real transfer and a measurable download phase. A
  // 304 or a cache hit has neither, and a sub-millisecond download of a few
  // bytes would divide into a nonsense rate.
  const downloadMs = s.navEndMs - s.ttfbMs;
  if (s.navBytes > 8192 && downloadMs >= 20) {
    return s.navBytes / downloadMs < SLOW_THROUGHPUT_BYTES_PER_MS ? "slow" : "full";
  }
  if (s.probeMs !== null) return "full"; // a fast probe, nothing else to go on
  return null;
}

/** Read Navigation Timing for this document. Returns null where it is absent. */
export function sampleNavigation(
  perf: Pick<Performance, "getEntriesByType"> | undefined = typeof performance !==
  "undefined"
    ? performance
    : undefined,
): Omit<ConnectionSample, "probeMs"> | null {
  try {
    const nav = perf?.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return null;
    return {
      navBytes: nav.transferSize || 0,
      ttfbMs: Math.round(nav.responseStart) || 0,
      navEndMs: Math.round(nav.responseEnd) || 0,
    };
  } catch {
    return null;
  }
}

type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): MinStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // partitioned or blocked storage — the feature degrades to per-load
  }
}

const isTier = (v: unknown): v is ConnectionTier => v === "full" || v === "slow";

/** The verdict from a previous load, or null on a first-ever visit. */
export function readStoredTier(store: MinStorage | null = storage()): ConnectionTier | null {
  try {
    const v = store?.getItem(TIER_STORAGE_KEY);
    return isTier(v) ? v : null;
  } catch {
    return null;
  }
}

export function storeTier(tier: ConnectionTier, store: MinStorage | null = storage()): void {
  try {
    store?.setItem(TIER_STORAGE_KEY, tier);
  } catch {
    /* an unstorable verdict costs the next load its head start, nothing more */
  }
}

/** The pin, if the user set one. Device-local on purpose: a pin is a statement
 *  about THIS device's link, and roaming it to a desktop would be wrong. */
export function readTierPreference(store: MinStorage | null = storage()): TierPreference {
  try {
    const v = store?.getItem(TIER_PREF_STORAGE_KEY);
    return isTier(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

export function writeTierPreference(
  pref: TierPreference,
  store: MinStorage | null = storage(),
): void {
  try {
    if (pref === "auto") store?.removeItem(TIER_PREF_STORAGE_KEY);
    else store?.setItem(TIER_PREF_STORAGE_KEY, pref);
  } catch {
    /* nothing to do: the pin simply does not persist */
  }
}

/**
 * Resolve the tier to apply to THIS load: the pin if there is one, else the
 * verdict from last time, else full. Never a fresh measurement — that is not
 * available yet when this is asked.
 */
export function effectiveTier(
  pref: TierPreference = readTierPreference(),
  stored: ConnectionTier | null = readStoredTier(),
): ConnectionTier {
  if (isTier(pref)) return pref;
  return stored ?? "full";
}

/**
 * Measure this load and record the verdict for the next one. Returns what was
 * measured, or null when the load measured nothing (a cache hit with no probe).
 * Safe to call more than once; the last call wins.
 */
export function recordMeasurement(
  probeMs: number | null = null,
  store: MinStorage | null = storage(),
): ConnectionTier | null {
  const nav = sampleNavigation();
  if (!nav) return null;
  const tier = classify({ ...nav, probeMs });
  if (tier) storeTier(tier, store);
  return tier;
}

/** How many turns the Text view opens with. Twenty turns measured 766,661 to
 *  2,098,703 bytes; on a slow link that is up to 42 s of backlog before the
 *  first useful row, and /earlier already exists to page back through. */
export function openWindowTurns(tier: ConnectionTier): number {
  return tier === "slow" ? 4 : 20;
}
