/**
 * Service-worker registration + the notification-tap handoff PAGE half
 * (inventory Cat.9). The (verbatim) public/sw.js is push-only — it shows Web
 * Push notifications, routes a tap back into the app, and keeps the server's
 * subscription list current. This module is its counterpart in the lobby
 * document:
 *
 *   - registers `/sw.js` on boot (failure never breaks boot: the route 404s
 *     until the PWA asset carve-out ships, and some browsers lack SWs entirely);
 *   - listens on `navigator.serviceWorker` (NOT window — a SW→page message lands
 *     there) for the `tl-activate-session` the SW posts on a notification tap,
 *     validates the name, and switches the app to it (the resident-PWA
 *     "focus-without-switch" fix);
 *   - reads+consumes the IndexedDB stash the SW writes for the iOS killed-PWA
 *     cold-launch path (which fires no notificationclick).
 *
 * SW-backed notifications are preferred over the bare `Notification` constructor
 * (Android Chrome requires them), so `deliverable()` reports whether ANYTHING
 * can show a notification here.
 */
import { NAME_RE } from "../types/lobby";

/**
 * The stash the SW writes: db 'tl-notif' v1, store 'pending'.
 *
 * ONE RECORD PER SESSION, keyed by the session name. It was a single 'last'
 * slot, and with several notifications outstanding each push overwrote the one
 * before it — so tapping the oldest banner routed to the newest push's session,
 * or, when that happened to be the session already on screen, did nothing at
 * all. Measured on Viktor's phone 2026-09-02: pushes for issues, cache-omages
 * and ux landed within 80 s, he tapped one, and the read came back `already`
 * because the slot held `ux` and `ux` was what he was looking at.
 *
 * `last` is still written by sw.js and still read here, so a page and a worker
 * from different deploys keep working.
 */
export interface PendingNotif {
  session: string;
  ts: number;
  /** true when sw.js wrote it from an actual notificationclick, not push receipt. */
  tapped?: boolean;
}

/**
 * 2 min: wide enough for a realistic tap→cold-launch, tight enough that a plain
 * icon launch rarely falls inside a stale stash window (a push-time record is the
 * RECEIPT, not the tap — a guess that the user is about to act on it).
 */
export const PENDING_NOTIF_TTL_MS = 120 * 1000;

/**
 * The outer window a stash may still land a launch on (15 min). It covers the two
 * cases where a receipt's 2 min is simply wrong:
 *   - `tapped:true` — sw.js routed an actual click here (its openWindow branch),
 *     so intent is certain and only the launch is pending;
 *   - a receipt whose notification is NO LONGER DISPLAYED. Viktor's case: a push
 *     arrives, the phone stays locked, and the banner is tapped twenty minutes
 *     later — far outside 2 min, so boot ignored it and landed on the last-active
 *     session instead of the one that called. iOS clears a notification when it is
 *     tapped, so "stash present + banner gone" reads that tap after the fact;
 *     while the banner still sits there untapped, an icon launch must NOT jump.
 */
export const STASH_MAX_AGE_MS = 15 * 60 * 1000;

/** How many notifications carrying `tag` are still displayed; null = unknowable. */
async function displayedForTag(tag: string): Promise<number | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg?.getNotifications) return null;
  return (await reg.getNotifications({ tag })).length;
}

/**
 * Is a stashed record still worth landing the launch on? Conservative on every
 * unknown: an unreadable registration must never become a jump the user did not
 * ask for. `now`/`openNotifications` are injectable for tests only.
 */
export async function stashIsActionable(
  rec: PendingNotif | null,
  opts: {
    now?: number;
    openNotifications?: (tag: string) => Promise<number | null>;
  } = {},
): Promise<boolean> {
  if (!rec || typeof rec.session !== "string" || !NAME_RE.test(rec.session)) return false;
  if (typeof rec.ts !== "number") return false;
  const age = (opts.now ?? Date.now()) - rec.ts;
  if (age < 0 || age > STASH_MAX_AGE_MS) return false;
  if (rec.tapped) return true; // an actual click routed here
  if (age < PENDING_NOTIF_TTL_MS) return true; // fresh receipt (the iOS tap window)
  // Older receipt: land only if its banner is gone (tapped or dismissed).
  try {
    const open = await (opts.openNotifications ?? displayedForTag)("tl-" + rec.session);
    return open === 0;
  } catch {
    return false;
  }
}

/** The key the legacy single-slot record lives under. */
const LEGACY_KEY = "last";

