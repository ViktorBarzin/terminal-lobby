/**
 * The phone's Back goes from a session to the list, the way the header's
 * round back button does.
 *
 * On a phone the lobby shows one screen at a time: the session list, or what
 * is past it (a session, the new-session composer). Opening a session used to
 * replace the history entry only, so Android's Back had nothing of the
 * lobby's to go back to: it left the page, which closes an installed app.
 * With an earlier entry, Back changed the URL to "/" while the session stayed
 * on screen (deployed review round 1 of the T3 pass, 2026-09-29).
 *
 * Now the screen past the list has a history entry of its own, marked in its
 * state, over an entry for the list whose URL names no session, so a reload
 * there opens the list. The `popstate` Back fires shows the screen the entry
 * it landed on stands for. Overlay entries (lib/back-closes.ts) sit on top of
 * the session's and stay the overlays' business.
 */

/** The state key that marks the entry for the screen past the list. */
const CONTENT_KEY = "tlView";

function isContent(state: unknown): boolean {
  return (state as Record<string, unknown> | null)?.[CONTENT_KEY] === 1;
}

function isOverlay(state: unknown): boolean {
  return typeof (state as { tlOverlay?: unknown } | null)?.tlOverlay === "number";
}

/**
 * The screen past the list is now showing: give it an entry of its own, over
 * the list's. The current entry becomes the list's, with the session taken
 * off its URL, and the new one keeps the URL as it is. Nothing happens when
 * the current entry is already the session's.
 */
export function enterContent(): void {
  try {
    if (isContent(window.history.state)) return;
    const url = window.location.href;
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    window.history.pushState({ [CONTENT_KEY]: 1 }, "", url);
  } catch {
    /* no history */
  }
}

/**
 * The header's back button: take the session's entry back off, which lands
 * on the list's and shows it (`listenPhoneBack`). With no session entry
 * under the current one (another device layout, or no history), `fallback`
 * shows the list itself.
 */
export function leaveContent(fallback: () => void): void {
  try {
    if (isContent(window.history.state)) {
      window.history.back();
      return;
    }
  } catch {
    /* no history */
  }
  fallback();
}

/**
 * Show the screen each history entry Back or Forward lands on stands for.
 * `showing` is the screen on show, or null when the layout is not the phone's
 * one-screen-at-a-time. Returns what stops listening.
 */
export function listenPhoneBack(h: {
  showing: () => "list" | "content" | null;
  toList: () => void;
  toContent: () => void;
}): () => void {
  const onPop = (e: PopStateEvent): void => {
    const where = h.showing();
    if (where === null || isOverlay(e.state)) return;
    if (isContent(e.state)) {
      if (where === "list") h.toContent();
    } else if (where === "content") {
      h.toList();
    }
  };
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
