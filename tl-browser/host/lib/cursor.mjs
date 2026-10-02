// The browser's one cursor: where the mouse is in a tab and where it clicks,
// for the panel to draw over the screencast, which carries no pointer.
//
// The agent's clicks (playwright-mcp) and a person's input (the viewer
// protocol) both reach Chrome as CDP mouse input, which the page receives as
// trusted pointer and click events. So a small script in every frame listens
// for those in the capture phase and reports them to the host through a
// binding, and one pipeline gives one cursor whoever drives.
//
// A frame reports positions in the top page's CSS pixels, the space the
// screencast and the viewer's mouse messages use: the top frame as is, a
// same-origin iframe by adding each frame element's offset on the way up. A
// cross-origin iframe cannot read where its frame sits in the page, so input
// inside one is not reported and the cursor stays where it last was.

/**
 * @typedef {"move" | "down" | "up" | "click"} CursorKind
 * @typedef {{ t: "cursor", tab: string, x: number, y: number, kind: CursorKind }} CursorMessage
 * @typedef {{ isTrusted: boolean, clientX: number, clientY: number, detail?: number }} PointerLike
 * @typedef {{ getBoundingClientRect: () => { left: number, top: number }, clientLeft: number, clientTop: number }} FrameElement
 * @typedef {object} FrameWindow the parts of a frame's window the page script uses
 * @property {(fn: () => void, ms: number) => unknown} setTimeout
 * @property {{ now: () => number }} performance
 * @property {(type: string, fn: (e: PointerLike) => void, opts: { capture: boolean, passive: boolean }) => void} addEventListener
 * @property {FrameWindow} top
 * @property {FrameWindow} parent
 * @property {FrameElement | null} frameElement null in a cross-origin frame
 */

/** The binding the page script calls. Named to stay out of a page's way. */
export const CURSOR_BINDING = "__tlBrowserCursor";
/** Moves leave a frame at most this often: about 30 a second. */
export const MOVE_INTERVAL_MS = 33;
/**
 * The host passes on moves from a tab at most this often, against a page
 * calling the binding itself in a loop; the page script stays well under it.
 */
const MIN_MOVE_MS = 15;
/**
 * Presses, releases and clicks from a tab pass at most this many a second,
 * after a burst of PRESS_BURST. A page script calling the binding in a loop
 * would otherwise send every viewer a ring per call. A person's double click
 * is 6 messages and fits the burst; the rest of a flood is dropped.
 */
const PRESS_PER_SEC = 20;
const PRESS_BURST = 10;
/** Far beyond any page, near enough to refuse nonsense. */
const MAX_COORD = 100_000;

const KINDS = new Set(["move", "down", "up", "click"]);

/**
 * Runs in every frame of every page, before the page's own scripts, as a
 * context init script. It must stay self-contained: Playwright sends its
 * source text, not the module. It patches no prototype, only adds passive
 * capture listeners, and keeps the timer and clock it found, so a page that
 * wraps setTimeout later (zone.js, say) is not woken by it.
 * @param {{ binding: string, intervalMs: number }} opts
 * @param {FrameWindow} [win] the frame's window; a test passes a stand-in
 */
