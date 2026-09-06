import { createSignal, onCleanup, onMount, type Accessor, type JSX } from "solid-js";
import { placeMenu, type Box } from "./menu.logic";

export interface DismissableMenu {
  open: Accessor<boolean>;
  toggle: () => void;
  close: () => void;
  /**
   * `ref` for the element enclosing BOTH the ⋯ button and the popup: a
   * pointerdown inside it is not an outside click (otherwise the press that
   * opens the menu would immediately dismiss it again). A placed menu measures
   * this element as well, so it is also the box the popup lines its right edge
   * up with.
   */
  anchor: (el: HTMLElement) => void;
  /**
   * `ref` for the `.tl-menu` popup itself. Only a menu created with
   * `{ placed: true }` reads it; the menus that keep their CSS anchoring never
   * pass it to anything.
   */
  popup: (el: HTMLElement) => void;
  /**
   * The popup's inline style, or `undefined` while there is nothing to say —
   * a menu that opted out of placement, or one that has not been measured yet.
   * `.tl-menu-placed` holds the popup at `visibility: hidden` until this answers
   * with a `visibility: visible`, which is what keeps the unplaced first frame
   * off the screen.
   */
  style: Accessor<JSX.CSSProperties | undefined>;
}

export interface MenuOptions {
  /**
   * Place the popup against the visible viewport instead of against the row it
   * lives in, and close it when that viewport moves underneath it.
   *
   * Opt-in, and only the two SIDEBAR menus opt in. `.tl-menu` is also the
   * header's ordering picker, the session bar's overflow menu and the model
   * picker; those sit in top bars, where an absolutely-positioned popup has
   * always had the whole screen below it, and one of them already carries
   * placement of its own. Leaving the default alone is what keeps this change
   * to the two menus that were actually unreadable.
   */
  placed?: boolean;
}

/**
 * The sidebar's ⋯ popup menus (session card + group header), which share every
 * behaviour but their items:
 *
 *  - while open it holds the lobby poll, honouring the store's own contract
 *    ("pause polling while the user is mid-interaction (rename/drag/menu) so a
 *    poll can't rebuild the list under them"). The hold is released on close
 *    AND on cleanup, so a menu whose owner is unmounted can never strand it.
 *  - Escape closes it, matching every other overlay in the app (palette,
 *    settings, gallery, file preview).
 *  - a pointerdown outside the anchor closes it, as the vanilla page does with
 *    its single `openMenuEl`.
 */
/**
 * A popup menu is rendered inside the row that opens it, and that row is often
 * a `role="button"` with handlers of its own (a session card, a project
 * header). An activation from inside the menu must not reach it. A mouse press
 * arrives as `click`, which `stopMenuClick` has always stopped; a keyboard
 * Enter or Space arrives as `keydown` first, and the row's handler calls
 * `preventDefault()`, which cancels the button's synthesised click. So until
 * `stopMenuActivationKey` was added, Enter on "Rename" selected the session
 * behind the menu and never ran the item at all.
 *
 * Both are written as static JSX attributes so Solid delegates them: stopping
 * propagation inside a delegated handler holds back the other delegated
 * handlers above it and nothing else, so a document-level chord still fires.
 */
export const stopMenuClick = (e: Event): void => e.stopPropagation();

export const stopMenuActivationKey = (e: KeyboardEvent): void => {
  if (e.key === "Enter" || e.key === " ") e.stopPropagation();
};

/**
 * The part of the window a popup can actually be read in.
 *
 * On a desktop that is the window. On a phone it is the window minus whatever
 * the soft keyboard covers, because a menu placed into the covered strip is
 * exactly as unreachable as one placed off the bottom of the screen. The shell
 * already measures that strip and publishes it as `--kb-offset` on <html>
 * (mobile/viewport.ts), so this reads the number rather than working out a
 * second one from `visualViewport` and risking a different answer.
 *
 * `--app-vh` is the wrong property to reach for here even though it is right
 * next to it in the same write: it is deliberately `window.innerHeight` and
 * does NOT shrink with the keyboard, so that a rename box taking focus cannot
 * resize the whole session list (viewport.ts says so at its line 280).
 *
 * An absent or unparseable value means no keyboard: the property is only ever
 * written once the viewport listeners are wired, and a desktop never writes
 * anything but 0.
 */
export function visibleViewport(): Box {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--kb-offset");
  const kb = Number.parseFloat(raw);
  const covered = Number.isFinite(kb) && kb > 0 ? kb : 0;
  return {
    top: 0,
    left: 0,
    right: window.innerWidth,
    bottom: window.innerHeight - covered,
  };
}

