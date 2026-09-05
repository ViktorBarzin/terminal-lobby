/**
 * Keeping the soft keyboard up when a tap's compat mousedown lands off the grid.
 *
 * A tap on the terminal focuses the compose mirror at touchend. The tap's
 * DELAYED COMPAT MOUSEDOWN follows 10-44ms later (measured on Android Chrome,
 * median 11ms — not the ~300ms folklore) and is hit-tested at the finger's
 * original coordinates, against whatever the layout says is there NOW.
 *
 * Inside the grid that is harmless: dragselect swallows the press with
 * `preventDefault`, so focus never moves. Outside it, nothing does. The press
 * lands on `div#soft-keys`, `div.sk-group` or `div.tl-session-view`, all
 * focusable=false, and a mousedown on a non-focusable element BLURS the focused
 * input. The keyboard goes down as fast as it came up.
 *
 * The layout moves under the finger because the keyboard reserve shrinks the
 * terminal host alone. On Chrome that reserve is small — the viewport meta says
 * `interactive-widget=resizes-content`, so the layout viewport shrinks too and
 * `keyboardReserve` measures ~51px, leaving the grid still under the finger.
 * WebKit ignores `interactive-widget`, so `innerHeight` stays put, the reserve
 * becomes the whole keyboard, and everything below roughly the half-way line is
 * off the grid by the time the mousedown arrives. That is the reported
 * behaviour: the keyboard flickers, and only taps in the upper half hold it.
 *
 * Refocusing afterwards is not a fix. dragselect's recovery is gated on the
 * press being inside the grid, and even ungated, a programmatic `focus()`
 * outside a user gesture moves focus on iOS WITHOUT reopening the keyboard.
 * Never losing focus is the only thing that works, which is what this decides.
 */

/** What the decision needs of the event and the page. Nothing here is a DOM read. */
export interface KeepFocusWorld {
  /** A real user press, not our own synthesized clone. */
  trusted: boolean;
  /** Touch, where the compat mousedown exists at all. A mouse is left alone. */
  coarsePointer: boolean;
  /** The press landed on this terminal's grid, where dragselect already acts. */
  insideScreen: boolean;
  /** The compose mirror holds focus, so a blur here costs a keyboard. */
  mirrorFocused: boolean;
  /**
   * The press landed on something that takes focus in its own right — an input,
   * a textarea, a select, or anything contenteditable. Tapping one of those is a
   * person asking for it, and it must still work.
   */
  targetTakesFocus: boolean;
}

/**
 * Whether this press should have its default suppressed to hold focus.
 *
 * Deliberately narrow. Every clause removes a way this could surprise someone:
 * an untrusted press is our own clone; a fine pointer produces no compat
 * mousedown, so a mouse click keeps moving focus exactly as before; a press
 * inside the grid is dragselect's and already prevented; with the mirror
 * unfocused there is no keyboard to lose; and a press on a real control is
 * someone choosing to focus it.
 */
export function shouldKeepFocus(world: KeepFocusWorld): boolean {
  return (
    world.trusted &&
    world.coarsePointer &&
    !world.insideScreen &&
    world.mirrorFocused &&
    !world.targetTakesFocus
  );
}

/** Elements that take focus from a press in their own right. */
const FOCUSABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Whether this node is one of those.
 *
 * Buttons and links are NOT included. A press on one still fires its click —
 * `preventDefault` on mousedown suppresses the focus change, not the activation
 * — and leaving focus in the terminal is what keeps the keyboard up while
 * someone reaches for a soft key, which is the case this exists for.
 */
export function takesFocus(node: EventTarget | null): boolean {
  if (!(node instanceof Element)) return false;
  for (let el: Element | null = node; el; el = el.parentElement) {
    if (FOCUSABLE_TAGS.has(el.tagName)) return true;
    // The ATTRIBUTE, not `isContentEditable`: the property is unimplemented in
    // jsdom, and this walk already climbs parents, which is the inheritance the
    // property would have given.
    const ce = el.getAttribute("contenteditable");
    if (ce !== null && ce !== "false") return true;
  }
  return false;
}
