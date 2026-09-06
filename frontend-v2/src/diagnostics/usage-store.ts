/**
 * Data used, the half that touches the device's store.
 *
 * usage.ts is the arithmetic and this is the persistence, split because they
 * fail differently. Everything here has to survive a payload that is not what
 * it says it is — hand-edited, half-written by a tab that died mid-setItem, or
 * left behind by schema 1 or 2 — and it does that by coercing rather than
 * trusting, so a bad field becomes a zero instead of a NaN that poisons every
 * total downstream. None of the arithmetic needs to know any of that.
 *
 * The key is shared across tabs, so a read-modify-write runs under a Web Lock.
 */

import { localStorageOrNull, type MinStorage } from "../lib/storage";
import {
  BUCKETS,
  NET_EARLIER,
  NET_UNKNOWN,
  SCHEMA_VERSION,
  USAGE_STORAGE_KEY,
  cleanNet,
  emptyStore,
  foldInto,
  pruneNets,
  rememberNet,
  resetSince,
  zeroTotals,
  type BucketTotals,
  type NetMeta,
  type NetTotals,
  type UsageStore,
  type WindowBytes,
} from "./usage";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce one network's stored buckets. A hand-edited or half-written payload
 *  becomes zeroes rather than a source of NaN that would silently poison every
 *  total downstream. */
function readTotals(v: unknown): BucketTotals {
  const totals = zeroTotals();
  if (!isPlainObject(v)) return totals;
  for (const b of BUCKETS) {
    const n = v[b];
    if (typeof n === "number" && Number.isFinite(n) && n > 0) totals[b] = n;
  }
  return totals;
}

function readNetTotals(v: unknown): NetTotals {
  if (!isPlainObject(v)) return {};
  const out: NetTotals = {};
  for (const [id, raw] of Object.entries(v)) {
    if (cleanNet(id) !== id) continue;
    out[id] = readTotals(raw);
  }
  return out;
}

function readMap(v: unknown): Record<string, NetTotals> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, NetTotals> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (isPlainObject(raw)) out[k] = readNetTotals(raw);
  }
  return out;
}

function readNets(v: unknown): Record<string, NetMeta> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, NetMeta> = {};
  for (const [id, raw] of Object.entries(v)) {
    if (cleanNet(id) !== id || !isPlainObject(raw)) continue;
    out[id] = {
      label: typeof raw.label === "string" ? raw.label.slice(0, 60) : "",
      cc: typeof raw.cc === "string" ? raw.cc.slice(0, 4) : "",
      seen: typeof raw.seen === "number" && Number.isFinite(raw.seen) ? raw.seen : 0,
    };
  }
  return out;
}

/**
 * Lift a store written before bytes were attributed to a network.
 *
 * Schema 1 held one flat bucket set per period; schema 2 split it three ways by
 * a WiFi/cellular/unknown kind that no longer exists. Neither can be turned
 * into a network without inventing data, so all of it lands in `earlier` — a
 * row that says plainly "counted before this was measured" rather than a name
 * nobody chose. Discarding it instead would cost whoever upgrades mid-month
 * their month.
 */
function liftLegacyMap(v: unknown, version: number): Record<string, NetTotals> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, NetTotals> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!isPlainObject(raw)) continue;
    const totals = zeroTotals();
    if (version === 1) {
      const t = readTotals(raw);
      for (const b of BUCKETS) totals[b] += t[b];
    } else {
      for (const kind of ["wifi", "cell", "unknown"]) {
        const t = readTotals(raw[kind]);
        for (const b of BUCKETS) totals[b] += t[b];
      }
    }
    out[k] = { [NET_EARLIER]: totals };
  }
  return out;
}

export function readStore(store: MinStorage | null = localStorageOrNull()): UsageStore {
  try {
    const raw = store?.getItem(USAGE_STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return emptyStore();
    if (parsed.v === 1 || parsed.v === 2) {
      const v = parsed.v;
      return {
        ...emptyStore(),
        days: liftLegacyMap(parsed.days, v),
        months: liftLegacyMap(parsed.months, v),
      };
    }
    if (parsed.v !== SCHEMA_VERSION) return emptyStore();
    const since = isPlainObject(parsed.since) ? parsed.since : {};
    return {
      v: SCHEMA_VERSION,
      days: readMap(parsed.days),
      months: readMap(parsed.months),
      nets: readNets(parsed.nets),
      since: {
        at: typeof since.at === "number" && Number.isFinite(since.at) && since.at > 0 ? since.at : 0,
        totals: readNetTotals(since.totals),
      },
    };
  } catch {
    return emptyStore();
  }
}

export function writeStore(
  next: UsageStore,
  store: MinStorage | null = localStorageOrNull(),
): void {
  try {
    store?.setItem(USAGE_STORAGE_KEY, JSON.stringify(pruneNets(next)));
  } catch {
    /* a quota-full or blocked store costs history, not the running counter */
  }
}

export function resetStore(store: MinStorage | null = localStorageOrNull()): void {
  try {
    store?.removeItem(USAGE_STORAGE_KEY);
  } catch {
    /* nothing further to do; the panel will simply keep showing what it has */
  }
}

/**
 * Run a read-modify-write against the store under a cross-tab lock. Several
 * tabs fold into one key, so an unguarded sequence drops whichever writer lost
 * the race. Web Locks is available on every browser this app targets, iOS
 * Safari included; a browser without it falls back to the unguarded path, which
 * can lose a write under concurrent tabs and is acceptable for a diagnostic.
 */
async function locked(
  change: (cur: UsageStore) => UsageStore,
  store: MinStorage | null,
): Promise<void> {
  const apply = () => writeStore(change(readStore(store)), store);
  try {
    const locks = navigator?.locks;
    if (!locks?.request) return void apply();
    await locks.request(USAGE_STORAGE_KEY, apply);
  } catch {
    apply();
  }
}

/** Persist one window's bytes under the network they crossed. */
export function commitWindow(
  w: WindowBytes,
  net: string = NET_UNKNOWN,
  now: Date = new Date(),
  store: MinStorage | null = localStorageOrNull(),
): Promise<void> {
  return locked((cur) => foldInto(cur, w, now, net), store);
}

/** Persist what a network is called, so its row stays readable later. */
export function commitNetName(
  net: string,
  meta: { label?: string; cc?: string },
  now: Date = new Date(),
  store: MinStorage | null = localStorageOrNull(),
): Promise<void> {
  return locked((cur) => rememberNet(cur, net, meta, now), store);
}

/** Rebaseline the resettable period, leaving every other figure standing. */
export function commitResetSince(
  now: Date = new Date(),
  store: MinStorage | null = localStorageOrNull(),
): Promise<void> {
  return locked((cur) => resetSince(cur, now), store);
}

/** Decimal units, because that is how a data plan is billed. */
export function formatBytes(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1_000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} kB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}
