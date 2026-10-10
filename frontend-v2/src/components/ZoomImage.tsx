import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { createEffect, createSignal, on, onCleanup, onMount, type Component } from "solid-js";
import { DOUBLE_TAP_MS, createTapTracker } from "./zoom.logic";

/**
 * A full-size picture that zooms on its own, without zooming the page.
 *
 * Every full-size picture in the app (the gallery's lightbox, an attached
 * image in the composer, the file preview) used to be a plain <img>, so a
 * pinch on one went to the browser. The browser zoomed the whole page, and
 * the transcript and the composer stayed zoomed after the picture closed.
 *
 * Pan and zoom come from @panzoom/panzoom, bound to the STAGE (`canvas`) so a
 * pinch that starts on the dark area around a photo is still the photo's. It
 * sets `touch-action: none` on the stage, which is what keeps Chromium's own
 * pinch-zoom off it; WebKit gets `gesturestart` cancelled as well, the same
 * claim mobile/textzoom.ts makes. A drag pans only once zoomed in, a wheel or
 * a trackpad pinch zooms at the cursor, and a double tap toggles between fit
 * and DOUBLE_TAP_SCALE at the point tapped.
 *
 * `onDismiss` is the single tap. It waits out the double-tap window, or the
 * first tap of a double would close the picture, and it does nothing while
 * zoomed in, where a tap is more often the end of a pan than a request to
 * leave. Escape still closes from any zoom.
 */

const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;
/**
 * Panzoom's pinch is linear: scale grows by `step` per 80px the fingers
 * spread. Its default 0.3 left a 3.25x spread (80px to 260px, CDP touch in a
 * Pixel 7 profile, 2026-10-10) at 1.675x, so the photo lagged the fingers.
 * 0.65 tracks a pinch that starts about 120px apart.
 */
const PINCH_STEP = 0.65;
/** The wheel keeps Panzoom's default: a trackpad sends dozens of events a gesture. */
const WHEEL_STEP = 0.3;
/** Below this the picture counts as back at fit, and is recentred. */
const FIT_EPSILON = 1.01;

export const ZoomImage: Component<{
  src: string;
  alt: string;
  onError?: () => void;
  onDismiss?: () => void;
}> = (props) => {
  let stage!: HTMLDivElement;
  let img!: HTMLImageElement;
  let pz: PanzoomObject | undefined;
  let pendingDismiss: ReturnType<typeof setTimeout> | undefined;
  const [zoomed, setZoomed] = createSignal(false);
  const taps = createTapTracker();

  const cancelDismiss = (): void => {
    if (pendingDismiss !== undefined) clearTimeout(pendingDismiss);
    pendingDismiss = undefined;
  };

  /** Back to fit, centred, if a gesture left the picture there or below. */
  const settle = (): void => {
    if (!pz) return;
    if (pz.getScale() <= FIT_EPSILON) {
      pz.reset({ animate: true });
      setZoomed(false);
    } else {
      setZoomed(true);
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    taps.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    // A second finger, or the next press of a double, is not a dismiss.
    cancelDismiss();
  };
  const onPointerUp = (e: PointerEvent): void => {
    const tap = taps.up(e.pointerId, e.clientX, e.clientY, e.timeStamp);
    if (tap === "double") {
      cancelDismiss();
      if (!pz) return;
      if (zoomed()) {
        pz.reset({ animate: true });
        setZoomed(false);
      } else {
        pz.zoomToPoint(DOUBLE_TAP_SCALE, e, { animate: true });
        setZoomed(true);
      }
    } else if (tap === "tap" && !zoomed() && props.onDismiss) {
      const dismiss = props.onDismiss;
      pendingDismiss = setTimeout(() => {
        pendingDismiss = undefined;
        dismiss();
      }, DOUBLE_TAP_MS);
    }
  };
  const onPointerCancel = (e: PointerEvent): void => taps.cancel(e.pointerId);
  // The press is answered by the pointer handlers above. Its click must not
  // reach the lightbox behind, whose own dismiss would close on every tap, the
  // first of a double and the end of a pan included.
  const swallowClick = (e: MouseEvent): void => e.stopPropagation();

  const onWheel = (e: WheelEvent): void => {
    if (!pz) return;
    pz.zoomWithWheel(e, { step: WHEEL_STEP });
    settle();
  };

  // WebKit's own pinch-zoom starts here; cancelling it keeps the page still.
  const onGesture = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };

  onMount(() => {
    pz = Panzoom(img, {
      canvas: true,
      minScale: 1,
      maxScale: MAX_SCALE,
      step: PINCH_STEP,
      panOnlyWhenZoomed: true,
      // The stylesheet owns the cursor: zoom-out over a lightbox, grab when
      // zoomed. Panzoom would otherwise write `move` inline over both.
      cursor: "",
    });
    img.addEventListener("panzoomend", settle);
    // Native listeners, not JSX ones: Solid delegates those to the document,
    // which Panzoom's stopPropagation on pointerdown never lets them reach, and
    // which is too late to keep a click from the lightbox's own listener.
    stage.addEventListener("pointerdown", onPointerDown);
    // Up and cancel on the window: a finger that lifts off the stage still has
    // to end its press, or the next one reads as a second finger.
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    stage.addEventListener("click", swallowClick);
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("gesturestart", onGesture, { passive: false });
    stage.addEventListener("gesturechange", onGesture, { passive: false });
  });
  onCleanup(() => {
    cancelDismiss();
    pz?.destroy();
    img?.removeEventListener("panzoomend", settle);
    stage?.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    stage?.removeEventListener("click", swallowClick);
    stage?.removeEventListener("wheel", onWheel);
    stage?.removeEventListener("gesturestart", onGesture);
    stage?.removeEventListener("gesturechange", onGesture);
  });

  // The gallery swaps pictures in place; a new one opens at fit.
  createEffect(
    on(
      () => props.src,
      () => {
        cancelDismiss();
        pz?.reset({ animate: false });
        setZoomed(false);
      },
      { defer: true },
    ),
  );

  return (
    <div ref={stage} class="tl-zoom" data-zoomed={zoomed() ? "on" : undefined}>
      <img
        ref={img}
        src={props.src}
        alt={props.alt}
        onError={() => props.onError?.()}
        draggable={false}
      />
    </div>
  );
};
