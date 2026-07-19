/**
 * fireNotification (inventory Cat.9, high-risk) — show ONE foreground OS
 * notification for a session transition. Ported from the vanilla frontend.
 *
 * The tag `tl-<session>` is load-bearing: it is IDENTICAL to the server's
 * background-push tag (tmux-api buildPushPayload/buildDonePayload), so a
 * foreground notification and a background push for the same session COALESCE —
 * the user is alerted at most once, and a later 'awaiting' replaces an earlier
 * 'done' for that session (sw.js omits `renotify`, so a repeat never re-alerts).
 *
 * Delivery prefers the SW registration's `showNotification` (Android Chrome
 * REQUIRES SW-backed notifications; the bare constructor throws there — the
 * vanilla bug where Android showed nothing). The constructor is the desktop
 * fallback, and its click activates the session in-app.
 */
import { FAVICON_HREF } from "./favicon";

export type NotifyEdge = "awaiting" | "done";

export interface FireOptions {
  /** whether a service-worker registration is available (prefer it). */
  hasRegistration: boolean;
  /** switch the app to a session when a constructor-notification is clicked. */
  onActivate: (session: string) => void;
}

export async function fireNotification(
  session: string,
  kind: NotifyEdge,
  opts: FireOptions,
): Promise<void> {
  const finished = kind === "done";
  const title = session + (finished ? " finished" : " needs input");
  const notifOptions: NotificationOptions = {
    tag: "tl-" + session,
    body: finished ? "Claude finished its turn." : "Claude is awaiting your input.",
    icon: FAVICON_HREF,
    data: { session },
  };

  // Prefer the SW registration (Android + desktop); its notificationclick
  // routing lives in sw.js.
  if (opts.hasRegistration && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, notifOptions);
      return;
    } catch {
      /* fall through to the constructor */
    }
  }
  try {
    const n = new Notification(title, notifOptions);
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focus can reject */
      }
      opts.onActivate(session);
      n.close();
    };
  } catch {
    /* no usable delivery mechanism here */
  }
}
