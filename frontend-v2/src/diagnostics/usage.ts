/**
 * Data used — what Terminal Lobby cost this device, in bytes that crossed the
 * link (docs/adr/0008-client-diagnostics.md is the channel this rides on).
 *
 * WHY THIS EXISTS. The app was measured moving ~1.83 GB in 24 hours from one
 * iPhone, and that only became visible through an offline reading of Traefik
 * access logs and Loki. From inside the app there was no number at all, so
 * "is the lobby what ate my allowance" had no answer on the device it was
 * being asked about.
 *
 * WHAT A NUMBER HERE MEANS. Wire bytes: what travelled, after compression.
 * Three of the five buckets are measured exactly from Navigation and Resource
 * Timing, whose transferSize is post-compression and includes response headers.
 * The other two carry streams the server compresses and the browser inflates
 * before any API can observe them — the ttyd WebSocket (permessage-deflate with
 * context takeover) and the session-events SSE stream (gzip with a per-event
 * sync flush). Those two are modelled by diag.js compressing the same bytes the
 * same way, and are marked as modelled everywhere they are shown.
 *
 * WHY THE MODEL RATHER THAN THE OBVIOUS NUMBER. diag.js has always recorded
 * tl.ws.in_b, but that is counted after the browser inflates the frame.
 * Measured against real pane content shaped as a stream, the wire carries about
 * 13.6x less; a static capture gives 2.6x and a redraw-heavy turn far more.
 * Presenting the decompressed figure as data use would overstate the largest
 * bucket by an unpredictable factor.
 *
 * WHAT THIS MODULE OWNS. Persistence and arithmetic only: day and month
 * bucketing, pruning, aggregation over periods, and formatting. Measurement
 * lives in frontend/diag.js, which is shared verbatim with term.html so the
 * terminal iframe can count its own WebSocket. Splitting it this way keeps one
 * storage schema, written by whichever tab is folding and read by one panel.
 */

/** The five feature buckets the panel reports, each named after something that
 *  could be changed rather than after an endpoint. */
export const BUCKETS = ["term", "app", "text", "files", "api"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** The buckets whose bytes are modelled rather than measured, because the
 *  server compresses them and the browser hands the app the inflated form. */
export const MODELLED_BUCKETS = ["term", "text"] as const;

/** What one rollup window contributed, per bucket. Partial: a window in which
 *  nobody opened a file simply has no `files` key. */
export type WindowBytes = Partial<Record<Bucket, number>>;

/** Totals for one day or one month. Always complete, so a reader never has to
 *  decide what a missing bucket means. */
export type BucketTotals = Record<Bucket, number>;

export interface UsageStore {
  v: 1;
  /** keyed `YYYY-MM-DD`, local time */
  days: Record<string, BucketTotals>;
  /** keyed `YYYY-MM`, local time — kept separately so a named calendar month
   *  survives after its daily buckets have aged out. */
  months: Record<string, BucketTotals>;
}

export const USAGE_STORAGE_KEY = "tl:net:v1";
/** Enough to cover a calendar month plus the current one's running days. */
export const DAYS_KEPT = 31;
/** A year of named months, for twelve numbers. */
export const MONTHS_KEPT = 12;

const SCHEMA_VERSION = 1;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Local, not UTC: "today" means the day the person is having. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function zeroTotals(): BucketTotals {
  return { term: 0, app: 0, text: 0, files: 0, api: 0 };
}

export function emptyStore(): UsageStore {
  return { v: SCHEMA_VERSION, days: {}, months: {} };
}

/** Keep the newest `keep` keys. Both key formats sort lexicographically in
 *  chronological order, which is the whole reason for those formats. */
function prune(map: Record<string, BucketTotals>, keep: number): Record<string, BucketTotals> {
  const keys = Object.keys(map).sort();
  if (keys.length <= keep) return map;
  const out: Record<string, BucketTotals> = {};
  for (const k of keys.slice(keys.length - keep)) {
    const totals = map[k];
    if (totals) out[k] = totals;
  }
  return out;
}

function addWindow(into: BucketTotals, w: WindowBytes): BucketTotals {
  const next = { ...into };
  for (const b of BUCKETS) {
    const v = w[b];
    // A count that is missing, not a number, or negative contributes nothing.
    // Diagnostics must never be able to make a total go backwards.
    if (typeof v === "number" && Number.isFinite(v) && v > 0) next[b] += v;
  }
  return next;
}

/**
 * Fold one window's bytes into the store and prune. Pure: returns a new store
 * rather than mutating, so the locked read-modify-write that persists it stays
 * a thin wrapper around a function that is trivial to test.
 */
export function foldInto(store: UsageStore, w: WindowBytes, now: Date): UsageStore {
  const dk = dayKey(now);
  const mk = monthKey(now);
  return {
    v: SCHEMA_VERSION,
    days: prune({ ...store.days, [dk]: addWindow(store.days[dk] ?? zeroTotals(), w) }, DAYS_KEPT),
    months: prune(
      { ...store.months, [mk]: addWindow(store.months[mk] ?? zeroTotals(), w) },
      MONTHS_KEPT,
    ),
  };
}

const sum = (t: BucketTotals | undefined): number =>
  t ? BUCKETS.reduce((n, b) => n + t[b], 0) : 0;

export interface UsageBucket {
  key: Bucket;
  bytes: number;
  /** true where the figure comes from the deflate model rather than
   *  transferSize, which is what earns it a `~` in the panel. */
  modelled: boolean;
}

export interface UsageAggregate {
  today: number;
  last7: number;
  thisMonth: number;
  lastMonth: number;
  /** The name of the month `lastMonth` covers, e.g. "July". */
  lastMonthLabel: string;
  /** Today's breakdown, every bucket present, largest first. */
  buckets: UsageBucket[];
}

const isModelled = (b: Bucket): boolean => (MODELLED_BUCKETS as readonly string[]).includes(b);

/** Every period the panel shows, computed from one store in one pass. */
export function aggregate(store: UsageStore, now: Date): UsageAggregate {
  const today = store.days[dayKey(now)];

  let last7 = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - i);
    last7 += sum(store.days[dayKey(d)]);
  }

  const prev = new Date(now.getTime());
  // Anchor to the 1st before stepping back, so 31 March does not land in March.
  prev.setDate(1);
  prev.setMonth(prev.getMonth() - 1);

  return {
    today: sum(today),
    last7,
    thisMonth: sum(store.months[monthKey(now)]),
    lastMonth: sum(store.months[monthKey(prev)]),
    // The year is carried whenever it differs from the current one. MONTHS_KEPT
    // spans a year, so a bare "December" read in January names an ambiguous
    // month.
    lastMonthLabel:
      (MONTH_NAMES[prev.getMonth()] ?? "") +
      (prev.getFullYear() === now.getFullYear() ? "" : " " + prev.getFullYear()),
    buckets: BUCKETS.map((key) => ({
      key,
      bytes: today ? today[key] : 0,
      modelled: isModelled(key),
    })).sort((a, b) => b.bytes - a.bytes),
  };
}

