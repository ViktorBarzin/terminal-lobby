/**
 * The PWA icon badge — the count drawn on the app icon, the way an unread
 * message count is.
 *
 * WHAT IT COUNTS: the sessions that want you. A session awaiting your input,
 * and a session that finished a turn you have not looked at yet. A running
 * session is busy rather than waiting, so it is left out — the icon answers
 * "how many need me", and that is deliberately the same set the push sender
 * alerts on (tmux-api/pushsender.go fires on the running→awaiting and
 * running→done edges). A tap that clears the notification and a look that
 * clears the badge are then the same act.
 *
 * This is NOT the tab-title badge. `notify/title.ts` shows one count chosen by
 * precedence (awaiting > running > unseen-done) because a title has room for a
 * single state; the icon has room for a single NUMBER, so it sums the two
 * states that are asking for attention.
 *
 * WHO SETS IT. Two writers, deliberately, because the badge's whole value is
 * being right while the app is CLOSED:
 *   - this module, from the poll, whenever the lobby is open. It has the visit
 *     store, so it knows what you have already seen and is the accurate one.
 *   - sw.js, from the push payload's `badge`, when the app is not running. The
 *     server cannot know what you have seen, so it counts every awaiting and
 *     done session; that can read high until you next open the app, which
 *     corrects it on the first poll.
 */

/** Just enough of a session to count it. */
export interface BadgeSession {
  name: string;
  state?: string;
}

/** The subset of Navigator the Badging API adds (absent on most browsers). */
export type BadgingNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * How many sessions are waiting for you. Pure, so the predicate stays
 * injectable and the arithmetic is unit-tested without a DOM.
 *
 * `isUnseen` is the visit store's (store/visits.ts): a `done` session counts
 * only until you look at it. The two arms cannot double-count — isUnseen is
 * false for anything whose state is not `done`.
 */
export function waitingCount<S extends BadgeSession>(
  sessions: readonly S[],
  isUnseen: (s: S) => boolean,
): number {
  let n = 0;
  for (const s of sessions) {
    if (s.state === "awaiting" || isUnseen(s)) n++;
  }
  return n;
}

/**
 * Paint the count on the app icon. Best-effort by design and silent on every
 * failure: the Badging API is absent on most browsers, and where it exists it
 * REJECTS rather than throws when the document is not an installed app — so
 * both the synchronous and the asynchronous failure have to be swallowed, or a
 * plain browser tab logs an unhandled rejection on every poll.
 *
 * Zero clears rather than draws a "0" — an empty badge is the absence of one.
 */
export function applyAppBadge(count: number, nav?: BadgingNavigator): void {
  const target = nav ?? (typeof navigator !== "undefined" ? (navigator as BadgingNavigator) : null);
  if (!target) return;
  try {
    const done = count > 0 ? target.setAppBadge?.(count) : target.clearAppBadge?.();
    void done?.catch?.(() => {
      /* not installed, or permission-gated (iOS) */
    });
  } catch {
    /* no Badging API here */
  }
}
