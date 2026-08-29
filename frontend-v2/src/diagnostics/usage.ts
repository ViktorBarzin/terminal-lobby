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
 * WHICH NETWORK THE BYTES CROSSED. Every window is also attributed to a network
 * kind — WiFi, cellular, or unknown — because "3.4 GB this month" answers a
 * different question abroad than at home. The kind comes from network.ts, which
 * asks the server what address the request arrived from; this module only
 * carries the dimension through the arithmetic. `unknown` is a real answer, not
 * a gap to hide: it holds every byte counted before this existed, and every
 * window whose network could not be resolved.
 *
 * WHAT THIS MODULE OWNS. Persistence and arithmetic only: day and month
 * bucketing, pruning, aggregation over periods, and formatting. Measurement
 * lives in frontend/diag.js, which is shared verbatim with term.html so the
 * terminal iframe can count its own WebSocket. Splitting it this way keeps one
 * storage schema, written by whichever tab is folding and read by one panel.
 */

/** The three network kinds a window can be attributed to. `unknown` is not a
 *  failure mode to be designed away: it covers every byte counted before this
 *  attribution existed, plus any window whose network could not be resolved,
 *  and a person reading a cellular figure is entitled to know how much sits
 *  outside it. */
export const KINDS = ["wifi", "cell", "unknown"] as const;
export type NetKind = (typeof KINDS)[number];

/** What the panel is showing: one kind, or everything summed. */
export type UsageFilter = NetKind | "all";

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

/** One period's totals, split by the network the bytes crossed. */
export type KindTotals = Record<NetKind, BucketTotals>;

export interface UsageStore {
  v: 2;
  /** keyed `YYYY-MM-DD`, local time */
  days: Record<string, KindTotals>;
  /** keyed `YYYY-MM`, local time — kept separately so a named calendar month
   *  survives after its daily buckets have aged out. */
  months: Record<string, KindTotals>;
}

/** The storage slot is unchanged across the schema bump on purpose: v1 counters
 *  are lifted into the `unknown` kind on read rather than discarded, so the
 *  month someone is in the middle of survives the upgrade. */
export const USAGE_STORAGE_KEY = "tl:net:v1";
/** Enough to cover a calendar month plus the current one's running days. */
export const DAYS_KEPT = 31;
/** A year of named months, for twelve numbers. */
export const MONTHS_KEPT = 12;

const SCHEMA_VERSION = 2;
/** The shape this store had before bytes were attributed to a network. */
const LEGACY_SCHEMA_VERSION = 1;

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

function zeroKinds(): KindTotals {
  return { wifi: zeroTotals(), cell: zeroTotals(), unknown: zeroTotals() };
}

/** One period's totals with the network split collapsed — what a reader wants
 *  whenever the question is "how much altogether". */
export function combined(k: KindTotals | undefined): BucketTotals {
  const out = zeroTotals();
  if (!k) return out;
  for (const kind of KINDS) {
    for (const b of BUCKETS) out[b] += k[kind][b];
  }
  return out;
}

export function emptyStore(): UsageStore {
  return { v: SCHEMA_VERSION, days: {}, months: {} };
}

/** Keep the newest `keep` keys. Both key formats sort lexicographically in
 *  chronological order, which is the whole reason for those formats. */