type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a stored map to the shape the rest of this module may assume. A
 *  hand-edited or half-written payload becomes an empty map rather than a
 *  source of NaN that would silently poison every total downstream. */
function readMap(v: unknown): Record<string, BucketTotals> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, BucketTotals> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!isPlainObject(raw)) continue;
    const totals = zeroTotals();
    for (const b of BUCKETS) {
      const n = raw[b];
      if (typeof n === "number" && Number.isFinite(n) && n > 0) totals[b] = n;
    }
    out[k] = totals;
  }
  return out;
}

function storage(): MinStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // partitioned or blocked storage — the feature degrades to this page life
  }
}

export function readStore(store: MinStorage | null = storage()): UsageStore {
  try {
    const raw = store?.getItem(USAGE_STORAGE_KEY);
    if (!raw) return emptyStore();
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.v !== SCHEMA_VERSION) return emptyStore();
    return { v: SCHEMA_VERSION, days: readMap(parsed.days), months: readMap(parsed.months) };
  } catch {
    return emptyStore();
  }
}

export function writeStore(next: UsageStore, store: MinStorage | null = storage()): void {
  try {
    store?.setItem(USAGE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* a quota-full or blocked store costs history, not the running counter */
  }
}

export function resetStore(store: MinStorage | null = storage()): void {
  try {
    store?.removeItem(USAGE_STORAGE_KEY);
  } catch {
    /* nothing further to do; the panel will simply keep showing what it has */
  }
}

/**
 * Persist one window under a cross-tab lock. Several tabs fold into one key, so
 * an unguarded read-modify-write drops whichever window lost the race. Web
 * Locks is available on every browser this app targets, iOS Safari included; a
 * browser without it falls back to the unguarded path, which can lose a window
 * under concurrent tabs and is acceptable for a diagnostic.
 */
export async function commitWindow(
  w: WindowBytes,
  now: Date = new Date(),
  store: MinStorage | null = storage(),
): Promise<void> {
  const apply = () => writeStore(foldInto(readStore(store), w, now), store);
  try {
    const locks = navigator?.locks;
    if (!locks?.request) return void apply();
    await locks.request(USAGE_STORAGE_KEY, apply);
  } catch {
    apply();
  }
}

/** Decimal units, because that is how a data plan is billed. */
export function formatBytes(n: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1_000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)} kB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}
