/**
 * Hyperlinks in the terminal: which ones we open, and how.
 *
 * Claude Code marks its links with OSC 8 — a URL attached to display text,
 * which xterm parses into the cell's extended attributes. So the terminal
 * already knows exactly where the links are; nothing here has to guess at a URL
 * from surrounding text, and nothing pattern-matches the scrollback.
 *
 *   \e]8;id=o4uj3i;https://claude.com/download#mobile\e\the Claude mobile app\e]8;;\e\
 *
 * Two things were wrong with what happened when you touched one, both measured
 * on the shared Android emulator (real Chrome, a real `adb shell input tap`)
 * against the deployed build on 2026-09-06:
 *
 *   - xterm's fallback handler asks `confirm("Do you want to navigate to …?
 *     WARNING: This link could potentially be dangerous")`. Two taps and a
 *     browser dialog, for a link the session itself printed.
 *   - the same tap raised the soft keyboard: visualViewport 783.24 -> 471.24.
 *     A tap on the terminal focuses the compose mirror, which is right almost
 *     everywhere and wrong on a link, where you meant to follow it.
 *
 * This module is PURE. It decides whether a URL may be opened and remembers
 * whether the pointer is over a link; TerminalNative wires it to xterm's
 * `linkHandler` and consults `overLink()` before it takes the focus.
 */

/**
 * Schemes we will hand to the browser.
 *
 * An allowlist, not a blocklist. A session prints whatever it likes, and
 * `javascript:` in a `window.open` runs in this origin — which holds the live
 * terminal socket. `mailto:` and `tel:` are here because a phone can act on
 * them and neither can execute anything.
 */
const OPENABLE = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * The URL to open for this link, or null to leave it alone.
 *
 * Parsing rather than string-matching: `URL` normalises the scheme, so
 * `JavaScript:`, `java\nscript:` and a percent-encoded scheme all resolve to
 * what the browser would actually run, and each fails the allowlist on the
 * value the browser sees.
 */
export function openableUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null; // relative, malformed, or not a URL at all
  }
  if (!OPENABLE.has(u.protocol)) return null;
  return u.href;
}

/** What the terminal component gives this module to act on the world. */
export interface LinkWorld {
  /** open a URL in a new tab. Injected so the decision stays testable. */
  open: (url: string) => void;
  /** report a link that was refused, so a dead tap is explained rather than silent. */
  refused?: (raw: string) => void;
}

/**
 * The link tracker: xterm's `linkHandler`, plus the one question the touch path
 * needs answered.
 */
export interface LinkTracker {
  /** xterm ILinkHandler.hover — the pointer entered a link. */
  hover: () => void;
  /** xterm ILinkHandler.leave — the pointer left it. */
  leave: () => void;
  /** xterm ILinkHandler.activate — follow it. */
  activate: (event: MouseEvent, text: string) => void;
  /**
   * Is the pointer on a link right now?
   *
   * The touch path asks this at the END of a tap, before it takes the focus. A
   * tap produces a compat `mousemove` at the finger before anything else, so
   * xterm's linkifier has already called `hover` by then — which is what makes
   * this answerable at all without reading xterm's internals (the public buffer
   * API exposes no URL for a cell, checked against @xterm/xterm 6.0.0).
   */
  overLink: () => boolean;
}

export function createLinkTracker(world: LinkWorld): LinkTracker {
  let over = false;
  return {
    hover: () => {
      over = true;
    },
    leave: () => {
      over = false;
    },
    activate: (event, text) => {
      // The gesture is spent either way: the tap followed a link, so it must
      // not also fall through to whatever a plain tap does.
      event.preventDefault();
      event.stopPropagation();
      const url = openableUrl(text);
      if (url === null) {
        world.refused?.(text);
        return;
      }
      world.open(url);
    },
    overLink: () => over,
  };
}
