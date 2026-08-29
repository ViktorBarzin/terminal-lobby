/**
 * Which network this device is on, so "Data used" can say where a month went.
 *
 * WHY THE SERVER IS ASKED. The browser cannot answer. Safari has never shipped
 * the Network Information API, so on the iPhone this feature exists for there
 * is nothing to read; where the API does exist it answers a different question
 * badly, reporting effectiveType "4g" on a wired desktop. WebRTC would once
 * have leaked the local address, but host candidates are mDNS-obfuscated in
 * every browser now, and an HTTPS page cannot reach a private address to look
 * around the LAN either. The address a request arrived over is the only signal
 * left, and only the server can see it (tmux-api/netinfo.go).
 *
 * HOW THE ANSWER ARRIVES, TWICE OVER.
 *  - `X-TL-Net` on responses the app already asks for. The lobby polls
 *    /sessions every five seconds, so while anyone is looking at the tab the
 *    answer costs no request of its own and is never more than five seconds
 *    old. That is the hot path.
 *  - `/netinfo`, for a cold tab that has not polled yet and to put a NAME to an
 *    id the header alone does not carry.
 *
 * WHY STALENESS IS A VERDICT. lobby.ts parks the poll entirely while a tab is
 * hidden, and the byte counter deliberately does not pause — a hidden tab that
 * downloaded four megabytes really did spend four megabytes. So a backgrounded
 * phone keeps counting while the answer ages, which is exactly the moment
 * someone walks out of the house onto cellular. Past NETWORK_STALE_MS the
 * network reads as `unknown` rather than as the network last seen: an
 * unattributed row is honest, and one that is quietly wrong is not.
 *
 * WHAT THIS MODULE OWNS. The current network, as module state rather than a
 * store: the fold path that consumes it runs inside a diagnostics callback and
 * inside the terminal iframe's message handler, and neither is a component with
 * access to a context. Every decision here is a pure function over its inputs,
 * so the state is a cache in front of the logic rather than the logic itself.
 */

import { apiUrl } from "../lib/config";
import { NET_UNKNOWN, commitNetName } from "./usage";

/** What the server reports about the network a request came from. */
export interface NetworkInfo {
  /** Stable id: `lan`, `as8374`, or an opaque digest for an address that could
   *  not be resolved. What bytes are stored under. */
  net: string;
  /** The operator, when it is known. Empty until /netinfo has been asked. */
  label: string;
  /** Two-letter country the operator is REGISTERED in — not where the device
   *  is. It is how a person spots at a glance that they are somewhere else. */
  cc: string;
  /** Which of the server's answers this is: a forwarded private address
   *  (certain), a resolved operator, or no answer at all. */
  source: "lan" | "asn" | "none";
}

export const NETWORK_STORAGE_KEY = "tl:net-id:v1";

/**
 * How old an answer may be before a window folds as `unknown`.
 *
 * While a tab is visible the header refreshes every five seconds, so anything
 * older than about half a minute means the tab was backgrounded and the poll
 * was parked. 90 s leaves room for a slow poll or a backoff without letting a
 * whole backgrounded stretch pass as attributed. A starting value, not a
 * measurement: what it should be depends on how much lands in `unknown`.
 */
export const NETWORK_STALE_MS = 90_000;

/** Ids the server can send. Anything else is treated as no answer at all. */
const isNetId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v);

/** Validate-or-drop a `/netinfo` reply. A malformed answer leaves the previous
 *  network in place rather than relabelling traffic from nothing. */
export function parseNetworkInfo(raw: unknown): NetworkInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isNetId(o.net)) return null;
  const source = o.source;
  return {
    net: o.net,
    label: typeof o.label === "string" ? o.label : "",
    cc: typeof o.cc === "string" ? o.cc : "",
    source: source === "lan" || source === "asn" ? source : "none",
  };
}

type MinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): MinStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // partitioned or blocked storage — the network is re-fetched per load
  }
}

/** The last network this device saw. Persisted so a fresh tab has a name to
 *  show immediately, before its first poll answers. */
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
/** When the id was last confirmed by the server. 0 = never. */
let confirmedAt = 0;
let seeded = false;
let inFlight: Promise<NetworkInfo | null> | null = null;
let issued = 0;
const listeners = new Set<(info: NetworkInfo | null) => void>();

