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
 * WHICH NETWORK THE BYTES CROSSED. Every window is attributed to the network it
 * went over, because "3.4 GB this month" answers a different question abroad
 * than at home. Networks are NAMED, not categorised: the server identifies the
 * operator exactly, from the routing table, and nothing here guesses whether
 * that operator is WiFi or cellular — an earlier version did, and the guess was
 * the only unreliable part of the whole feature. A reader knows which row is
 * their SIM; a heuristic on the operator's name does not.
 *
 * TWO KINDS OF "WE DON'T KNOW", KEPT APART. `unknown` is traffic counted while
 * no fresh answer was available — a backgrounded tab, mostly — and it stops
 * growing the moment someone looks at the tab again. `earlier` is traffic
 * counted before any of this was measured; it never grows and ages out with
 * everything else. Both sit in the totals and in neither named network.
 *
 * WHAT THIS MODULE OWNS. Persistence and arithmetic only: day, month and
 * network bucketing, pruning, aggregation over periods, and formatting. Which
 * network is current lives in network.ts; measurement lives in
 * frontend/diag.js, shared verbatim with term.html so the terminal iframe can
 * count its own WebSocket.
 */

/** The five feature buckets the panel reports, each named after something that
 *  could be changed rather than after an endpoint. */
export const BUCKETS = ["term", "app", "text", "files", "api"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** The buckets whose bytes are modelled rather than measured, because the
 *  server compresses them and the browser hands the app the inflated form. */
export const MODELLED_BUCKETS = ["term", "text"] as const;

/** Network ids that are not operators. Everything else is `lan`, `as<n>` or an
 *  `ip-<digest>` the server minted for an address it could not resolve. */
export const NET_LAN = "lan";
export const NET_UNKNOWN = "unknown";
export const NET_EARLIER = "earlier";
/** Not stored — the row the panel folds everything past the display cap into. */
export const NET_OTHER = "other";

/** What one rollup window contributed, per bucket. Partial: a window in which
 *  nobody opened a file simply has no `files` key. */
export type WindowBytes = Partial<Record<Bucket, number>>;

/** Totals for one network over one period. Always complete, so a reader never
 *  has to decide what a missing bucket means. */
export type BucketTotals = Record<Bucket, number>;

/** One period's totals, split by the network the bytes crossed. Sparse: a day
 *  holds only the networks that carried something. */
export type NetTotals = Record<string, BucketTotals>;

/** What a network is called, so a row stays readable after you have left it.
 *  The server hands these over; nothing here invents one. */
export interface NetMeta {
  label: string;
  /** Two-letter country the operator is registered in. Registration, not
   *  location: it says where the AS is registered, not where the phone is. */
  cc: string;
  seen: number;
}

export interface UsageStore {
  v: 3;
  /** keyed `YYYY-MM-DD`, local time */
  days: Record<string, NetTotals>;
  /** keyed `YYYY-MM`, local time — kept separately so a named calendar month
   *  survives after its daily buckets have aged out. */
  months: Record<string, NetTotals>;
  /** Directory of network names, pruned to what the periods still reference. */
  nets: Record<string, NetMeta>;
  /** The one period a person controls: `at` is when they last reset it, and
   *  `totals` accumulates independently of the calendar ones. Accumulated
   *  rather than derived, because days age out at 31 and a reset can sit
   *  anywhere inside a day. */
  since: { at: number; totals: NetTotals };
}

/** The storage slot has not changed across either schema bump: what is stored
 *  is upgraded on read rather than discarded, so nobody loses the month they
 *  are in the middle of. */
export const USAGE_STORAGE_KEY = "tl:net:v1";
/** Enough to cover a calendar month plus the current one's running days. */
export const DAYS_KEPT = 31;
/** A year of named months, for twelve numbers. */
export const MONTHS_KEPT = 12;
/** Networks listed before the rest fold into one Other row. Six fits a phone
 *  and covers a trip; the store keeps every network regardless. */
export const NETWORKS_SHOWN = 6;

const SCHEMA_VERSION = 3;

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
  return { v: SCHEMA_VERSION, days: {}, months: {}, nets: {}, since: { at: 0, totals: {} } };
}

/** One period's totals with the network split collapsed — what a reader wants
 *  whenever the question is "how much altogether". */
export function combined(n: NetTotals | undefined): BucketTotals {
  const out = zeroTotals();
  if (!n) return out;
  for (const totals of Object.values(n)) {
    for (const b of BUCKETS) out[b] += totals[b];
  }
  return out;
}

const sumBuckets = (t: BucketTotals | undefined): number =>
  t ? BUCKETS.reduce((n, b) => n + t[b], 0) : 0;

/** Bytes across every network in one period. */
export const totalOf = (n: NetTotals | undefined): number => sumBuckets(combined(n));

/** Keep the newest `keep` keys. Both key formats sort lexicographically in
 *  chronological order, which is the whole reason for those formats. */
