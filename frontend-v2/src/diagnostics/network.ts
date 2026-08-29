/**
 * Which network this device is on, so "Data used" can say how much of a month
 * went over cellular — the figure that matters while roaming.
 *
 * WHY THE SERVER IS ASKED. The browser cannot answer. Safari has never shipped
 * the Network Information API, so on the iPhone this feature exists for there
 * is nothing to read; where the API does exist it answers a different question
 * badly, reporting effectiveType "4g" on a wired desktop. The server sees the
 * address the request arrived from, which is the one signal every device has,
 * so `/netinfo` returns what it makes of it (tmux-api/netinfo.go).
 *
 * WHY THE GUESS IS OVERRIDABLE. Most operators sell fixed and mobile access
 * under one name, so the server only claims `cell` on an unambiguous tell and
 * says `unknown` otherwise. A person settles a network in one tap and the
 * correction is kept in their roamed prefs, keyed by network — so it holds
 * across sessions, devices, and the operator's next address change.
 *
 * WHAT THIS MODULE OWNS. The current network and the effective kind, as module
 * state rather than a store: the fold path that consumes it runs inside a
 * diagnostics callback and inside the terminal iframe's message handler, and
 * neither is a component with access to a context. Everything decided here is a
 * pure function taking its inputs, so the state is a cache in front of the
 * logic rather than the logic itself.
 */

import { apiUrl } from "../lib/config";
import { KINDS, type NetKind } from "./usage";

/** What the server reports about the network a request came from. */
export interface NetworkInfo {
  /** Stable name for the network: "lan", "as64501", or an opaque digest. The
   *  key a person's override is stored against. */
  net: string;
  /** The server's guess. Overridden by the person's own answer. */
  kind: NetKind;
  /** The operator, when it is known — "Example Telecom Ltd", "Home network". */
  label: string;
  /** Two-letter country the network is registered in, which is how a person
   *  spots at a glance that they are abroad. */
  cc: string;
  /** Which of the server's three answers this is: a private address (certain),
   *  a resolved operator, or no answer at all. */
  source: "lan" | "asn" | "none";
}

/** A person's own answer for a network. `unknown` is not offered: it is what
 *  the absence of an answer already means, so clearing a correction removes the
 *  entry rather than storing a third value. */
export type NetOverride = "wifi" | "cell";

/** Per-network corrections, keyed by `NetworkInfo.net`. */
export type NetOverrides = Record<string, NetOverride>;

export const NETWORK_STORAGE_KEY = "tl:net-id:v1";

/**
 * How stale the answer may get while a tab is in use. A network changes when
 * someone walks out of the house, which no event reliably announces on iOS, so
 * this is the ceiling on how many bytes can land in the wrong column — at most
 * two minutes of them. The reply is about 120 bytes, so the poll itself costs
 * roughly 12 kB an hour against the gigabytes it is labelling, and it is
 * counted in the `api` bucket like every other request.
 */
export const NETWORK_MAX_AGE_MS = 120_000;

const isKind = (v: unknown): v is NetKind => (KINDS as readonly unknown[]).includes(v);
const isOverride = (v: unknown): v is NetOverride => v === "wifi" || v === "cell";

/** Validate-or-drop a `/netinfo` reply. A malformed answer leaves the previous
 *  network in place rather than relabelling traffic from nothing. */
export function parseNetworkInfo(raw: unknown): NetworkInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.net !== "string" || o.net === "") return null;
  const source = o.source;
  return {
    net: o.net,
    kind: isKind(o.kind) ? o.kind : "unknown",
    label: typeof o.label === "string" ? o.label : "",
    cc: typeof o.cc === "string" ? o.cc : "",
    source: source === "lan" || source === "asn" ? source : "none",
  };
}

/** The kind to attribute bytes to: the person's own answer for this network if
 *  they gave one, else what the server made of it. */
export function effectiveKindOf(
  info: NetworkInfo | null,
  overrides: NetOverrides,
): NetKind {
  if (!info) return "unknown";
  const own = overrides[info.net];
  return isOverride(own) ? own : info.kind;
}

/** Keep only well-formed entries, so a hand-edited prefs doc cannot put a
 *  nonsense kind into the store where it would never aggregate. */
export function coerceOverrides(raw: unknown): NetOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: NetOverrides = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k !== "" && isOverride(v)) out[k] = v;
  }
  return out;
}

type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): MinStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // partitioned or blocked storage — the network is re-fetched per load
  }
}

/** The last network this device saw. Persisted so a fresh tab attributes its
 *  first window to the network it was almost certainly still on, rather than
 *  banking it as unknown while the first request is in flight. */
