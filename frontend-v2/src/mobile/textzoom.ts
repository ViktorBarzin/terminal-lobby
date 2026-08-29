/**
 * Pinch to size the TEXT view, the way a pinch already sizes the terminal.
 *
 * The terminal's own recognizers live in frontend/term.html and drive an xterm
 * font size. The text view is ordinary DOM in the SPA, so it needs its own pair
 * — the arithmetic and the guards are ported from there deliberately, so the two
 * views answer a pinch identically:
 *
 *   ±1 step per ±7% span ratio, a 5% deadzone before a pinch counts as one,
 *   three moves before Chromium classifies, and a zoomed page never claims.
 *
 * TWO FRONT-ENDS, because no single event covers both engines.
 *   Chromium: two-finger touch spans, measured by hand. `touchmove` is consumed
 *     from the first move — that consumption IS the claim on the gesture.
 *   WebKit (iOS/iPadOS): the proprietary GestureEvent, whose `scale` is already
 *     the cumulative span ratio. preventDefault at `gesturestart` is what
 *     suppresses native pinch-zoom for the whole gesture.
 *
 * WHAT IT DRIVES. Not a font-size: the transcript's type is set in px across a
 * hundred-odd rules, and a scale has to move all of it together — headings,
 * code, chips, the gaps between rows. So the step arithmetic is kept in the
 * terminal's units (a font size between FONT_SIZE_MIN and MAX) and published as
 * the RATIO of that to the default, which app.css applies as a zoom on the
 * transcript. Same numbers, same feel, one CSS property.
 */
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../store/prefs";

/** Chromium: how many two-finger moves before deciding pinch-or-pan. */
export const CLASSIFY_MOVE = 3;
/** |ratio − 1| below this is a two-finger pan, not a pinch. */
export const CLASSIFY_RATIO = 0.05;
/** One step of size per this much span ratio. */
export const STEP_RATIO = 0.07;

/** Device-local, like the terminal's own pinch flag. Not roamed: a phone and a
 *  desktop want different sizes and neither should follow the other. */
export const TEXT_SIZE_KEY = "tl:text-size:v1";

export function clampTextSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

/** The size a gesture has reached, from where it started and how far it spread. */
export function sizeForRatio(base: number, ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return clampTextSize(base);
  return clampTextSize(base + Math.trunc((ratio - 1) / STEP_RATIO));
}

/** True once a span ratio is far enough from 1 to be a deliberate pinch. */
export function isPinch(ratio: number): boolean {
  return Number.isFinite(ratio) && Math.abs(ratio - 1) >= CLASSIFY_RATIO;
}

/** What app.css multiplies the transcript by. */
export function scaleFor(size: number): number {
  return clampTextSize(size) / FONT_SIZE_DEFAULT;
}

export function loadTextSize(): number {
  try {
    const raw = localStorage.getItem(TEXT_SIZE_KEY);
    return raw ? clampTextSize(Number(raw)) : FONT_SIZE_DEFAULT;
  } catch {
    return FONT_SIZE_DEFAULT;
  }
}

export function saveTextSize(size: number): void {
  try {
    if (clampTextSize(size) === FONT_SIZE_DEFAULT) localStorage.removeItem(TEXT_SIZE_KEY);
    else localStorage.setItem(TEXT_SIZE_KEY, String(clampTextSize(size)));
  } catch {
    /* private mode: the gesture still works for this view's lifetime */
  }
}

/** Two fingers, as far apart as they are. */
export function span(a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }): number {
  return Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
}

export interface TextZoomDeps {
  /** The element a pinch has to be over for this to claim it. */
  surface: () => HTMLElement | null | undefined;
  /** Current size, and where to put a new one. */
  get: () => number;
  set: (size: number) => void;
  /** Off switch — the same device flag the terminal's pinch reads. */
  enabled?: () => boolean;
  /** Show the reader what size they are at. */
  onReadout?: (size: number | null) => void;
  doc?: Document;
  win?: Window;
}

/**
 * The page's own pinch-zoom level. A pinch on an ALREADY-zoomed page belongs to
 * the browser, not to us — claiming it there fights the reader's zoom.
 */
function pageScale(win: Window): number {
  try {
    if (win.top?.visualViewport) return win.top.visualViewport.scale;
  } catch {
    /* cross-origin top */
  }
  return win.visualViewport ? win.visualViewport.scale : 1;
}

