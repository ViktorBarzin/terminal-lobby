/**
 * Pre-baked terminal input byte sequences for the mobile soft-key toolbar.
 *
 * Ported VERBATIM from the vanilla frontend/index.html `sendKey()` call sites
 * (~11150-11193). A phone soft keyboard physically cannot produce most of these
 * (there is no Esc, no arrows, and — critically — no Shift+Tab, whose only
 * mobile route is the raw CSI Z escape), so the toolbar sends the raw bytes
 * straight into the pty. These bypass any keydown handling, so the caller must
 * reset any input-line mirror after sending (see the vanilla mirrorLineReset).
 *
 * The map is the single source of truth for the byte contract; a wrong byte
 * here silently sends the wrong key, so it is unit-tested against the exact
 * escape sequences.
 */

export const KEY_BYTES = {
  /** Escape. */
  esc: "\x1b",
  /** Horizontal tab. */
  tab: "\t",
  /** Shift+Tab / back-tab — CSI Z. The ONLY way to send it from a soft keyboard
   *  (Claude Code's reverse mode-cycle depends on it). */
  backTab: "\x1b[Z",
  /** Cursor up — CSI A. */
  up: "\x1b[A",
  /** Cursor down — CSI B. */
  down: "\x1b[B",
  /** Cursor left — CSI D. */
  left: "\x1b[D",
  /** Cursor right — CSI C. */
  right: "\x1b[C",
  /** Literal "/" (slash-commands, CLI flags). */
  slash: "/",
  /** Literal "-" (CLI flags). */
  dash: "-",
  /** Literal "|" (shell pipe — buried on mobile keyboards). */
  pipe: "|",
  /** Literal backtick (shell/markdown — buried on mobile keyboards). */
  backtick: "`",
} as const;

export type KeyName = keyof typeof KEY_BYTES;

/** All pre-baked key names, in a stable order (toolbar build + tests). */
export const KEY_NAMES = Object.keys(KEY_BYTES) as KeyName[];

/** The byte sequence for a pre-baked key. */
export function keyBytes(name: KeyName): string {
  return KEY_BYTES[name];
}