export function createDismissableMenu(
  hold: () => () => void,
  opts: MenuOptions = {},
): DismissableMenu {
  const [open, setOpen] = createSignal(false);
  const [style, setStyle] = createSignal<JSX.CSSProperties | undefined>(undefined);
  let release: (() => void) | null = null;
  let anchorEl: HTMLElement | undefined;
  let popupEl: HTMLElement | undefined;

  const close = (): void => {
    if (!open()) return;
    setOpen(false);
    // Back to nothing, so the next open starts hidden again and is measured
    // where it opens rather than inheriting the last row's answer.
    setStyle(undefined);
    popupEl = undefined;
    release?.();
    release = null;
  };

  const toggle = (): void => {
    if (open()) {
      close();
      return;
    }
    release = hold();
    setOpen(true);
  };

  /**
   * Measure the popup and the row, then write where the popup goes.
   *
   * The popup has to be in the document to be measured — its height is eight
   * rows of text and nothing but layout knows how tall that is — so it renders
   * first and is placed afterwards, which is why `.tl-menu-placed` starts it
   * hidden. Both readings are taken here rather than modelled: this repo has
   * twice reasoned about viewport geometry from a picture of the device instead
   * of a measurement and been wrong both times (53caeeb).
   *
   * `max-height` is deliberately not applied until now. Applying it before the
   * measurement would be measuring the clamp rather than the menu, and the
   * clamp is computed FROM the height it would have clamped.
   */
  const place = (): void => {
    if (!open() || !anchorEl || !popupEl?.isConnected) return;
    const box = popupEl.getBoundingClientRect();
    const p = placeMenu(anchorEl.getBoundingClientRect(), box.width, box.height, visibleViewport());
    setStyle({
      left: `${p.left}px`,
      top: `${p.top}px`,
      "max-height": `${p.maxHeight}px`,
      visibility: "visible",
    });
  };

  /**
   * Solid hands a `ref` its element while the tree is still being built, so
   * measuring here directly would measure a node that is not in the document
   * yet and read zero for everything. A microtask is the shortest wait that is
   * definitely long enough: Solid finishes inserting the branch synchronously,
   * and microtasks run once that stack empties and still before the browser
   * paints — so the popup is placed within the frame it appeared in and there is
   * no visible jump from wherever it was rendered first.
   */
  const popup = (el: HTMLElement): void => {
    if (!opts.placed) return;
    popupEl = el;
    queueMicrotask(() => {
      if (popupEl === el) place();
    });
  };

  const onPointerDown = (e: Event): void => {
    if (!open()) return;
    const t = e.target as Node | null;
    if (t && anchorEl?.contains(t)) return;
    close();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!open() || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  /**
   * A fixed popup is placed once, in window coordinates, and then stops
   * following the row it belongs to. Scrolling the list slides that row out
   * from under it and resizing or rotating moves the box it was fitted into, so
   * both leave the menu pointing at a row that is no longer there. Closing is
   * the honest answer to that, and it is the same dismissal a press outside or
   * an Escape already gets.
   *
   * The scroll listener has to CAPTURE: `.tl-sidebar-scroll` is the element
   * that scrolls, and a scroll event does not bubble, so a listener sitting on
   * the document in the bubble phase would never hear it.
   *
   * Capture is also why the popup has to exempt itself. Capturing on the
   * document hears EVERY scroll in the page, including the popup scrolling
   * inside its own `max-height` — measured in Chrome, a scroll of the popup
   * arrives here with `target` set to the popup. Without this check the safety
   * net would defeat itself: a menu too tall for the room beside its row gets
   * `overflow-y: auto` precisely so it can be scrolled, and the first scroll
   * would dismiss it. A scroll of the popup is the reader reading, not the row
   * moving out from under them, so it is not a reason to close. `contains`
   * counts the element itself, which is what a scroll of the popup reports.
   */
  const onViewportMoved = (e: Event): void => {
    if (!open()) return;
    const t = e.target;
    if (popupEl && t instanceof Node && popupEl.contains(t)) return;
    close();
  };

  onMount(() => {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    if (opts.placed) {
      document.addEventListener("scroll", onViewportMoved, true);
      window.addEventListener("resize", onViewportMoved);
    }
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (opts.placed) {
      document.removeEventListener("scroll", onViewportMoved, true);
      window.removeEventListener("resize", onViewportMoved);
    }
    release?.();
    release = null;
  });

  return { open, toggle, close, anchor: (el) => (anchorEl = el), popup, style };
}