export function readStoredNetwork(store: MinStorage | null = storage()): NetworkInfo | null {
  try {
    const raw = store?.getItem(NETWORK_STORAGE_KEY);
    return raw ? parseNetworkInfo(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeStoredNetwork(
  info: NetworkInfo,
  store: MinStorage | null = storage(),
): void {
  try {
    store?.setItem(NETWORK_STORAGE_KEY, JSON.stringify(info));
  } catch {
    /* an unstorable network costs the next tab its head start, nothing more */
  }
}

// ---- module state ----------------------------------------------------------

let current: NetworkInfo | null = null;
let overrides: NetOverrides = {};
let lastFetchAt = 0;
let inFlight: Promise<NetworkInfo | null> | null = null;
/** Issue number of the newest request, so a slow earlier answer cannot land on
 *  top of a newer one and relabel traffic with the network you just left. */
let issued = 0;
const listeners = new Set<(info: NetworkInfo | null) => void>();

/** Seed from storage on first read rather than at import: a module imported by
 *  a test that never touches storage should not have gone looking for it. */
function seeded(): NetworkInfo | null {
  if (current === null) current = readStoredNetwork();
  return current;
}

export function currentNetwork(): NetworkInfo | null {
  return seeded();
}

/** The kind every fold is attributed to right now. */
export function currentKind(): NetKind {
  return effectiveKindOf(seeded(), overrides);
}

/** Push the person's corrections in from the prefs store, which owns them. */
export function setNetworkOverrides(raw: unknown): void {
  overrides = coerceOverrides(raw);
  emit();
}

export function networkOverrides(): NetOverrides {
  return { ...overrides };
}

/** Subscribe to network or override changes; returns the unsubscribe. */
export function onNetworkChange(fn: (info: NetworkInfo | null) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn(current);
    } catch {
      /* one bad subscriber must not stop the others hearing about a change */
    }
  }
}

/**
 * Ask the server which network this is.
 *
 * An ordinary call is cheap to make often: it does nothing while the last
 * answer is still fresh, and joins a request already in flight rather than
 * starting a second one. That is the path the visibility trigger takes, and it
 * fires in bursts.
 *
 * A FORCED call always goes to the server, even while another is in flight.
 * Force means something happened that changes the answer — the device came back
 * online, or a person opened Settings to look — and an answer already in flight
 * was asked over the link they have just left. Overlapping requests cannot
 * relabel traffic out of order: only the newest issue is allowed to land.
 */
export async function refreshNetwork(opts: { force?: boolean; now?: number } = {}): Promise<
  NetworkInfo | null
> {
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    if (lastFetchAt > 0 && now - lastFetchAt < NETWORK_MAX_AGE_MS) return seeded();
    if (inFlight) return inFlight;
  }
  lastFetchAt = now;
  const mine = ++issued;
  const run = (async () => {
    try {
      const res = await fetch(apiUrl("/netinfo"), { credentials: "same-origin" });
      if (!res.ok) return seeded();
      const info = parseNetworkInfo(await res.json());
      // A malformed reply leaves the previous network in place rather than
      // relabelling traffic from nothing; an overtaken one is simply dropped.
      if (!info || mine !== issued) return seeded();
      const changed = current?.net !== info.net || current?.kind !== info.kind;
      current = info;
      writeStoredNetwork(info);
      if (changed) emit();
      return info;
    } catch {
      // Offline, or the endpoint is not deployed yet. The last known network
      // stays in force: it is a better guess than unknown, and the bytes that
      // failed to reach the server did not cross a different link.
      return seeded();
    } finally {
      // Only the request that is still the current one clears the slot; an
      // overtaken one leaving would drop a live request from it.
      if (mine === issued) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/**
 * Watch for the moments a network can have changed. There is no event for
 * "you left the house", so this listens to the ones that correlate: coming back
 * online, and a tab becoming visible again after the phone was in a pocket.
 * Both are throttled by refreshNetwork's freshness window.
 *
 * Returns the teardown.
 */
export function startNetworkWatch(
  target: Pick<Window, "addEventListener" | "removeEventListener"> | undefined =
    typeof window === "undefined" ? undefined : window,
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | undefined =
    typeof document === "undefined" ? undefined : document,
): () => void {
  void refreshNetwork({ force: true });
  // Coming back online is the one moment the network has certainly changed.
  const onOnline = () => void refreshNetwork({ force: true });
  const onVisible = () => {
    if (doc?.visibilityState === "visible") void refreshNetwork();
  };
  target?.addEventListener("online", onOnline);
  doc?.addEventListener("visibilitychange", onVisible);
  return () => {
    target?.removeEventListener("online", onOnline);
    doc?.removeEventListener("visibilitychange", onVisible);
  };
}

/** Test seam: forget everything this module has cached. */
export function resetNetworkState(): void {
  current = null;
  overrides = {};
  lastFetchAt = 0;
  inFlight = null;
  issued = 0;
  listeners.clear();
}