/** Seed from storage on first read rather than at import: a module imported by
 *  a test that never touches storage should not have gone looking for it. The
 *  stored network carries NO confirmation time — it names what to display, and
 *  attribution still waits for a live answer. */
function seed(): NetworkInfo | null {
  if (!seeded) {
    seeded = true;
    current = readStoredNetwork();
  }
  return current;
}

/** The network to display: the last one seen, however old. */
export function currentNetwork(): NetworkInfo | null {
  return seed();
}

/** Whether the displayed network is still being confirmed by the server. */
export function networkIsStale(now: number = Date.now()): boolean {
  return now - confirmedAt > NETWORK_STALE_MS;
}

/** The id a window folds under right now. `unknown` whenever the answer has
 *  gone stale — see the staleness note at the top of this file. */
export function currentNetworkId(now: number = Date.now()): string {
  const info = seed();
  if (!info || networkIsStale(now)) return NET_UNKNOWN;
  return info.net;
}

/** Subscribe to network changes; returns the unsubscribe. */
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
 * Record the id stamped on a response the app was making anyway. This is the
 * hot path: cheap, synchronous, and the thing that keeps attribution fresh.
 *
 * A header naming an id we have no name for triggers one /netinfo call to learn
 * it — once per network, not once per poll.
 */
export function noteNetworkId(id: string | null | undefined, now: number = Date.now()): void {
  if (!isNetId(id)) return; // no header on this response: keep what we have
  const known = seed();
  confirmedAt = now;
  if (known?.net === id) return;
  // A new id: keep it usable immediately, and fill the name in behind.
  current = { net: id, label: known?.net === id ? known.label : "", cc: "", source: "none" };
  writeStoredNetwork(current);
  emit();
  if (id !== NET_UNKNOWN) void refreshNetwork({ force: true, now });
}

/**
 * Ask the server directly. Used by a cold tab before its first poll, to put a
 * name to an id, and whenever something says the network has certainly changed.
 *
 * A forced call always goes to the server, even while another is in flight:
 * force means the answer already in flight was asked over a link the device has
 * left. Overlapping requests cannot land out of order — only the newest issue
 * is allowed to write.
 */
export async function refreshNetwork(
  opts: { force?: boolean; now?: number } = {},
): Promise<NetworkInfo | null> {
  const now = opts.now ?? Date.now();
  if (!opts.force && inFlight) return inFlight;
  const mine = ++issued;
  const run = (async () => {
    try {
      const res = await fetch(apiUrl("/netinfo"), { credentials: "same-origin" });
      if (!res.ok) return seed();
      const info = parseNetworkInfo(await res.json());
      // A malformed reply leaves the previous network in place rather than
      // relabelling traffic from nothing; an overtaken one is simply dropped.
      if (!info || mine !== issued) return seed();
      const changed = current?.net !== info.net || current?.label !== info.label;
      current = info;
      confirmedAt = now;
      seeded = true;
      writeStoredNetwork(info);
      // The name has to outlive being on the network: a row for last month's
      // trip is read from somewhere else entirely.
      if (info.label) void commitNetName(info.net, { label: info.label, cc: info.cc });
      if (changed) emit();
      return info;
    } catch {
      // Offline, or the endpoint is not deployed yet. The last known network
      // stays on screen; attribution is governed by staleness, not by this.
      return seed();
    } finally {
      if (mine === issued) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/**
 * Watch for the moments a network can have changed. There is no event for "you
 * left the house", so this listens to the ones that correlate: coming back
 * online, and a tab becoming visible again after the phone was in a pocket.
 * Both matter because the /sessions poll — the hot path — is parked while the
 * tab is hidden, so the first answer after a wake should not wait for it.
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
  const onOnline = () => void refreshNetwork({ force: true });
  const onVisible = () => {
    if (doc?.visibilityState === "visible") void refreshNetwork({ force: true });
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
  confirmedAt = 0;
  seeded = false;
  inFlight = null;
  issued = 0;
  listeners.clear();
}
