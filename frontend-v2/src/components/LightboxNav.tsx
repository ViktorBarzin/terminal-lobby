import { Show, type Component } from "solid-js";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons";

/**
 * Stepping through a lightbox's pictures (Viktor, 2026-09-30): an arrow on each
 * side, the ← and → keys, and the "2/5" count under the picture. Shared by the
 * gallery's lightbox and the Text view's (PictureLightbox).
 *
 * It stops at either end rather than wrapping, and the arrow that would go past
 * the end is not drawn, so the count and the arrows together say where you are.
 * A single picture draws nothing.
 *
 * Both lightboxes close on a press anywhere on them (components/overlay), so an
 * arrow's press stops before it reaches the lightbox. That needs a listener on
 * the arrow itself (`on:click`): Solid's `onClick` is delegated to the
 * document, and the lightbox's own listener had closed it by the time a
 * delegated handler ran. The lightbox already cancels the mousedown, which
 * keeps the press from moving the focus onto the arrow.
 */
export const LightboxNav: Component<{
  index: number;
  count: number;
  onStep: (delta: -1 | 1) => void;
}> = (props) => {
  const press = (delta: -1 | 1) => (e: MouseEvent) => {
    e.stopPropagation();
    props.onStep(delta);
  };
  return (
    <Show when={props.count > 1}>
      <Show when={props.index > 0}>
        <button
          type="button"
          class="tl-lightbox-nav tl-lightbox-prev"
          aria-label="Previous picture"
          title="Previous (←)"
          on:click={press(-1)}
        >
          <ChevronLeftIcon />
        </button>
      </Show>
      <Show when={props.index < props.count - 1}>
        <button
          type="button"
          class="tl-lightbox-nav tl-lightbox-next"
          aria-label="Next picture"
          title="Next (→)"
          on:click={press(1)}
        >
          <ChevronRightIcon />
        </button>
      </Show>
      <div class="tl-lightbox-chip">
        {props.index + 1}/{props.count}
      </div>
    </Show>
  );
};

/**
 * The step an arrow key asks for, or 0 for any other key. An arrow with a
 * modifier is left to the browser: Alt+← is Back on Linux and Windows, Cmd+←
 * on a Mac.
 */
export function stepKey(e: KeyboardEvent): -1 | 0 | 1 {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return 0;
  if (e.key === "ArrowLeft") return -1;
  if (e.key === "ArrowRight") return 1;
  return 0;
}