/**
 * Every tap record the worker has written, newest first. Does not consume them:
 * which one was tapped cannot be decided until the notifications are inspected,
 * so the caller deletes the one it acts on (and prunes the rest).
 */
export function readPendingSessions(): Promise<PendingNotif[]> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve([]);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open("tl-notif", 1);
    } catch {
      resolve([]);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore("pending");
      } catch {
        /* already exists */
      }
    };
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("pending", "readonly");
        const all = tx.objectStore("pending").getAll();
        const done = (v: PendingNotif[]) => {
          try {
            db.close();
          } catch {
            /* closed */
          }
          resolve(v);
        };
        tx.oncomplete = () => {
          const rows = (all.result as PendingNotif[]) || [];
          // De-duplicate: the legacy `last` slot mirrors one of the per-session
          // records, so the same tap must not be counted twice.
          const bySession = new Map<string, PendingNotif>();
          for (const r of rows) {
            if (!r || typeof r.session !== "string") continue;
            const prev = bySession.get(r.session);
            if (!prev || (r.ts ?? 0) > (prev.ts ?? 0)) bySession.set(r.session, r);
          }
          done([...bySession.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)));
        };
        tx.onerror = () => done([]);
        tx.onabort = () => done([]);
      } catch {
        try {
          db.close();
        } catch {
          /* closed */
        }
        resolve([]);
      }
    };
  });
}

/**
 * Drop records by session name, plus the legacy slot when it mirrors one of
 * them. Best-effort: a record left behind is re-evaluated next time and its
 * notification will by then be gone, which the age gate handles.
 */
export function clearPendingSessions(sessions: readonly string[]): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined" || sessions.length === 0) {
      resolve();
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open("tl-notif", 1);
    } catch {
      resolve();
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore("pending");
      } catch {
        /* already exists */
      }
    };
    req.onerror = () => resolve();
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("pending", "readwrite");
        const store = tx.objectStore("pending");
        for (const s of sessions) {
          try {
            store.delete(s);
          } catch {
            /* best-effort */
          }
        }
        try {
          store.delete(LEGACY_KEY);
        } catch {
          /* best-effort */
        }
        const done = () => {
          try {
            db.close();
          } catch {
            /* closed */
          }
          resolve();
        };
        tx.oncomplete = done;
        tx.onerror = done;
        tx.onabort = done;
      } catch {
        try {
          db.close();
        } catch {
          /* closed */
        }
        resolve();
      }
    };
  });
}

/**
 * Which of the outstanding tap records was the one the user actually tapped?
 *
 * On iOS nothing tells us. There is no notificationclick for an installed app,
 * and being brought to the foreground carries no argument. What iOS DOES do is
 * clear the notification that was tapped and leave the others alone — so the
 * record whose banner has GONE is the tap, and the ones still on screen are not.
 * That is the same inference `stashIsActionable` already makes for a single aged
 * receipt, applied across all of them.
 *
 * Order of preference:
 *   1. a record sw.js marked `tapped` (its openWindow branch saw a real click)
 *   2. the newest record whose notification is no longer displayed
 *   3. nothing — every banner is still there, so this is an icon launch
 *
 * `displayed` returning null means the registration could not be read. Falling
 * back to the newest FRESH receipt keeps the behaviour that shipped before this
 * was per-session, rather than regressing to no routing at all.
 *
 * Records past STASH_MAX_AGE_MS are ignored outright, and returning null must
 * always be safe: a launch the user did not ask to be redirected must not be.
 */
export async function pickTappedSession(
  records: readonly PendingNotif[],
  opts: {
    now?: number;
    displayed?: (tag: string) => Promise<number | null>;
  } = {},
): Promise<PendingNotif | null> {
  const now = opts.now ?? Date.now();
  const displayed = opts.displayed ?? displayedForTag;
  const live = records.filter((r) => {
    if (!r || typeof r.session !== "string" || !NAME_RE.test(r.session)) return false;
    if (typeof r.ts !== "number") return false;
    const age = now - r.ts;
    return age >= 0 && age <= STASH_MAX_AGE_MS;
  });
  if (live.length === 0) return null;

  // A real click beats every inference.
  const clicked = live.filter((r) => r.tapped).sort((a, b) => b.ts - a.ts);
  if (clicked.length > 0) return clicked[0]!;

  const gone: PendingNotif[] = [];
  let unknown = false;
  for (const r of live) {
    let count: number | null;
    try {
      count = await displayed("tl-" + r.session);
    } catch {
      count = null;
    }
    if (count === null) unknown = true;
    else if (count === 0) gone.push(r);
  }
  if (gone.length > 0) return gone.sort((a, b) => b.ts - a.ts)[0]!;
  if (unknown) {
    const fresh = live.filter((r) => now - r.ts < PENDING_NOTIF_TTL_MS).sort((a, b) => b.ts - a.ts);
    return fresh[0] ?? null;
  }
  return null; // every banner still on screen: an icon launch, not a tap
}

