import { createSignal } from "solid-js";

/**
 * Opening a T3 row (docs/plans/2026-10-31-t3-hosts-claude-design.md, decision
 * 8). A T3 thread has no terminal in the lobby: it opens in T3 itself, on the
 * user's own T3 host.
 *
 * With a mouse, a new browser tab on the thread's web URL. On a touch screen a
 * small sheet asks which client to use, because the T3 app opens only a thread
 * of a server it is paired with, and the page cannot tell whether it is.
 */

/** The links of one T3 thread, as a row or a fresh create carries them. */
export interface T3Target {
  url: string;
  appUrl: string;
  /** What the sheet calls it. */
  title?: string;
}

const [sheet, setSheet] = createSignal<T3Target | null>(null);

/** The thread the open sheet is about, or null while none is up. */
export const t3Sheet = sheet;

export function closeT3Sheet(): void {
  setSheet(null);
}

/** Does this device open a T3 thread straight into a tab? A fine pointer
 *  does; anything else is offered the sheet. */
function opensInTab(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  try {
    return window.matchMedia("(pointer: fine)").matches;
  } catch {
    return true;
  }
}

/** Open a URL in a new tab with no handle back to this page. */
export function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener");
}

/** How the page hands a link to the T3 app. An object so a test can stand
 *  in for the navigation, which jsdom does not perform. */
export const t3Nav = {
  toApp(appUrl: string): void {
    window.location.href = appUrl;
  },
};

/** Hand the thread to the T3 app. */
export function openInApp(appUrl: string): void {
  if (appUrl) t3Nav.toApp(appUrl);
}

/**
 * Open a T3 thread the way this device should: a tab on desktop, the sheet on
 * a phone. A target with no web URL (a server that predates the field) does
 * nothing rather than open a blank tab.
 */
export function openT3(t: T3Target): void {
  if (!t.url) return;
  if (opensInTab()) openInBrowser(t.url);
  else setSheet(t);
}

/**
 * A tab opened NOW, while the click that asked for it still counts as a user
 * gesture, and pointed at the thread once the thread exists.
 *
 * A T3 launch takes seconds, and a browser blocks a window.open made that long
 * after the click. So the tab opens blank first and follows the URL when it
 * arrives. `cancel` closes it again when the launch fails. Null on a device
 * that opens the sheet instead, or where the browser refused the tab.
 */
export interface PendingTab {
  go(t: T3Target): void;
  cancel(): void;
}

export function reserveTab(): PendingTab | null {
  if (!opensInTab()) return null;
  const w = window.open("about:blank", "_blank");
  if (!w) return null;
  try {
    w.opener = null;
  } catch {
    /* a browser that refuses this keeps the opener; the page is our own host */
  }
  return {
    go: (t) => {
      w.location.href = t.url;
    },
    cancel: () => w.close(),
  };
}
