/**
 * fireNotification (inventory Cat.9, high-risk) — show ONE foreground OS
 * notification for a session transition. Ported from the vanilla frontend.
 *
 * The tag `tl-<session>` keeps ONE entry per session: a later 'awaiting' replaces
 * an earlier 'done' for that session (sw.js omits `renotify`, so a repeat never
 * re-alerts). It is identical to the server's background-push tag (tmux-api
 * buildPushPayload/buildDonePayload) — but the tag is NOT what keeps the two
 * delivery paths from double-alerting: iOS raises a fresh banner for a same-tag
 * notification once the first is off screen, which is how one turn completing
 * produced two identical banners on Viktor's iPhone. Dedupe across paths is the
 * caller's `pushDelivers` gate (transitions.ts): where the server pushes, the
 * page does not fire at all.
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

/**
 * @param session the session's NAME — an address. It routes the tap and
 *   coalesces the banner, and is never shown.
 * @param label what the banner CALLS the session: its title, or the id when it
 *   has none (`sessionConfirmLabel`). The two were the same string until
 *   ADR-0019 made a name an opaque id, at which point this banner started
 *   reading `k7m2q9x4tp0v needs input` on the phone. The server's push has
 *   said the title since (tmux-api `pushLabel`); this is the page-fired half
 *   of the same rule, so one edge reads the same whichever path delivers it.
 */
export async function fireNotification(
  session: string,
  label: string,
  kind: NotifyEdge,
  opts: FireOptions,
): Promise<void> {
  const finished = kind === "done";
  const title = label + (finished ? " finished" : " needs input");
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
