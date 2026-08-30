import { onMount, onCleanup } from "solid-js";

/**
 * The Tab half of the modal dialog contract, in one place.
 *
 * `aria-modal="true"` tells assistive tech that Tab cannot leave the dialog, so
 * it must not: the backdrop is opaque, and without this Tab walks out into the
 * composer, the sidebar and the view switch, all of them invisible behind it.
 *
 * SettingsPanel, SkillsPanel and FilePreview each carried their own copy of the
 * selector and the wrap, identical bar the name of the element variable. Each
 * dialog keeps its own Escape handling, which genuinely differs — FilePreview
 * steps browse → edit → close and guards Cmd/Ctrl-S.
 */

/** The selector for what the browser will Tab to. A disabled control drops out
 *  on its own, and `[tabindex="-1"]` (which the dialog root carries) is
 *  excluded so the root never appears in its own run. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tabbable descendants of root, in DOM order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)];
}

/**
 * Wrap a Tab keypress at both ends of root, and pull focus back when it has
 * escaped. Call it only for `e.key === "Tab"`.
 *
 * A Tab in the middle of the run is left to the browser, so the event is only
 * cancelled at an edge.
 */
export function wrapTab(e: KeyboardEvent, root: HTMLElement): void {
  const items = tabbables(root);
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const outside = !root.contains(active);
  if (!first || !last) {
    e.preventDefault();
    root.focus();
  } else if (e.shiftKey && (outside || active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (outside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * The focus half of the same contract: opening moves focus to the dialog itself
 * (which carries tabindex=-1) rather than to its ✕, so Enter does not close it
 * on arrival and screen readers announce the dialog's label. Every close path
 * unmounts the dialog, so restoring the opener belongs in cleanup and covers
 * the ✕, the backdrop and Escape alike.
 *
 * The focus call is deferred by a microtask because the node is only in the
 * document by the time one runs.
 */
export function installDialogFocus(root: () => HTMLElement | undefined): void {
  let opener: HTMLElement | null = null;
  onMount(() => {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => root()?.focus());
  });
  onCleanup(() => {
    if (opener && opener !== document.body && opener.isConnected) opener.focus();
  });
}