export function cursorInPage(opts, win = window) {
  // How far, in CSS pixels, a click may be from the release before it and
  // still count as its click; Chrome puts them at the same point. Declared in
  // here because the function is sent as source text.
  const slop = 2;
  try {
    const setTimer = win.setTimeout.bind(win);
    const perf = win.performance;
    const now = () => perf.now();
    let lastMove = -Infinity;
    /** @type {{ x: number, y: number } | null} */
    let pending = null;
    let timerSet = false;
    // A click is reported only as the end of a press and release in this
    // frame, at the release's spot. Chrome also fires a trusted click when
    // Enter or Space activates a focused control, at clientX/clientY 0, and
    // a label forwards a second one to its control; neither is a pointer.
    let pressed = false;
    /** @type {{ x: number, y: number } | null} */
    let released = null;

    /**
     * @param {string} kind
     * @param {number} x
     * @param {number} y
     */
    const report = (kind, x, y) => {
      try {
        const call = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (win))[
          opts.binding
        ];
        if (typeof call === "function") call({ kind, x, y });
      } catch {
        // The page replaced or broke the binding: no cursor, page unharmed.
      }
    };

    /**
     * Where a point in this frame is in the top page, or null when an
     * ancestor is cross-origin.
     * @param {number} x
     * @param {number} y
     * @returns {{ x: number, y: number } | null}
     */
    const inTop = (x, y) => {
      let w = win;
      let px = x;
      let py = y;
      try {
        for (let depth = 0; w !== w.top; depth++) {
          const el = w.frameElement;
          if (!el || depth > 32) return null;
          const r = el.getBoundingClientRect();
          px += r.left + el.clientLeft;
          py += r.top + el.clientTop;
          w = w.parent;
        }
      } catch {
        return null;
      }
      return { x: px, y: py };
    };

    const flush = () => {
      timerSet = false;
      if (!pending) return;
      report("move", pending.x, pending.y);
      pending = null;
      lastMove = now();
    };

    /**
     * @param {string} kind
     * @returns {(e: PointerLike) => void}
     */
    const on = (kind) => (e) => {
      try {
        if (!e.isTrusted) return;
        if (kind === "down") {
          pressed = true;
          released = null;
        } else if (kind === "up") {
          released = pressed ? { x: e.clientX, y: e.clientY } : null;
          pressed = false;
        } else if (kind === "click") {
          const r = released;
          released = null;
          // detail is the click count, 0 for a keyboard activation.
          if (!r || !((e.detail ?? 0) >= 1)) return;
          if (Math.abs(e.clientX - r.x) > slop || Math.abs(e.clientY - r.y) > slop) return;
        }
        const p = inTop(e.clientX, e.clientY);
        if (!p) return;
        if (kind !== "move") {
          // Never held back: the move that led here goes first.
          if (pending) flush();
          report(kind, p.x, p.y);
          return;
        }
        const t = now();
        if (!timerSet && t - lastMove >= opts.intervalMs) {
          report("move", p.x, p.y);
          lastMove = t;
          return;
        }
        pending = p;
        if (!timerSet) {
          timerSet = true;
          setTimer(flush, Math.max(0, opts.intervalMs - (t - lastMove)));
        }
      } catch {
        // Never let the cursor break a page's input.
      }
    };

    // Pointer events rather than mouse events: a page that cancels
    // pointerdown suppresses mousedown and mouseup, and listening to both
    // would report each step twice.
    const listen = { capture: true, passive: true };
    win.addEventListener("pointermove", on("move"), listen);
    win.addEventListener("pointerdown", on("down"), listen);
    win.addEventListener("pointerup", on("up"), listen);
    win.addEventListener("click", on("click"), listen);
  } catch {
    // A frame without the usual window: nothing to report from.
  }
}

/** @param {unknown} v */
const coord = (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_COORD;

/**
 * Each tab's last cursor position, from the reports its pages make. A report
 * arrives from page code, so it is checked like anything else from outside.
 */
export class CursorBoard {
  /** @type {Map<string, { x: number, y: number }>} */
  #last = new Map();
  /** @type {Map<string, number>} */
  #movedAt = new Map();
  /** each tab's press allowance: tokens left, and when it was last topped up */
  /** @type {Map<string, { tokens: number, at: number }>} */
  #presses = new Map();
  #now;

  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  /**
   * @param {string} tab
   * @param {unknown} payload what the page script passed the binding
   * @returns {CursorMessage | null} the message for the tab's viewers, or
   *   null for nothing to send
   */
  report(tab, payload) {
    if (payload === null || typeof payload !== "object") return null;
    const { kind, x, y } = /** @type {Record<string, unknown>} */ (payload);
    if (typeof kind !== "string" || !KINDS.has(kind) || !coord(x) || !coord(y)) return null;
    const pos = { x: round(/** @type {number} */ (x)), y: round(/** @type {number} */ (y)) };
    this.#last.set(tab, pos);
    if (kind === "move") {
      const t = this.#now();
      if (t - (this.#movedAt.get(tab) ?? -Infinity) < MIN_MOVE_MS) return null;
      this.#movedAt.set(tab, t);
    } else if (!this.#takePress(tab)) {
      return null;
    }
    return { t: "cursor", tab, ...pos, kind: /** @type {CursorKind} */ (kind) };
  }

  /**
   * A token bucket per tab for presses, releases and clicks.
   * @param {string} tab
   * @returns {boolean} whether this one may go
   */
  #takePress(tab) {
    const t = this.#now();
    const b = this.#presses.get(tab) ?? { tokens: PRESS_BURST, at: t };
    b.tokens = Math.min(PRESS_BURST, b.tokens + ((t - b.at) * PRESS_PER_SEC) / 1000);
    b.at = t;
    this.#presses.set(tab, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /**
   * The tab's last position for a viewer that starts watching it, as a move:
   * a click that already happened is not shown again.
   * @param {string} tab
   * @returns {CursorMessage | null}
   */
  last(tab) {
    const pos = this.#last.get(tab);
    return pos ? { t: "cursor", tab, ...pos, kind: "move" } : null;
  }

  /** @param {Set<string>} tabs the tabs still open */
  prune(tabs) {
    for (const tab of [...this.#last.keys()]) {
      if (tabs.has(tab)) continue;
      this.#last.delete(tab);
      this.#movedAt.delete(tab);
      this.#presses.delete(tab);
    }
  }
}

/** @param {number} n */
function round(n) {
  return Math.round(n * 100) / 100;
}
