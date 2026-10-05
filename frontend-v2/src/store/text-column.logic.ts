/**
 * How wide the Text view's column is — pure decisions.
 *
 * The transcript's rows, the composer and every card docked in its place share
 * one centred column (app.css, `--tl-col-w`). It was a fixed 760px, which on a
 * wide monitor leaves most of the view empty either side of the conversation;
 * Emil asked to use more of that width (2026-10-05). Dragging either edge of
 * the composer, or a preset in Settings > Appearance, sets it.
 *
 * Per-browser, not roamed, for the reason store/sidebar-width.logic.ts gives:
 * a width in pixels is an answer about a SCREEN.
 */

/** Where the width is kept. Per-browser: see the header. */
export const TEXT_COL_KEY = "tl:text-col-w:v1";

/** The column as it has always been, and what a reset returns to. */
export const TEXT_COL_DEFAULT = 760;

/**
 * Narrower than this and the composer's control row starts to crowd. A view
 * narrower than the column shows the view's width anyway, so this floor only
 * decides how narrow a person may CHOOSE.
 */
export const TEXT_COL_MIN = 560;

/** A stored width past any screen this runs on is treated as that screen's edge. */
export const TEXT_COL_MAX = 3840;

/**
 * How close to the room's edge a drag has to reach to mean "use all of it".
 * Without it a person who drags to the edge stores 1312px, and the next,
 * wider window shows a column that stops short for no reason they chose.
 */
export const TEXT_COL_SNAP = 24;

/** One arrow-key press on a grip. */
export const TEXT_COL_STEP = 40;

/** A column width: pixels, or the whole width of the view. */
export type TextColumn = number | "full";

export interface TextColumnPreset {
  label: string;
  value: TextColumn;
}

/** The choices Settings offers. A drag can land between them. */
export const TEXT_COL_PRESETS: readonly TextColumnPreset[] = [
  { label: "Normal", value: TEXT_COL_DEFAULT },
  { label: "Wide", value: 1000 },
  { label: "Wider", value: 1280 },
  { label: "Full", value: "full" },
];

function clampPx(v: number): number {
  return Math.min(TEXT_COL_MAX, Math.max(TEXT_COL_MIN, Math.round(v)));
}

/**
 * The stored string, as a width. Anything unreadable is the default, and the
 * absent case is answered before the arithmetic: `Number("")` is 0, not NaN,
 * so an empty key would otherwise clamp to the minimum.
 */
export function readTextColumn(raw: string | null): TextColumn {
  if (raw === "full") return "full";
  if (raw === null || raw.trim() === "") return TEXT_COL_DEFAULT;
  const v = Number(raw);
  return Number.isFinite(v) ? clampPx(v) : TEXT_COL_DEFAULT;
}

/** What to store; null removes the key, so the default leaves nothing behind. */
export function serializeTextColumn(v: TextColumn): string | null {
  return v === TEXT_COL_DEFAULT ? null : String(v);
}

/**
 * The width a drag asks for, given the room the column can grow into.
 *
 * Reaching the room's edge means "full" rather than that many pixels; see
 * TEXT_COL_SNAP. A room narrower than the minimum is already showing all of
 * itself, so the drag stores the minimum there rather than "full".
 */
export function fromDrag(px: number, room: number): TextColumn {
  if (room > TEXT_COL_MIN && px >= room - TEXT_COL_SNAP) return "full";
  return clampPx(px);
}

/** One key press: `delta` pixels wider (or narrower), from what is on screen. */
export function nudge(v: TextColumn, delta: number, room: number): TextColumn {
  const from = v === "full" ? room : v;
  return fromDrag(from + delta, room);
}

/**
 * The value `--tl-col-w` carries. "full" is 100% rather than `none` because
 * one consumer does arithmetic with it (the docked cards' left margin), and
 * 100% of the same box leaves that margin at the gutter.
 */
export function columnCss(v: TextColumn): string {
  return v === "full" ? "100%" : `${v}px`;
}

/** The preset a width equals, if any. */
export function matchingPreset(v: TextColumn): TextColumnPreset | undefined {
  return TEXT_COL_PRESETS.find((p) => p.value === v);
}