function prune(map: Record<string, NetTotals>, keep: number): Record<string, NetTotals> {
  const keys = Object.keys(map).sort();
  if (keys.length <= keep) return map;
  const out: Record<string, NetTotals> = {};
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

/** Fold a window into one network's slot, leaving every other network alone. */
function addNet(into: NetTotals, w: WindowBytes, net: string): NetTotals {
  return { ...into, [net]: addWindow(into[net] ?? zeroTotals(), w) };
}

/** A network id we are willing to store. Anything else — an empty string, a
 *  value from a hand-edited store — becomes `unknown` rather than minting a row
 *  nobody can read. */
const cleanNet = (net: unknown): string =>
  typeof net === "string" && /^[a-z0-9-]{1,40}$/.test(net) ? net : NET_UNKNOWN;

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
  net: string = NET_UNKNOWN,
): UsageStore {
  const dk = dayKey(now);
  const mk = monthKey(now);
  const id = cleanNet(net);
  return {
    v: SCHEMA_VERSION,
    days: prune({ ...store.days, [dk]: addNet(store.days[dk] ?? {}, w, id) }, DAYS_KEPT),
    months: prune({ ...store.months, [mk]: addNet(store.months[mk] ?? {}, w, id) }, MONTHS_KEPT),
    nets: store.nets,
    since: {
      // Stamped on the first fold rather than at construction, so the row reads
      // "since counting started" for someone who has never reset it.
      at: store.since.at || now.getTime(),
      totals: addNet(store.since.totals, w, id),
    },
  };
}

/** Record what a network is called. Names arrive from the server long after
 *  bytes have been folded under the id, and a row has to stay readable once you
 *  are somewhere else entirely. */
export function rememberNet(
  store: UsageStore,
  net: string,
  meta: { label?: string; cc?: string },
  now: Date = new Date(),
): UsageStore {
  const id = cleanNet(net);
  if (id === NET_UNKNOWN || id === NET_LAN) return store; // both are named in code
  return {
    ...store,
    nets: {
      ...store.nets,
      [id]: {
        label: typeof meta.label === "string" ? meta.label.slice(0, 60) : "",
        cc: typeof meta.cc === "string" ? meta.cc.slice(0, 4) : "",
        seen: now.getTime(),
      },
    },
  };
}

/** Clear the resettable period without touching any other figure. */
export function resetSince(store: UsageStore, now: Date = new Date()): UsageStore {
  return { ...store, since: { at: now.getTime(), totals: {} } };
}

/**
 * Drop directory entries nothing references any more, so the store does not
 * accumulate the name of every café you have ever sat in.
 *
 * "References" includes recently seen, not only carrying bytes: the name of the
 * network you are on now arrives from the server BEFORE the first window folds
 * under it, and dropping it in that gap would leave the row reading `AS8374`
 * until the next lookup happened to land. The window matches the daily one, so
 * a name outlives the bytes it belongs to by exactly as long as they last.
 */
function pruneNets(store: UsageStore, now: number = Date.now()): UsageStore {
  const live = new Set<string>();
  for (const map of [store.days, store.months]) {
    for (const period of Object.values(map)) for (const id of Object.keys(period)) live.add(id);
  }
  for (const id of Object.keys(store.since.totals)) live.add(id);
  const keepSince = now - DAYS_KEPT * 24 * 60 * 60 * 1000;
  const nets: Record<string, NetMeta> = {};
  for (const [id, meta] of Object.entries(store.nets)) {
    if (live.has(id) || meta.seen >= keepSince) nets[id] = meta;
  }
  return { ...store, nets };
}

// ---- reading -----------------------------------------------------------------

/** The periods the panel offers, in the order it shows them. */
export const PERIODS = ["today", "last7", "thisMonth", "lastMonth", "since"] as const;
export type PeriodKey = (typeof PERIODS)[number];

export interface PeriodRow {
  key: PeriodKey;
  label: string;
  bytes: number;
}

export interface NetworkRow {
  id: string;
  label: string;
  bytes: number;
  /** false for the folded Other row, which is a sum rather than a network. */
  selectable: boolean;
}

export interface UsageBucket {
  key: Bucket;
  bytes: number;
  /** true where the figure comes from the deflate model rather than
   *  transferSize, which is what earns it a `~` in the panel. */
  modelled: boolean;
}

export interface UsageAggregate {
  periods: PeriodRow[];
  /** Networks in the selected period, largest first, capped and folded. */
  networks: NetworkRow[];
  /** Buckets for the selected period, narrowed to the selected network. */
  buckets: UsageBucket[];
  period: PeriodKey;
  /** null = every network in the period. */
  net: string | null;
  /** When the resettable period started; 0 before anything was counted. */
  sinceAt: number;
}

const isModelled = (b: Bucket): boolean => (MODELLED_BUCKETS as readonly string[]).includes(b);

function mergeNetTotals(into: NetTotals, from: NetTotals | undefined): NetTotals {
  if (!from) return into;
  const out = { ...into };
  for (const [id, totals] of Object.entries(from)) {
    out[id] = addWindow(out[id] ?? zeroTotals(), totals);
  }
  return out;
}

