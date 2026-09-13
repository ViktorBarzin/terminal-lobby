/**
 * How wide the session list is — pure decisions.
 *
 * The list is a fixed 260px column (sidebar.css `.tl-shell`), and a title is up
 * to 64 characters (CONTEXT.md, "Title"), so most titles ellipsize at a width
 * nobody chose. Dragging the seam is the fix, and this file holds the numbers
 * that drag has to respect.
 *
 * Per-browser, not roamed, for the reason store/dock.ts gives about the dock's
 * split ratio: a width in pixels is an answer about a SCREEN, and carrying a
 * 560px column from a 27" monitor to a laptop would be carrying the wrong one.
 */

/** Where the width is kept. Per-browser: see the header. */
export const SIDEBAR_W_KEY = "tl:sidebar-w:v1";

/** The width the column has always had, and what a reset returns to. */
export const SIDEBAR_W_DEFAULT = 260;

/** Narrower than this and a card is all state dot and no title. */
export const SIDEBAR_W_MIN = 200;

/**
 * Wide enough for the longest title there can be: 64 characters (CONTEXT.md)
 * at the card's 13px semibold is ~450px of text, plus the card's padding and
 * the row's time stamp. Past that the column would be buying nothing.
 */
export const SIDEBAR_W_MAX = 560;

/**
 * What the session pane keeps, whatever the drag asks for. An 80-column
 * terminal at the 13px monospace default is a shade over 600px, so this does
 * not promise 80 columns — it promises the pane stays a pane.
 */
export const CONTENT_W_MIN = 360;

/** One arrow-key press on the grip. */
export const SIDEBAR_W_STEP = 16;

/**
 * The width to actually use, given what was asked for and how much window
 * there is.
 *
 * `viewport` is optional because two callers want different questions answered.
 * A drag asks with the live window, so the pointer cannot push the session pane
 * below `CONTENT_W_MIN`. A read of the stored preference asks the same way, so
 * a column dragged wide on a big monitor narrows to fit a small window rather
 * than squeezing the terminal to a sliver — and because the stored number is
 * left alone, the wide window gets its width back.
 *
 * The absent case is answered before the arithmetic, the way store/dock.ts had
 * to learn to: `Number(null)` is 0, not NaN, so a browser that has never
 * dragged anything would otherwise clamp to the minimum and get a 200px column
 * it never asked for.
 */
export function clampSidebarWidth(n: unknown, viewport?: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return SIDEBAR_W_DEFAULT;
  let max = SIDEBAR_W_MAX;
  if (typeof viewport === "number" && Number.isFinite(viewport) && viewport > 0) {
    // The floor wins ties: on a window too narrow to satisfy both, the list
    // keeps its minimum and the media queries in sidebar.css take over at
    // 720px by stacking the two panes.
    max = Math.max(SIDEBAR_W_MIN, Math.min(max, viewport - CONTENT_W_MIN));
  }
  return Math.max(SIDEBAR_W_MIN, Math.min(max, Math.round(v)));
}

/** What is in storage, or the width the column has always had. */
export function readStoredWidth(raw: string | null): number {
  return raw ? clampSidebarWidth(Number(raw)) : SIDEBAR_W_DEFAULT;
}
