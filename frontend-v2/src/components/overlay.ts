import { onCleanup, onMount } from "solid-js";

/**
 * The dismiss gesture on an overlay's own surface: the dark area around a modal
 * panel, or a lightbox that closes wherever you press it.
 *
 * It goes on the node through a `ref` rather than through a JSX `onClick`
 * because the surface is not a control. It carries no role, it is not in the
 * tab order, and its keyboard equivalent is the overlay's own Escape handler —
 * written as an element handler it describes a mouse-only button that does not
 * exist, which is what the accessibility rules flag.
 *
 * The listener needs no removal: it lives on the overlay's own node, which the
 * dismiss unmounts.
 *
 * The phone bar's overflow menu uses it for the same shape without a backdrop:
 * a display:contents wrapper that closes the menu when a click bubbles out of
 * one of the shell's rows.
 */
export interface DismissOptions {
  /** Ignore a press that landed on the panel inside rather than on the surface. */
  surfaceOnly?: boolean;
  /** Cancel the press's default so the panel does not lose focus to <body>. */
  keepFocus?: boolean;
}

export function dismissOnPress(
  onDismiss: () => void,
  opts: DismissOptions = {},
): (el: HTMLElement) => void {
  return (el) => {
    if (opts.keepFocus) el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      if (opts.surfaceOnly && e.target !== el) return;
      onDismiss();
    });
  };
}

/**
 * Close a float on a press outside it, and on Escape.
 *
 * Capturing, on the document, for the same reasons the sidebar's menus do
 * (components/menu.ts): a press that lands on a control with a handler of its
 * own still has to reach this first, and Escape must not also reach whatever
 * sits under the float. Shared by every float the composer opens: the + menu,
 * the model sheet, and the new-session composer's dials.
 *
 * It is written here rather than borrowed from `createDismissableMenu`, whose
 * Escape closes without saying so and so cannot give the focus back.
 */
export function dismissFloat(o: {
  open: () => boolean;
  inside: (t: Node) => boolean;
  close: (why: "escape" | "outside") => void;
}): void {
  const onDown = (e: Event): void => {
    if (!o.open()) return;
    const t = e.target as Node | null;
    if (t && o.inside(t)) return;
    o.close("outside");
  };
  const onKey = (e: KeyboardEvent): void => {
    if (!o.open() || e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    o.close("escape");
  };
  onMount(() => {
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
  });
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  });
}

/**
 * What the arrow keys walk in a float's list: its rows, and the segmented
 * effort control whose buttons count as one stop among them.
 */
export interface RowNav {
  /** A list row. */
  row: string;
  /** The segmented control; its buttons are the stops inside it. */
  seg: string;
}

const navOf = (n: RowNav): string => `${n.row}, ${n.seg} button`;

const usable = (el: HTMLElement): boolean =>
  el.getAttribute("aria-disabled") !== "true" && !(el as HTMLButtonElement).disabled;

/**
 * ↑ and ↓ walk a list's rows, ← and → walk the effort control. Into and out of
 * the effort control the vertical walk stops only on its chosen button, so it
 * reads as one stop in the list, the way a radio group does.
 */
export function walkNav(e: KeyboardEvent, nav: RowNav): void {
  const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
  const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
  if (!vertical && !horizontal) return;
  const box = e.currentTarget as HTMLElement;
  const from = e.target as HTMLElement;
  const seg = from.closest<HTMLElement>(nav.seg);
  if (horizontal && !seg) return;
  const scope = horizontal ? seg! : box;
  let items = Array.from(scope.querySelectorAll<HTMLElement>(navOf(nav))).filter(usable);
  if (vertical) {
    items = items.filter(
      (b) => !b.closest(nav.seg) || b.getAttribute("aria-checked") === "true" || b === from,
    );
  }
  const i = items.indexOf(from);
  if (i < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
  items[(i + step + items.length) % items.length]!.focus();
}

/** The chosen row in a list, or its first usable row. */
export function focusChosen(box: HTMLElement | undefined, nav: RowNav): void {
  if (!box) return;
  const rows = Array.from(box.querySelectorAll<HTMLElement>(navOf(nav))).filter(usable);
  (rows.find((r) => r.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
}
