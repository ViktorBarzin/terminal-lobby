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
