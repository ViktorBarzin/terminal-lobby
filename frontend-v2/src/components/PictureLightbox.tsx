import { Show, onCleanup, onMount, type Component } from "solid-js";
import { closePicture, picture } from "../store/picture";
import { dismissOnPress } from "./overlay";
import { closeOnBack } from "../lib/back-closes";

/**
 * The Text view's pictures, full size (2026-09-24).
 *
 * The same `.tl-lightbox` the gallery and the composer draw: 85vw by 85vh, and
 * a press anywhere on it closes it. The press goes on through `dismissOnPress`
 * because the surface is not a control (components/overlay), and `keepFocus`
 * stops that press from handing the focus to <body> on its way out.
 *
 * Escape closes it and goes no further. The listener is on `document` in the
 * capture phase, the way Gallery's and FilePreview's are, so the key never
 * reaches the composer (which would also close its completion menu) or the
 * terminal (which would send ESC to Claude).
 *
 * The phone's Back closes it too, rather than moving the browser's history.
 *
 * Mounted once, in App.
 */
export const PictureLightbox: Component = () => {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !picture()) return;
    e.preventDefault();
    e.stopPropagation();
    closePicture();
  };
  onMount(() => document.addEventListener("keydown", onKey, true));
  // The phone's Back closes it rather than leaving the page (lib/back-closes).
  closeOnBack(() => picture() !== null, closePicture);
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  return (
    <Show when={picture()}>
      {(pic) => (
        <div class="tl-lightbox" ref={dismissOnPress(closePicture, { keepFocus: true })}>
          <img src={pic().src} alt={pic().alt} />
        </div>
      )}
    </Show>
  );
};
