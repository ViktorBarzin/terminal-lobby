import {
  type Component,
  type JSX,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { SWIPE_MIN_PX } from "../mobile/swipe";
import type { OpenQueuedEdit } from "../store/drafts";
import { PenIcon } from "./Icons";

/**
 * One queued prompt's ghost row, the ways to cancel or edit it, and the form a
 * prompt taken out to edit is held in (Viktor, 2026-10-09: "on the card we
 * could swipe it or press and hold"; 2026-10-10: "let's make sure we can still
 * discard the message. also let's allow editing the queued message. press and
 * hold should open an edit form").
 *
 *   - Swipe the bubble sideways, either way, past SWIPE_MIN_PX. It follows the
 *     finger and its outline turns red once letting go would cancel it.
 *   - Press and hold it (GHOST_HOLD_MS) to edit it.
 *   - With a mouse, a × and a pencil beside the bubble on hover or keyboard
 *     focus. The × cancels; the pencil edits.
 *
 * Editing mirrors Up in Claude Code, which takes queued messages out of the
 * queue while you change them. The ghost asks the store to take the prompt
 * off the server's queue (the same request a cancel makes), so Claude cannot
 * take it mid-edit, and the ghost leaves on the queue's own `unqueued` event.
 * The form is drawn from the store's edit at the end of the queue
 * (QueuedEditRow), on this device only. It opens at once, before the server
 * answers, and the gesture that asked (the finger lifting after the hold,
 * heard on the document since the ghost may be gone by then, or the pencil's
 * click) focuses it: iOS raises the keyboard only for a focus inside
 * a gesture handler, never from the hold's timer or after a fetch. Nothing
 * sends until the server has let go of it. When it could not, the form closes
 * with a toast, or, if something was typed, keeps it and offers only "Send as
 * a new message" and Discard. Once the server has let go, a reload brings the
 * form back with what was typed. Save sends the new words and Close sends the
 * old ones, both
 * through the composer's send, so they join the back of the queue if the turn
 * still runs or go to Claude now if it has ended. Discard drops the message.
 * Save is off until the words differ from what was queued; Cmd or Ctrl+Enter
 * saves and Escape closes. A tap outside closes the form only while nothing in
 * it has changed, so a stray tap never throws an edit away.
 *
 * The gesture follows SessionCard's row swipe, measured on phones in August:
 * the axis is claimed once at AXIS_LOCK_PX, a claimed swipe holds the page
 * still through a touchmove registered by hand (Solid delegates touch handlers
 * to the document, where they are passive), and release decides on distance
 * alone. `data-own-swipe` keeps the session swipe (mobile/swipe.ts) off it.
 *
 * Cancelling or taking out to edit asks session-events to drop the prompt it
 * holds behind the turn (held.go cancelHeld). The ghost dims meanwhile, and
 * the queue's own `unqueued` event takes it away. When the server could not
 * (Claude had it already), it comes back and the store says why in a toast.
 */

/** How long a finger rests on a ghost before it is taken out to edit. The
 *  session row's hold is the same 450 ms. */
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

/** Past this a finger still down is not coming back up for this hold. */
const RELEASE_WAIT_MS = 15_000;

/**
 * Until the finger that held a ghost lifts, keeps the browser's long-press
 * menu off the page, then focuses the edit box in that lift: iOS raises the
 * keyboard only for a focus inside a gesture, and the hold fired from a timer.
 *
 * Listened for on the document, not the ghost. Measured on Android Chrome
 * (2026-10-10): the server let go of the message while the finger was still
 * down, so the ghost left from under it with its own handlers, the press went
 * on over the form that took its place, and the browser's long press cancelled
 * the touch, so no pointerup ever came and the keyboard stayed down.
 */
function focusOnRelease(focus: () => void): void {
  const blockMenu = (e: Event) => e.preventDefault();
  const lifts = ["pointerup", "touchend", "pointercancel", "touchcancel"] as const;
  const done = () => {
    clearTimeout(timer);
    document.removeEventListener("contextmenu", blockMenu, true);
    for (const t of lifts) document.removeEventListener(t, done, true);
    focus();
  };
  const timer = setTimeout(done, RELEASE_WAIT_MS);
  document.addEventListener("contextmenu", blockMenu, true);
  for (const t of lifts) document.addEventListener(t, done, true);
}

export const QueuedGhost: Component<{
  text: string;
  sending?: boolean;
  /** Absent when this ghost cannot be cancelled: it is still being sent, or
   *  the view is watching someone else's session. */
  onCancel?: (text: string) => Promise<boolean>;
  /** Takes this prompt out of the queue into the edit form; absent on the same
   *  terms as onCancel. Resolves false when the server could not. */
  onEditStart?: (text: string) => Promise<boolean>;
  /** Beside the bubble, before it (the sending spinner). */
  lead?: JSX.Element;
  /** Focuses the edit form's box. Called from the gesture that opened it, the
   *  finger lifting after a hold or the pencil's click, because iOS raises the
   *  keyboard only for a focus inside a gesture handler. */
  focusEdit?: () => void;
  children: JSX.Element;
}> = (props) => {
  const [dx, setDx] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const canCancel = () => !!props.onCancel && !props.sending;
  const canEdit = () => !!props.onEditStart && !props.sending;
  const ownsGestures = () => canCancel() || canEdit();

  let rowEl: HTMLDivElement | undefined;
  let from: { x: number; y: number } | null = null;
  let axis: "x" | "y" | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;

  const endHold = () => {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  /** Dims the ghost while the server takes the prompt off the queue, and
   *  keeps it dimmed until the queue drops it. Brings it back on failure. */
  const takeOut = async (request: (text: string) => Promise<boolean> | undefined) => {
    if (busy()) return;
    const pending = request(props.text);
    if (!pending) return;
    setBusy(true);
    if (!(await pending)) {
      setBusy(false);
      return;
    }
    lingerTimer = setTimeout(() => setBusy(false), CANCEL_LINGER_MS);
  };
  const cancel = () => void takeOut((t) => props.onCancel?.(t));
  const edit = () => void takeOut((t) => props.onEditStart?.(t));

  const onPointerDown = (e: PointerEvent) => {
    if (!ownsGestures() || busy() || e.pointerType === "mouse") return;
    // A press on the row's own buttons is a tap on them, not a new gesture.
    if (e.target instanceof Element && e.target.closest("button")) return;
    from = { x: e.clientX, y: e.clientY };
    axis = null;
    endHold();
    if (!canEdit()) return;
    holdTimer = setTimeout(() => {
      holdTimer = undefined;
      from = null;
      setDx(0);
      const focus = props.focusEdit;
      focusOnRelease(() => focus?.());
      edit();
    }, GHOST_HOLD_MS);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!from) return;
    const mx = e.clientX - from.x;
    const my = e.clientY - from.y;
    if (Math.abs(mx) > HOLD_SLOP_PX || Math.abs(my) > HOLD_SLOP_PX) endHold();
    if (!axis && Math.max(Math.abs(mx), Math.abs(my)) >= AXIS_LOCK_PX) {
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      // Down the page the timeline is scrolling, and the ghost stays put. A
      // ghost that can only be edited has no swipe either.
      if (axis === "y" || !canCancel()) {
        from = null;
        setDx(0);
        return;
      }
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
    if (Math.abs(e.clientX - start.x) >= SWIPE_MIN_PX) cancel();
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
    if (ownsGestures() && holdTimer !== undefined) e.preventDefault();
  };

  const attach = (el: HTMLDivElement) => {
    rowEl = el;
    el.addEventListener("touchmove", onTouchMove, { passive: false });
  };

  onCleanup(() => {
    endHold();
    clearTimeout(lingerTimer);
    rowEl?.removeEventListener("touchmove", onTouchMove);
  });

  return (
    <div
      ref={attach}
      class="tl-row tl-row-user tl-row-ghost"
      role="group"
      aria-label={props.sending ? "Sending message" : "Queued message"}
      data-queued=""
      data-sending={props.sending || undefined}
      data-own-swipe={ownsGestures() || undefined}
      data-cancelling={busy() || undefined}
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
          onClick={cancel}
        >
          ×
        </button>
      </Show>
      <Show when={canEdit()}>
        <button
          type="button"
          class="tl-ghost-pencil"
          aria-label="Edit queued message"
          title="Edit queued message"
          onClick={() => {
            edit();
            props.focusEdit?.();
          }}
        >
          <PenIcon />
        </button>
      </Show>
      <div class="tl-ghost-stack">{props.children}</div>
    </div>
  );
};

/** What the edit form does with the prompt it holds. Each send resolves false
 *  when it did not go in, and the form then stays up with what was typed. */
export interface QueuedEditActions {
  /** Every change to the text, so a reload can bring it back. */
  onInput: (draft: string) => void;
  /** Sends these words, trimmed: in place of the old ones, or as a new
   *  message once Claude had the old ones already. */
  onSave: (text: string) => Promise<boolean>;
  /** Sends the old words back. */
  onClose: () => Promise<boolean>;
  /** Drops the prompt. It is off the queue already, so nothing is sent. */
  onDiscard: () => void;
}

/** What the form says when the prompt could not be taken out of the queue
 *  but something had been typed (OpenQueuedEdit `refused` / `failed`). */
const LOST_NOTE = {
  refused: "Claude already has that message",
  failed: "Couldn't take it out of the queue",
} as const;

/**
 * The form a queued prompt taken out to edit is held in, drawn as a ghost row
 * at the end of the queue. The box takes the focus as it opens (the ghost
 * also focuses it from the opening gesture, through `fieldRef`) and grows with
 * what it holds.
 *
 * It opens before the server has let go of the prompt (`taking`): typing
 * works, but nothing sends until the answer is in. When Claude had it already,
 * or the box did not answer, what was typed stays, and the form offers only to
 * send it as a new message or discard it.
 */
export const QueuedEditRow: Component<{
  edit: OpenQueuedEdit;
  actions: QueuedEditActions;
  fieldRef?: (el: HTMLTextAreaElement) => void;
}> = (props) => {
  const [draft, setDraft] = createSignal(untrack(() => props.edit.draft));
  const [busy, setBusy] = createSignal(false);
  const taking = () => props.edit.status === "taking";
  const lost = () =>
    props.edit.status === "refused" || props.edit.status === "failed" ? props.edit.status : null;
  const changed = () => draft().trim() !== props.edit.text.trim();
  const canSave = () => !taking() && draft().trim() !== "" && (!!lost() || changed());
  const canClose = () => props.edit.status === "ready";

  // The store's answer can land after typing began; carry over what it holds
  // when the state moves on.
  createEffect(
    on(
      () => props.edit.status,
      () => setDraft(props.edit.draft),
      { defer: true },
    ),
  );

  let rowEl: HTMLDivElement | undefined;
  let field: HTMLTextAreaElement | undefined;

  /** One send at a time, with the row dimmed while it is out. */
  const run = async (send: () => Promise<boolean>) => {
    if (busy()) return;
    setBusy(true);
    await send();
    setBusy(false);
  };
  const save = () => {
    if (!canSave()) return;
    const next = draft().trim();
    void run(() => props.actions.onSave(next));
  };
  const close = () => {
    if (canClose()) void run(() => props.actions.onClose());
  };
  const discard = () => {
    if (!busy() && !taking()) props.actions.onDiscard();
  };

  const grow = () => {
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  };

  // Native rather than delegated, so Escape stops here instead of reaching
  // whatever else on the page listens for it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      save();
    }
  };

  // A tap anywhere else puts the prompt back, unless the form holds an edit.
  const onDocumentDown = (e: PointerEvent) => {
    if (changed() || busy() || !canClose() || !rowEl) return;
    if (e.target instanceof Node && !rowEl.contains(e.target)) close();
  };
  document.addEventListener("pointerdown", onDocumentDown, true);
  onCleanup(() => document.removeEventListener("pointerdown", onDocumentDown, true));

  onMount(() => {
    grow();
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  });

  return (
    <div
      ref={rowEl}
      class="tl-row tl-row-user tl-row-ghost"
      role="group"
      aria-label="Editing queued message"
      data-queued=""
      data-editing=""
      data-taking={taking() || undefined}
      data-cancelling={busy() || undefined}
    >
      <div class="tl-ghost-stack">
        <div class="tl-ghost-edit">
          <Show when={lost()}>{(why) => <p class="tl-ghost-edit-note">{LOST_NOTE[why()]}</p>}</Show>
          <textarea
            ref={(el) => {
              field = el;
              props.fieldRef?.(el);
            }}
            class="tl-ghost-edit-field"
            aria-label="Edit queued message"
            rows={1}
            value={draft()}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              props.actions.onInput(e.currentTarget.value);
              grow();
            }}
            on:keydown={onKeyDown}
          />
          <div class="tl-ghost-edit-actions">
            <button type="button" class="tl-ghost-discard" disabled={taking()} onClick={discard}>
              Discard
            </button>
            <Show
              when={!lost()}
              fallback={
                <button type="button" class="tl-ghost-save" disabled={!canSave()} onClick={save}>
                  Send as a new message
                </button>
              }
            >
              <button type="button" class="tl-ghost-close" disabled={!canClose()} onClick={close}>
                Close
              </button>
              <button type="button" class="tl-ghost-save" disabled={!canSave()} onClick={save}>
                Save
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};
