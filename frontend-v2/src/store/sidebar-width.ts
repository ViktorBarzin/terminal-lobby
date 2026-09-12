import { createSignal, onCleanup, type Accessor } from "solid-js";
import { lsGet, lsSet } from "../lib/storage";
import {
  clampSidebarWidth,
  readStoredWidth,
  SIDEBAR_W_DEFAULT,
  SIDEBAR_W_KEY,
} from "./sidebar-width.logic";

/**
 * How wide the session list is, and whether a drag is happening right now.
 *
 * Two signals rather than one because they have different owners.
 * `width` is a preference, stored per-browser and read by the shell as
 * `--tl-sidebar-w`. `dragging` is a moment, and `.tl-shell` needs it to switch
 * off the 0.18s grid transition it animates a collapse with: left on, every
 * pointermove would start a fresh animation and the seam would trail the
 * pointer by most of a second.
 *
 * The window width is a THIRD input and it is deliberately not stored. What is
 * stored is what the person dragged to; what `width()` returns is that, capped
 * so the session pane keeps `CONTENT_W_MIN`. So a narrow window borrows width
 * back from the list for as long as it is narrow, and a wide one gives it
 * straight back — which a store that clamped on write could not do.
 */
export interface SidebarWidthStore {
  /** The column width in px: the stored preference, capped to this window. */
  width: Accessor<number>;
  /** Persist a new width. Clamped, so a caller may pass a raw pointer offset. */
  setWidth: (px: number) => void;
  /** Back to the 260px the column has always had. */
  reset: () => void;
  /** True from pointerdown on the grip until the drag ends. */
  dragging: Accessor<boolean>;
  setDragging: (on: boolean) => void;
}

export interface SidebarWidthOptions {
  /** injectable for tests; defaults to localStorage. */
  read?: () => number;
  write?: (px: number) => void;
  /** injectable for tests; defaults to a signal tracking `window.innerWidth`. */
  viewport?: Accessor<number>;
}

export function createSidebarWidthStore(opts: SidebarWidthOptions = {}): SidebarWidthStore {
  const read = opts.read ?? (() => readStoredWidth(lsGet(SIDEBAR_W_KEY)));
  const write = opts.write ?? ((px: number) => lsSet(SIDEBAR_W_KEY, String(px)));

  const [stored, setStored] = createSignal(read());
  const [dragging, setDragging] = createSignal(false);
  const viewport = opts.viewport ?? createWindowWidth();

  const setWidth = (px: number): void => {
    // Clamped against the live window on the way IN as well, so the seam stops
    // under the pointer rather than the pointer running away from it — and so
    // what gets stored is a width this screen could actually show.
    const v = clampSidebarWidth(px, viewport());
    if (v === stored()) return;
    setStored(v);
    write(v);
  };

  return {
    width: () => clampSidebarWidth(stored(), viewport()),
    setWidth,
    reset: () => setWidth(SIDEBAR_W_DEFAULT),
    dragging,
    setDragging,
  };
}

/**
 * `window.innerWidth`, as a signal.
 *
 * Its own listener rather than a read at boot: a desktop window is resized,
 * snapped and split all day, and the cap above has to move with it. The
 * listener is passive and does one integer write, so a drag of the window
 * costs a signal per frame and nothing else.
 */
function createWindowWidth(): Accessor<number> {
  if (typeof window === "undefined") return () => 0;
  const [w, setW] = createSignal(window.innerWidth);
  const onResize = (): void => setW(window.innerWidth);
  window.addEventListener("resize", onResize, { passive: true });
  onCleanup(() => window.removeEventListener("resize", onResize));
  return w;
}
