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

/** The stash the SW writes: db 'tl-notif' v1, store 'pending', key 'last'. */
export interface PendingNotif {
  session: string;
  ts: number;
}

/**
 * 2 min: wide enough for a realistic tap→cold-launch, tight enough that a plain
 * icon launch rarely falls inside a stale stash window (the stash records push
 * RECEIPT, not the tap — no tap signal survives an iOS cold launch).
 */
export const PENDING_NOTIF_TTL_MS = 120 * 1000;

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