/**
 * Read AND consume (one-shot delete) the SW's pending-session stash. Best-effort:
 * any failure resolves null. Mirrors sw.js's `stashPendingSession` contract
 * exactly — resolve on complete, error AND abort (an abort can fire without a
 * preceding error and would otherwise leave the Promise pending forever).
 */
export function readAndClearPendingSession(): Promise<PendingNotif | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open("tl-notif", 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.result.createObjectStore("pending");
      } catch {
        /* already exists */
      }
    };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("pending", "readwrite");
        const getReq = tx.objectStore("pending").get("last");
        getReq.onsuccess = () => {
          try {
            tx.objectStore("pending").delete("last");
          } catch {
            /* delete best-effort */
          }
        };
        tx.oncomplete = () => {
          try {
            db.close();
          } catch {
            /* closed */
          }
          resolve((getReq.result as PendingNotif) || null);
        };
        tx.onerror = () => {
          try {
            db.close();
          } catch {
            /* closed */
          }
          resolve(null);
        };
        tx.onabort = () => {
          try {
            db.close();
          } catch {
            /* closed */
          }
          resolve(null); // abort can fire without error
        };
      } catch {
        try {
          db.close();
        } catch {
          /* closed */
        }
        resolve(null);
      }
    };
  });
}

/**
 * A usable Notification CONSTRUCTOR is the desktop fallback delivery mechanism.
 * The probe (`new Notification('')`) is the feature test; it is closed
 * immediately. Callers gate it behind "no SW registration" so it never runs on
 * Android/desktop-with-SW (where SW-backed notifications are used instead).
 */
export function notifyConstructorUsable(): boolean {
  if (typeof Notification === "undefined") return false;
  try {
    new Notification("").close();
    return true;
  } catch {
    return false;
  }
}

export interface ServiceWorkerHandle {
  /** the live registration once it resolves, else null. */
  registration(): ServiceWorkerRegistration | null;
  /** can ANYTHING show a notification here (SW registration or constructor)? */
  deliverable(): boolean;
  dispose(): void;
}

/**
 * Register the push service worker and wire the notification-tap handoff. Safe to
 * call once on app mount; `dispose()` detaches the message listener.
 */
export function registerServiceWorker(opts: {
  onActivateSession: (session: string) => void;
}): ServiceWorkerHandle {
  let reg: ServiceWorkerRegistration | null = null;

  const onMessage = (e: MessageEvent): void => {
    const d = e.data as { type?: string; session?: unknown } | null;
    if (!d || d.type !== "tl-activate-session") return;
    // Validate the name (the SW never posts for a session-less /push/test tap;
    // this is defense-in-depth against a malformed name).
    if (typeof d.session !== "string" || !NAME_RE.test(d.session)) return;
    opts.onActivateSession(d.session);
    // Warm tap handled — consume any stash the SW wrote for this push so a later
    // plain (icon) launch won't replay it.
    void readAndClearPendingSession();
    // Tell sw.js a real lobby took it. The worker cannot reliably tell a lobby
    // from a terminal iframe by URL — it tried, and a URL change unrelated to
    // notifications silently killed tap routing twice — so it now moves on to
    // the next candidate when nobody answers. Replying is what stops the tap
    // dying quietly next time a page URL moves. Sent AFTER the switch, so a
    // throw above leaves the worker free to try another window.
    try {
      (e.ports && e.ports[0])?.postMessage({ type: "tl-activate-ack" });
    } catch {
      /* no port (an older worker posts without one) */
    }
  };

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/sw.js")
      .then((r) => {
        reg = r;
      })
      .catch(() => {
        /* unsupported, or route not live yet */
      });
    navigator.serviceWorker.addEventListener("message", onMessage);
  }

  return {
    registration: () => reg,
    deliverable: () => !!reg || notifyConstructorUsable(),
    dispose: () => {
      if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", onMessage);
      }
    },
  };
}
