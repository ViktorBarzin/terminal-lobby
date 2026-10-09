import { type Component, type JSX, Show, createSignal, onCleanup } from "solid-js";
import { SWIPE_MIN_PX } from "../mobile/swipe";

/**
 * One queued prompt's ghost row, and the ways to cancel it (Viktor,
 * 2026-10-09: "on the card we could swipe it or press and hold").
 *
 *   - Swipe the bubble sideways, either way, past SWIPE_MIN_PX. It follows the
 *     finger and its outline turns red once letting go would cancel it.
 *   - Press and hold it (GHOST_HOLD_MS) and "Cancel message" / "Keep" appear
 *     under it.
 *   - With a mouse, a × beside the bubble on hover or keyboard focus.
 *
 * The gesture follows SessionCard's row swipe, measured on phones in August:
 * the axis is claimed once at AXIS_LOCK_PX, a claimed swipe holds the page
 * still through a touchmove registered by hand (Solid delegates touch handlers
 * to the document, where they are passive), and release decides on distance
 * alone. `data-own-swipe` keeps the session swipe (mobile/swipe.ts) off it.
 *
 * Cancelling asks session-events to drop the prompt it holds behind the turn
 * (held.go cancelHeld). The ghost dims meanwhile, and the queue's own
 * `unqueued` event takes it away. When the server could not (Claude had it
 * already), it comes back and the store says why in a toast.
 */

/** How long a finger rests on a ghost before Cancel is offered. The session
 *  row's hold is the same 450 ms. */
export const GHOST_HOLD_MS = 450;
/** Movement past this is a drag, and the hold must not fire behind it. */
const HOLD_SLOP_PX = 8;
/** Travel that settles which way the finger is going. */
const AXIS_LOCK_PX = 10;
/** How far the bubble follows the finger. */
const SWIPE_TRAIL_PX = 96;
/** How long a cancelled ghost stays dimmed waiting for the queue to drop it.
 *  Past this the row still standing is another prompt with the same words. */
const CANCEL_LINGER_MS = 2_000;

export const QueuedGhost: Component<{
  text: string;
  sending?: boolean;
  /** Absent when this ghost cannot be cancelled: it is still being sent, or
   *  the view is watching someone else's session. */
  onCancel?: (text: string) => Promise<boolean>;
  /** Beside the bubble, before it (the sending spinner). */
  lead?: JSX.Element;
  children: JSX.Element;
}> = (props) => {
  const [dx, setDx] = createSignal(0);
  const [offering, setOffering] = createSignal(false);
  const [cancelling, setCancelling] = createSignal(false);
  const canCancel = () => !!props.onCancel && !props.sending;

  let rowEl: HTMLDivElement | undefined;
  let from: { x: number; y: number } | null = null;
  let axis: "x" | "y" | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;

  const endHold = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  const cancel = async () => {
    if (cancelling() || !props.onCancel) return;
    setOffering(false);
    setCancelling(true);
    const ok = await props.onCancel(props.text);
    if (!ok) {
      setCancelling(false);
      return;
    }
    lingerTimer = setTimeout(() => setCancelling(false), CANCEL_LINGER_MS);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!canCancel() || cancelling() || e.pointerType === "mouse") return;
    // A press on the offer's own buttons is a tap on them, not a new gesture.
    if (e.target instanceof Element && e.target.closest("button")) return;
    from = { x: e.clientX, y: e.clientY };
    axis = null;
    endHold();
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      from = null;
      setDx(0);
      setOffering(true);
    }, GHOST_HOLD_MS);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!from) return;
    const mx = e.clientX - from.x;
    const my = e.clientY - from.y;
    if (Math.abs(mx) > HOLD_SLOP_PX || Math.abs(my) > HOLD_SLOP_PX) endHold();
    if (!axis && Math.max(Math.abs(mx), Math.abs(my)) >= AXIS_LOCK_PX) {
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (axis === "y") {
        // Down the page: the timeline is scrolling, and the ghost stays put.
        from = null;
        setDx(0);
        return;
      }
      setOffering(false);
    }
    if (axis === "x") setDx(Math.max(-SWIPE_TRAIL_PX, Math.min(SWIPE_TRAIL_PX, mx)));
  };

  const onPointerUp = (e: PointerEvent) => {
    endHold();
    const start = from;
    const claimed = axis === "x";
    from = null;
    axis = null;
    setDx(0);
    if (!start || !claimed) return;
    // A finger brought back to where it started has taken the swipe back.
    if (Math.abs(e.clientX - start.x) >= SWIPE_MIN_PX) void cancel();
  };

  const onPointerCancel = () => {
    endHold();
    from = null;
    axis = null;
    setDx(0);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (axis === "x" && e.cancelable) e.preventDefault();
  };

  // A long press on a phone also raises the browser's own menu.
  const onContextMenu = (e: MouseEvent) => {
    if (canCancel() && (holdTimer !== undefined || offering())) e.preventDefault();
  };

  // The offer goes away when the reader touches anything else.
  const onDocumentDown = (e: PointerEvent) => {
    if (offering() && rowEl && e.target instanceof Node && !rowEl.contains(e.target)) {
      setOffering(false);
    }
  };
  document.addEventListener("pointerdown", onDocumentDown, true);

  const attach = (el: HTMLDivElement) => {
    rowEl = el;
    el.addEventListener("touchmove", onTouchMove, { passive: false });
  };

  onCleanup(() => {
    endHold();
    clearTimeout(lingerTimer);
    rowEl?.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("pointerdown", onDocumentDown, true);
  });

  return (
    <div
      ref={attach}
      class="tl-row tl-row-user tl-row-ghost"
      role="group"
      aria-label={props.sending ? "Sending message" : "Queued message"}
      data-queued=""
      data-sending={props.sending || undefined}
      data-own-swipe={canCancel() || undefined}
      data-cancelling={cancelling() || undefined}
      data-armed={Math.abs(dx()) >= SWIPE_MIN_PX || undefined}
      style={{ transform: dx() ? `translateX(${dx()}px)` : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
    >
      {props.lead}
      <Show when={canCancel()}>
        <button
          type="button"
          class="tl-ghost-x"
          aria-label="Cancel queued message"
          title="Cancel queued message"
          onClick={() => void cancel()}
        >
          ×
        </button>
      </Show>
      <div class="tl-ghost-stack">
        {props.children}
        <Show when={offering()}>
          <div class="tl-ghost-offer">
            <button type="button" class="tl-ghost-keep" onClick={() => setOffering(false)}>
              Keep
            </button>
            <button type="button" class="tl-ghost-cancel-confirm" onClick={() => void cancel()}>
              Cancel message
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
};