/** One period's per-network totals, whichever period it is. */
export function periodTotals(store: UsageStore, now: Date, key: PeriodKey): NetTotals {
  if (key === "today") return store.days[dayKey(now)] ?? {};
  if (key === "since") return store.since.totals;
  if (key === "thisMonth") return store.months[monthKey(now)] ?? {};
  if (key === "lastMonth") return store.months[monthKey(previousMonth(now))] ?? {};
  let out: NetTotals = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - i);
    out = mergeNetTotals(out, store.days[dayKey(d)]);
  }
  return out;
}

function previousMonth(now: Date): Date {
  const prev = new Date(now.getTime());
  // Anchor to the 1st before stepping back, so 31 March does not land in March.
  prev.setDate(1);
  prev.setMonth(prev.getMonth() - 1);
  return prev;
}

/** The name of the month `lastMonth` covers. The year is carried whenever it
 *  differs from the current one: MONTHS_KEPT spans a year, so a bare "December"
 *  read in January names an ambiguous month. */
export function lastMonthLabel(now: Date): string {
  const prev = previousMonth(now);
  return (
    (MONTH_NAMES[prev.getMonth()] ?? "") +
    (prev.getFullYear() === now.getFullYear() ? "" : " " + prev.getFullYear())
  );
}

const shortDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** What a network is called on screen. Reserved ids are named in code; an
 *  operator uses the directory, and falls back to its own id rather than to a
 *  name nobody supplied. */
export function netLabel(store: UsageStore, id: string): string {
  if (id === NET_LAN) return "Home network";
  if (id === NET_UNKNOWN) return "Unknown network";
  if (id === NET_EARLIER) return "Earlier";
  if (id === NET_OTHER) return "Other";
  const meta = store.nets[id];
  if (meta?.label) return meta.cc ? `${meta.label} (${meta.cc})` : meta.label;
  // An address the server could not resolve still gets a distinct row; the
  // digest tail keeps two of them apart on screen.
  if (id.startsWith("ip-")) return `Unnamed network (${id.slice(3, 7)})`;
  return id.toUpperCase();
}

function networkRows(store: UsageStore, totals: NetTotals): NetworkRow[] {
  const rows = Object.entries(totals)
    .map(([id, t]) => ({ id, label: netLabel(store, id), bytes: sumBuckets(t), selectable: true }))
    .filter((r) => r.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  if (rows.length <= NETWORKS_SHOWN) return rows;
  const shown = rows.slice(0, NETWORKS_SHOWN);
  const rest = rows.slice(NETWORKS_SHOWN);
  shown.push({
    id: NET_OTHER,
    label: `Other (${rest.length} networks)`,
    bytes: rest.reduce((n, r) => n + r.bytes, 0),
    selectable: false,
  });
  return shown;
}

/**
 * Everything the panel shows, computed from one store in one pass. The period
 * scopes both the network rows and the buckets; the network narrows the buckets
 * further. Period totals are never narrowed — switching the breakdown must not
 * make a figure someone just read appear to move.
 */
export function aggregate(
  store: UsageStore,
  now: Date,
  period: PeriodKey = "thisMonth",
  net: string | null = null,
): UsageAggregate {
  const selected = periodTotals(store, now, period);
  const networks = networkRows(store, selected);
  // A network that has dropped out of the selected period (a trip you are
  // reading a later month for) narrows to nothing rather than to everything.
  const scoped =
    net === null ? combined(selected) : (selected[net] ?? zeroTotals());

  return {
    periods: PERIODS.map((key) => ({
      key,
      label:
        key === "today"
          ? "Today"
          : key === "last7"
            ? "Last 7 days"
            : key === "thisMonth"
              ? "This month"
              : key === "lastMonth"
                ? lastMonthLabel(now)
                : store.since.at
                  ? `Since ${shortDate(store.since.at)}`
                  : "Since reset",
      bytes: totalOf(periodTotals(store, now, key)),
    })),
    networks,
    buckets: BUCKETS.map((key) => ({
      key,
      bytes: scoped[key],
      modelled: isModelled(key),
    })).sort((a, b) => b.bytes - a.bytes),
    period,
    net,
    sinceAt: store.since.at,
  };
}

// ---- persistence -------------------------------------------------------------

type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

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

export function readStore(store: MinStorage | null = storage()): UsageStore {
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

function storage(): MinStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // partitioned or blocked storage — the feature degrades to this page life
  }
}

export function writeStore(next: UsageStore, store: MinStorage | null = storage()): void {
  try {
    store?.setItem(USAGE_STORAGE_KEY, JSON.stringify(pruneNets(next)));
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
  store: MinStorage | null = storage(),
): Promise<void> {
  return locked((cur) => foldInto(cur, w, now, net), store);
}

/** Persist what a network is called, so its row stays readable later. */
export function commitNetName(
  net: string,
  meta: { label?: string; cc?: string },
  now: Date = new Date(),
  store: MinStorage | null = storage(),
): Promise<void> {
  return locked((cur) => rememberNet(cur, net, meta, now), store);
}

/** Rebaseline the resettable period, leaving every other figure standing. */
export function commitResetSince(
  now: Date = new Date(),
  store: MinStorage | null = storage(),
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