export function installTextZoom(deps: TextZoomDeps): () => void {
  const doc = deps.doc ?? (typeof document !== "undefined" ? document : null);
  const win = deps.win ?? (typeof window !== "undefined" ? window : null);
  if (!doc || !win) return () => {};
  const on = () => deps.enabled?.() !== false;
  const over = (t: EventTarget | null) => {
    const s = deps.surface();
    return !!(s && t instanceof Node && s.contains(t));
  };

  // ---- Chromium: measure the span ourselves -------------------------------
  let pz: { span0: number; moves: number; claimed: boolean; dead: boolean; base: number; last: number | null } | null =
    null;

  const onStart = (e: TouchEvent): void => {
    if (pz) {
      pz.dead = true; // a third finger mid-pinch: abort, never resume
      return;
    }
    if (e.touches.length !== 2 || !on()) return;
    if (pageScale(win) > 1.001) return;
    const [a, b] = [e.touches[0]!, e.touches[1]!];
    if (!over(a.target) || !over(b.target)) return;
    pz = { span0: span(a, b), moves: 0, claimed: false, dead: false, base: deps.get(), last: null };
  };

  const onMove = (e: TouchEvent): void => {
    if (!pz || pz.dead) return;
    if (e.touches.length !== 2) {
      pz.dead = true;
      return;
    }
    // Never fight a stream the browser already owns, and never preventDefault a
    // non-cancelable event (a no-op that earns a console warning).
    if (!e.cancelable) {
      pz.dead = true;
      return;
    }
    e.preventDefault(); // consumed from move 1 — this is the claim
    pz.moves++;
    const ratio = span(e.touches[0]!, e.touches[1]!) / pz.span0;
    if (!pz.claimed) {
      if (pz.moves < CLASSIFY_MOVE) return;
      if (!isPinch(ratio)) {
        pz.dead = true; // span held constant: a two-finger pan, let it go
        return;
      }
      pz.claimed = true;
      deps.onReadout?.(deps.get());
    }
    const target = sizeForRatio(pz.base, ratio);
    if (target !== pz.last) {
      pz.last = target;
      if (target !== deps.get()) deps.set(target);
      deps.onReadout?.(target);
    }
  };

  const onEnd = (e: TouchEvent): void => {
    if (!pz) return;
    if (e.touches.length < 2) {
      pz = null;
      deps.onReadout?.(null);
    }
  };

  // ---- WebKit: GestureEvent carries the ratio ----------------------------
  let gz: { base: number; last: number | null; frozen: boolean } | null = null;
  let fingers = 0;
  const countStart = (e: TouchEvent) => (fingers = e.touches.length);
  const countEnd = (e: TouchEvent) => (fingers = e.touches.length);

  const gStart = (e: Event): void => {
    if (!on() || pageScale(win) > 1.001 || !over(e.target)) return;
    if (e.cancelable !== false) e.preventDefault(); // suppresses native zoom
    gz = { base: deps.get(), last: null, frozen: false };
  };
  const gChange = (e: Event): void => {
    if (!gz) return;
    if (e.cancelable !== false) e.preventDefault();
    if (fingers > 2) gz.frozen = true; // a third finger freezes; never resumes
    if (gz.frozen) return;
    const scale = (e as Event & { scale?: number }).scale;
    const ratio = typeof scale === "number" && scale > 0 ? scale : 1;
    if (gz.last === null && !isPinch(ratio)) return;
    const target = sizeForRatio(gz.base, ratio);
    if (target !== gz.last) {
      gz.last = target;
      if (target !== deps.get()) deps.set(target);
      deps.onReadout?.(target);
    }
  };
  const gEnd = (e: Event): void => {
    if (!gz) return;
    if (e.cancelable !== false) e.preventDefault();
    gz = null;
    deps.onReadout?.(null);
  };

  const passive = { passive: true } as const;
  const active = { passive: false } as const;
  doc.addEventListener("touchstart", onStart, passive);
  doc.addEventListener("touchmove", onMove, active);
  doc.addEventListener("touchend", onEnd, passive);
  doc.addEventListener("touchcancel", onEnd, passive);
  doc.addEventListener("touchstart", countStart, passive);
  doc.addEventListener("touchend", countEnd, passive);
  doc.addEventListener("gesturestart", gStart, active);
  doc.addEventListener("gesturechange", gChange, active);
  doc.addEventListener("gestureend", gEnd, active);

  return () => {
    doc.removeEventListener("touchstart", onStart);
    doc.removeEventListener("touchmove", onMove);
    doc.removeEventListener("touchend", onEnd);
    doc.removeEventListener("touchcancel", onEnd);
    doc.removeEventListener("touchstart", countStart);
    doc.removeEventListener("touchend", countEnd);
    doc.removeEventListener("gesturestart", gStart);
    doc.removeEventListener("gesturechange", gChange);
    doc.removeEventListener("gestureend", gEnd);
  };
}
