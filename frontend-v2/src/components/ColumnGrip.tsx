import { onCleanup, type Component } from "solid-js";
import {
  resetTextColumn,
  setTextColumn,
  setTextColumnDragging,
  textColumn,
} from "../store/text-column";
import {
  fromDrag,
  nudge,
  TEXT_COL_MAX,
  TEXT_COL_MIN,
  TEXT_COL_STEP,
} from "../store/text-column.logic";

/**
 * One edge of the composer, draggable, and with it the Text view's column.
 *
 * A child of `.tl-pillwrap`, which is the column's width and centred in the
 * composer, so the grip sits on the box's edge with no arithmetic of its own.
 * The column stays centred, so moving one edge moves both: the width is twice
 * the pointer's distance from the box's centre, which keeps the edge under the
 * pointer.
 *
 * Drag mechanics are SidebarGrip's (and Dock.tsx's before it): window
 * listeners so a pointer dragged over the transcript still resizes, one
 * AbortController so no ending can leak them, and `pointercancel` listened for
 * alongside `pointerup`.
 *
 * Hidden on a coarse pointer by app.css: a phone's column is the screen.
 */
export const ColumnGrip: Component<{ side: "left" | "right" }> = (props) => {
  let el: HTMLDivElement | undefined;

  let endDrag: (() => void) | null = null;
  onCleanup(() => endDrag?.());

  /** The width the column can grow into: the composer's content box. */
  const room = (): number => {
    const composer = el?.parentElement?.parentElement;
    if (!composer) return 0;
    const cs = getComputedStyle(composer);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return composer.clientWidth - pad;
  };

  const onPointerDown = (e: PointerEvent): void => {
    // Keeps the press off the field: no caret, no text selection starting.
    e.preventDefault();
    endDrag?.();
    const box = el?.parentElement?.getBoundingClientRect();
    if (!box) return;
    // Taken once: the box grows about its centre, so the centre does not move.
    const centre = box.left + box.width / 2;
    const space = room();
    setTextColumnDragging(true);

    const drag = new AbortController();
    const { signal } = drag;
    const move = (ev: PointerEvent): void => {
      setTextColumn(fromDrag(2 * Math.abs(ev.clientX - centre), space));
    };
    const end = (): void => {
      endDrag = null;
      setTextColumnDragging(false);
      drag.abort();
    };

    endDrag = end;
    window.addEventListener("pointermove", move, { signal });
    window.addEventListener("pointerup", end, { signal });
    window.addEventListener("pointercancel", end, { signal });
  };

  /** The window-splitter keys: the arrow pointing away from the centre widens. */
  const onKeyDown = (e: KeyboardEvent): void => {
    const outward = props.side === "right" ? "ArrowRight" : "ArrowLeft";
    const inward = props.side === "right" ? "ArrowLeft" : "ArrowRight";
    if (e.key === outward) setTextColumn(nudge(textColumn(), TEXT_COL_STEP, room()));
    else if (e.key === inward) setTextColumn(nudge(textColumn(), -TEXT_COL_STEP, room()));
    else if (e.key === "Home") setTextColumn(TEXT_COL_MIN);
    else if (e.key === "End") setTextColumn("full");
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={el}
      class="tl-col-grip"
      data-side={props.side}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the conversation column"
      aria-valuenow={textColumn() === "full" ? TEXT_COL_MAX : (textColumn() as number)}
      aria-valuetext={textColumn() === "full" ? "Full width" : `${textColumn()} pixels`}
      aria-valuemin={TEXT_COL_MIN}
      aria-valuemax={TEXT_COL_MAX}
      tabindex="0"
      title="Drag to widen or narrow the conversation. Double-click to reset."
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDblClick={() => resetTextColumn()}
    />
  );
};
