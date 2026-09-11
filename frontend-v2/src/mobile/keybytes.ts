/**
 * Pre-baked terminal input byte sequences for the mobile soft-key toolbar.
 *
 * Ported VERBATIM from the vanilla frontend/index.html `sendKey()` call sites
 * (~11150-11193). A phone soft keyboard cannot produce any of these — there is
 * no Esc and there are no arrows — so the toolbar sends the raw bytes straight
 * into the pty. These bypass any keydown handling, so the caller must reset any
 * input-line mirror after sending (see the vanilla mirrorLineReset).
 *
 * The map is the single source of truth for the byte contract; a wrong byte
 * here silently sends the wrong key, so it is unit-tested against the exact
 * escape sequences.
 *
 * SIX ENTRIES, down from eleven when the key row flattened to one line
 * (2026-09-06, SoftKeys.tsx carries the telemetry that decided it). The five
 * that went: `backTab` (CSI Z — the Text view's composer cycles the permission
 * mode with a server-side BTab, which is what it was for) and the four literal
 * glyphs (slash, dash, pipe, backtick), which the system soft keyboard types
 * anyway and which nobody tapped once in 28 days.
 */

export const KEY_BYTES = {
  /** Escape. */
  esc: "\x1b",
  /** Horizontal tab. */
  tab: "\t",
  /** Cursor up — CSI A. */
  up: "\x1b[A",
  /** Cursor down — CSI B. */
  down: "\x1b[B",
  /** Cursor left — CSI D. */
  left: "\x1b[D",
  /** Cursor right — CSI C. */
  right: "\x1b[C",
} as const;

export type KeyName = keyof typeof KEY_BYTES;

/** All pre-baked key names, in a stable order (toolbar build + tests). */
export const KEY_NAMES = Object.keys(KEY_BYTES) as KeyName[];

/** The byte sequence for a pre-baked key. */
export function keyBytes(name: KeyName): string {
  return KEY_BYTES[name];
}
