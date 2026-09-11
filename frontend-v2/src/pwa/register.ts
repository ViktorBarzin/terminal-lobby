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
 *   - reads and consumes the IndexedDB stash the SW writes for the iOS
 *     killed-PWA cold-launch path (which fires no notificationclick), and reads
 *     the notification shade that decision needs.
 *
 * WHICH record a launch belongs to is not decided here. That is one pure
 * function in pwa/tap.ts, so the deciding and the reporting cannot disagree;
 * this module is the platform half it runs on.
 *
 * SW-backed notifications are preferred over the bare `Notification` constructor
 * (Android Chrome requires them), so `deliverable()` reports whether ANYTHING
 * can show a notification here.
 */
import { NAME_RE } from "../types/lobby";
import type { StoredRecord } from "./tap";

/**
 * The tags of every notification still in the shade, or null when that cannot be
 * read at all (no service worker, no getNotifications, or a throw).
 *
 * The difference carries the decision, so the two are kept apart: an empty array
 * means the shade answered and nothing is on screen, which is exactly what a tap
 * leaves behind on iOS. Null means silence, and nothing may be inferred from it.
 *
 * Asked with NO argument on purpose. getNotifications({tag}) only began honouring
 * its filter in WebKit main on 2024-08-29, no release note says which iOS shipped
 * it, and same-tag banners do not coalesce on iOS anyway (WebKit bug 258922), so
 * the whole shade comes back here and pwa/tap.ts matches the tags in JS.
 */
export async function displayedTags(): Promise<string[] | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.getNotifications) return null;
    const open = await reg.getNotifications();
    return open.map((n) => n.tag);
  } catch {
    return null;
  }
}

/**
 * The session the OPERATING SYSTEM opened this launch on, or null.
 *
 * Declarative Web Push (iOS/iPadOS 18.4+) never dispatches notificationclick.
 * WebKit navigates to the notification's `navigate` URL instead, which
 * tmux-api/pushsender.go builds as `<origin>/?session=<name>` — the same query
 * the lobby already reads for its initial selection. So on that platform the
 * query is the only first-hand statement of WHICH banner was tapped, and
 * pwa/tap.ts weighs it above everything it infers from the shade and the clock.
 *
 * It is read fresh on every landing rather than captured once: a warm
 * declarative tap navigates the resident window, so the query can change under
 * a page that never reloaded.
 *
 * Not validated here beyond being a string. `pickTap` checks it against NAME_RE
 * and, more to the point, refuses to act on it without a live record behind it,
 * which is what keeps a query left over from an earlier tap from routing again.
 */
export function navigatedSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("session");
  } catch {
    return null;
  }
}

/** The key the legacy single-slot record lives under. */
const LEGACY_KEY = "last";

/**
 * Every row in the tap stash (db 'tl-notif' v1, store 'pending'), in whatever
 * order IndexedDB hands them over.
 *
 * ONE ROW PER SESSION, keyed by the session name, plus the legacy `last` slot
 * sw.js still mirrors the newest push into. It was a single slot until
 * 2026-09-02 (a17306e): with several notifications outstanding each push
 * overwrote the one before it, so tapping the oldest banner routed to the newest
 * push's session. Measured on Viktor's phone that day: pushes for issues,
 * cache-omages and ux landed inside 80 s, he tapped one, and the read came back
 * `already` because the slot held `ux` and `ux` was what he was looking at.
 *
 * Nothing is consumed and nothing is judged here, not even the duplicate the
 * `last` mirror makes. Which copy of a session wins is pwa/tap.ts's call — it
 * prefers a recorded click over a newer receipt, and a newest-ts dedupe here
 * would throw that click away before it got to say so.
 */
export function readPendingSessions(): Promise<StoredRecord[]> {
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
        const done = (v: StoredRecord[]) => {
          try {
            db.close();
          } catch {
            /* closed */
          }
          resolve(v);
        };
        tx.oncomplete = () => {
          const rows = (all.result as unknown[]) || [];
          // Anything that is not an object cannot be a record and cannot be
          // named for deletion either. Dropping it here keeps "no rows" meaning
          // an empty store, which is what a wake stays silent about.
          done(rows.filter((r): r is StoredRecord => !!r && typeof r === "object"));
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
  /**
   * Switch the app to this session. Returns whether it actually did: a tab
   * acting as another user refuses, and a refusal must neither consume the
   * record nor acknowledge the worker (see onMessage).
   */
  onActivateSession: (session: string) => boolean;
}): ServiceWorkerHandle {
  let reg: ServiceWorkerRegistration | null = null;

  const onMessage = (e: MessageEvent): void => {
    const d = e.data as { type?: string; session?: unknown } | null;
    if (!d || d.type !== "tl-activate-session") return;
    // Validate the name (the SW never posts for a session-less /push/test tap;
    // this is defense-in-depth against a malformed name).
    if (typeof d.session !== "string" || !NAME_RE.test(d.session)) return;
    // A window that will not take the switch stays silent, so sw.js moves on to
    // the next candidate and the record stays for whichever window does take
    // it. A lens tab (?as=someone) is the case: matchAll sorts focused windows
    // first, so the lens is often the one posted to, and answering there both
    // swallowed the tap and deleted the record the reader's own window was
    // going to route on.
    if (!opts.onActivateSession(d.session)) return;
    // Warm tap handled — consume the record sw.js wrote for this push so a later
    // wake won't replay it. It used to clear the legacy `last` key alone, and
    // the store has been keyed BY SESSION since 2026-09-02 (a17306e): the real
    // row survived, so the next return to the foreground read it, called it a
    // tap, and pulled the reader off whatever they had moved to.
    // clearPendingSessions takes the legacy slot with it.
    void clearPendingSessions([d.session]);
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
