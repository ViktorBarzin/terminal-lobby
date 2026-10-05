import { createSignal } from "solid-js";
import { lsGet, lsSet } from "../lib/storage";
import {
  readTextColumn,
  serializeTextColumn,
  TEXT_COL_DEFAULT,
  TEXT_COL_KEY,
  type TextColumn,
} from "./text-column.logic";

/**
 * The Text view's column width, and whether a grip is being dragged.
 *
 * Module signals rather than a store an owner creates, the way theme.ts holds
 * the theme: three places read and write it (the shell publishes it as
 * `--tl-col-w`, the composer's grips drag it, Settings picks a preset), and
 * none of them owns the others.
 */
const [column, setColumnSignal] = createSignal<TextColumn>(readTextColumn(lsGet(TEXT_COL_KEY)));
const [dragging, setDragging] = createSignal(false);

export const textColumn = column;
export const textColumnDragging = dragging;
export const setTextColumnDragging = setDragging;

export function setTextColumn(v: TextColumn): void {
  if (v === column()) return;
  setColumnSignal(v);
  lsSet(TEXT_COL_KEY, serializeTextColumn(v));
}

/** Back to the 760px the column has always had. */
export function resetTextColumn(): void {
  setTextColumn(TEXT_COL_DEFAULT);
}
