import { createSignal, onCleanup, onMount, type Accessor } from "solid-js";

export interface DismissableMenu {
  open: Accessor<boolean>;
  toggle: () => void;
  close: () => void;
  /**
   * `ref` for the element enclosing BOTH the ⋯ button and the popup: a
   * pointerdown inside it is not an outside click (otherwise the press that
   * opens the menu would immediately dismiss it again).
   */
  anchor: (el: HTMLElement) => void;
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

export function createDismissableMenu(hold: () => () => void): DismissableMenu {
  const [open, setOpen] = createSignal(false);
  let release: (() => void) | null = null;
  let anchorEl: HTMLElement | undefined;

  const close = (): void => {
    if (!open()) return;
    setOpen(false);
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

  onMount(() => {
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    release?.();
    release = null;
  });

  return { open, toggle, close, anchor: (el) => (anchorEl = el) };
}
