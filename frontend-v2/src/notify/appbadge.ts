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
 * being right while the app is CLOSED — and they must not disagree, which is
 * what ADR-0015 is about:
 *   - this module, from the poll, whenever a lobby window is on screen. It has
 *     the visit store, so it knows what you have already looked at.
 *   - sw.js, when no lobby is on screen. The server sends WHICH sessions are
 *     awaiting or finished rather than a total, and the worker subtracts the
 *     seen-done set store/visits.ts mirrors into IndexedDB, so it arrives at
 *     the same number this module would. It defers to a visible page.
 *
 * With no stored record (a private window, cleared site data) the worker
 * subtracts nothing and every finished session counts, until the app is next
 * opened. That reads high; it does not jump.
 */

/** Just enough of a session to count it. */
export interface BadgeSession {
  name: string;
  state?: string;
  /**
   * The OS user who owns it. Populated for EVERY session, including your own —
   * `/sessions` stamps it unconditionally. It is not a "this one is foreign"
   * flag, which is why `waitingCount` needs to know who you are to use it.
   */
  owner?: string;
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
 *
 * A session someone else owns is skipped entirely. It is their work, and the
 * server's copy of this count never sees it.
 */
export function waitingCount<S extends BadgeSession>(
  sessions: readonly S[],
  isUnseen: (s: S) => boolean,
  me?: string,
): number {
  let n = 0;
  for (const s of sessions) {
    // Someone else's session, shared with you, is their work waiting for them.
    // The push sender only sees your own tmux server, so counting a foreign one
    // here would put the page permanently above the number a closed app draws.
    //
    // `owner` is set on EVERY session, your own included, so the test is the
    // same one the rest of the app uses (SessionCard.foreign, deriveSidebar):
    // owned by someone, and that someone is not you. Testing `owner` alone
    // excluded everything and pinned the badge at zero — shipped in v0.16.0,
    // caught by driving the deployed build rather than by any unit test, because
    // the tests were written to the same wrong assumption as the code.
    //
    // With no `me` supplied nothing is excluded, which keeps the pure function
    // usable from a caller that has no identity to offer.
    if (me && s.owner && s.owner !== me) continue;
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