function prune(map: Record<string, KindTotals>, keep: number): Record<string, KindTotals> {
  const keys = Object.keys(map).sort();
  if (keys.length <= keep) return map;
  const out: Record<string, KindTotals> = {};
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

const isKind = (v: unknown): v is NetKind => (KINDS as readonly unknown[]).includes(v);

/** Fold a window into one kind's slot, leaving the other two untouched. */
function addKind(into: KindTotals, w: WindowBytes, kind: NetKind): KindTotals {
  return { ...into, [kind]: addWindow(into[kind], w) };
}

/**
 * Fold one window's bytes into the store and prune. Pure: returns a new store
 * rather than mutating, so the locked read-modify-write that persists it stays
 * a thin wrapper around a function that is trivial to test.
 */
export function foldInto(
  store: UsageStore,
  w: WindowBytes,
  now: Date,
  /** Which network the window crossed. Defaults to `unknown` so a caller that
   *  has not learnt the network yet still contributes to the totals — an
   *  unattributed byte is far better than a missing one. */
  kind: NetKind = "unknown",
): UsageStore {
  const dk = dayKey(now);
  const mk = monthKey(now);
  const k = isKind(kind) ? kind : "unknown";
  return {
    v: SCHEMA_VERSION,
    days: prune({ ...store.days, [dk]: addKind(store.days[dk] ?? zeroKinds(), w, k) }, DAYS_KEPT),
    months: prune(
      { ...store.months, [mk]: addKind(store.months[mk] ?? zeroKinds(), w, k) },
      MONTHS_KEPT,
    ),
  };
}

const sum = (t: BucketTotals | undefined): number =>
  t ? BUCKETS.reduce((n, b) => n + t[b], 0) : 0;

/** One period, both as a single figure and split by network. `all` is the sum
 *  of the three and is what the periods read as before anyone filters. */
export interface PeriodTotals {
  all: number;
  wifi: number;
  cell: number;
  unknown: number;
}

const zeroPeriod = (): PeriodTotals => ({ all: 0, wifi: 0, cell: 0, unknown: 0 });

function addPeriod(into: PeriodTotals, k: KindTotals | undefined): PeriodTotals {
  if (!k) return into;
  const next = { ...into };
  for (const kind of KINDS) {
    const n = sum(k[kind]);
    next[kind] += n;
    next.all += n;
  }
  return next;
}


export interface UsageBucket {
  key: Bucket;
  bytes: number;
  /** true where the figure comes from the deflate model rather than
   *  transferSize, which is what earns it a `~` in the panel. */
  modelled: boolean;
}

export interface UsageAggregate {
  today: PeriodTotals;
  last7: PeriodTotals;
  thisMonth: PeriodTotals;
  lastMonth: PeriodTotals;
  /** The name of the month `lastMonth` covers, e.g. "July". */
  lastMonthLabel: string;
  /** Today's breakdown under `filter`, every bucket present, largest first. */
  buckets: UsageBucket[];
  /** Which network the breakdown is showing, echoed back so a caller renders
   *  the control and the bars from one value. */
  filter: UsageFilter;
}

const isModelled = (b: Bucket): boolean => (MODELLED_BUCKETS as readonly string[]).includes(b);

/** Today's bytes in one bucket, under a filter. */
function bucketBytes(k: KindTotals | undefined, b: Bucket, f: UsageFilter): number {
  if (!k) return 0;
  return f === "all" ? combined(k)[b] : k[f][b];
}

/** Every period the panel shows, computed from one store in one pass. Periods
 *  always carry the full split — a filter narrows the BREAKDOWN, never the
 *  four headline figures, so switching it never makes a total appear to move. */
export function aggregate(
  store: UsageStore,
  now: Date,
  filter: UsageFilter = "all",
): UsageAggregate {
  const today = store.days[dayKey(now)];

  let last7 = zeroPeriod();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - i);
    last7 = addPeriod(last7, store.days[dayKey(d)]);
  }

  const prev = new Date(now.getTime());
  // Anchor to the 1st before stepping back, so 31 March does not land in March.
  prev.setDate(1);
  prev.setMonth(prev.getMonth() - 1);

  return {
    today: addPeriod(zeroPeriod(), today),
    last7,
    thisMonth: addPeriod(zeroPeriod(), store.months[monthKey(now)]),
    lastMonth: addPeriod(zeroPeriod(), store.months[monthKey(prev)]),
    // The year is carried whenever it differs from the current one. MONTHS_KEPT
    // spans a year, so a bare "December" read in January names an ambiguous
    // month.
    lastMonthLabel:
      (MONTH_NAMES[prev.getMonth()] ?? "") +
      (prev.getFullYear() === now.getFullYear() ? "" : " " + prev.getFullYear()),
    buckets: BUCKETS.map((key) => ({
      key,
      bytes: bucketBytes(today, key, filter),
      modelled: isModelled(key),
    })).sort((a, b) => b.bytes - a.bytes),
    filter,
  };
}

type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce one period's stored buckets. A hand-edited or half-written payload
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

/** Coerce a stored map to the shape the rest of this module may assume. */
function readMap(v: unknown): Record<string, KindTotals> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, KindTotals> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!isPlainObject(raw)) continue;
    const kinds = zeroKinds();
    for (const kind of KINDS) kinds[kind] = readTotals(raw[kind]);
    out[k] = kinds;
  }
  return out;
}

/** Lift a v1 map — one flat bucket set per period, written before any byte was
 *  attributed to a network — into the `unknown` kind. The alternative was
 *  discarding it, which would have cost whoever upgrades mid-month their month. */
function liftLegacyMap(v: unknown): Record<string, KindTotals> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, KindTotals> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!isPlainObject(raw)) continue;
    out[k] = { ...zeroKinds(), unknown: readTotals(raw) };
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
    if (!isPlainObject(parsed)) return emptyStore();
    if (parsed.v === LEGACY_SCHEMA_VERSION) {
      return {
        v: SCHEMA_VERSION,
        days: liftLegacyMap(parsed.days),
        months: liftLegacyMap(parsed.months),
      };
    }
    if (parsed.v !== SCHEMA_VERSION) return emptyStore();
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
  kind: NetKind = "unknown",
  now: Date = new Date(),
  store: MinStorage | null = storage(),
): Promise<void> {
  const apply = () => writeStore(foldInto(readStore(store), w, now, kind), store);
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
