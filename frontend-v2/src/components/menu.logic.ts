/**
 * Where a sidebar ⋯ popup goes.
 *
 * The popup used to be `position: absolute; top: 100%; right: 0` inside the row
 * that opens it, which is fine for a row near the top of the list and wrong for
 * every row near the bottom. Measured on 2026-09-06 at 1440x900 with 25
 * sessions listed: opened on the last card the menu stood 317px tall, hung
 * 308px past the end of `.tl-sidebar-scroll` and 259px past the window, and
 * grew that scroller's scrollHeight from 908px to 1216px. Absolute positioning
 * had turned the popup into list content, so reaching the options at the bottom
 * of it meant scrolling the session list to them.
 *
 * A `position: fixed` popup is measured against the window instead, which
 * escapes all four clipping ancestors at once (`.tl-sidebar-scroll`'s
 * overflow-y, `.tl-shell-sidebar`, `#root` and `body`) without a portal — no
 * ancestor of `.tl-card` carries a transform, filter, contain or will-change,
 * so nothing re-roots the fixed containing block. The cost is that fixed has no
 * opinion about the row it belongs to: left and top have to be computed, in JS,
 * every time the menu opens.
 *
 * This file is that computation and nothing else. It takes plain numbers and
 * returns plain numbers: no DOM, no `window`, no reading a stylesheet. Two
 * reasons, and the second is the one that matters. Reading the geometry is the
 * caller's job because only the caller knows which element it measured. And
 * jsdom does no layout, so inside a test `getBoundingClientRect` answers zero
 * for everything — a placement asserted through a rendered component would be
 * asserting against a 0x0 window. Keeping the arithmetic here is what makes the
 * decision checkable at all, and this repo has twice reasoned about viewport
 * geometry from a model of the device rather than from a measurement and been
 * wrong both times (53caeeb says so outright).
 *
 * What is deliberately NOT here: the popover API and CSS anchor positioning,
 * either of which would do this in a line of CSS. The floor device is an iPad
 * on iPadOS 15.8, which is why vite.config.ts pins `target: "safari15"`. Both
 * of those arrived years later, so measured-then-placed is the only route that
 * clears the floor rather than a preference between routes.
 */

/**
 * The gap kept between the popup and the edge of the visible box, on whichever
 * edges it ends up near. Small on purpose: it is there so the popup reads as
 * sitting in front of the app rather than welded to the frame, not as padding.
 */
export const MENU_INSET_PX = 8;

/**
 * A rectangle in viewport coordinates, the four numbers a DOMRect carries that
 * matter here. `getBoundingClientRect()` satisfies this shape directly, and so
 * does an object literal, which is the whole point.
 */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Everything the caller needs to write onto the popup. `left` and `top` go
 * straight into the style as pixels, `maxHeight` into `max-height` alongside
 * `overflow-y: auto`, and `flipped` is there for whoever wants to know which
 * way it opened (a transform origin, a test, a class).
 */
export interface Placement {
  left: number;
  top: number;
  maxHeight: number;
  flipped: boolean;
}

/**
 * Place a popup of `menuW` x `menuH` against `anchor`, inside `visible`.
 *
 * `visible` is the box the popup must stay within, and on a phone that is NOT
 * the window: the soft keyboard covers the bottom of it, and a menu placed into
 * the covered strip is exactly as unreachable as one placed off screen. The
 * shell already publishes the covered height as `--kb-offset` on <html>
 * (src/mobile/viewport.ts), so the caller subtracts it and hands the shortened
 * box here. `--app-vh` is the wrong number for this; it is deliberately
 * `window.innerHeight` and does not shrink with the keyboard, and viewport.ts
 * says why at its line 280.
 *
 * Below wins ties. That is not a coin toss: below is what the popup does today
 * and the ask was to fix visibility without moving a menu people already know
 * the position of. It flips only when staying below would put the menu somewhere
 * it cannot be read.
 */
export function placeMenu(
  anchor: Box,
  menuW: number,
  menuH: number,
  visible: Box,
  inset: number = MENU_INSET_PX,
): Placement {
  const roomBelow = visible.bottom - anchor.bottom;
  const roomAbove = anchor.top - visible.top;

  // The inset counts as part of fitting. Without it "fits" would mean "reaches
  // the very edge", and the popup would sit flush against the bottom of the
  // window in the one case the whole change exists to fix.
  const fitsBelow = menuH + inset <= roomBelow;
  const fitsAbove = menuH + inset <= roomAbove;
  const flipped = !fitsBelow && (fitsAbove || roomAbove > roomBelow);

  // The safety net, for a menu too tall for either side. At three projects the
  // menu is 317px and every side is hundreds of pixels, so this is slack that
  // nobody sees; the menu grows by one "Move to" row per project, so it starts
  // to bite somewhere around twenty of them. `Math.max` because a row can sit
  // outside the visible box entirely (the keyboard rose over it, the list
  // scrolled), and a negative `max-height` is a parse error that would drop the
  // declaration and the clamp with it.
  const maxHeight = Math.max(0, (flipped ? roomAbove : roomBelow) - inset);

  // What the popup will actually occupy once `max-height` has had its say. A
  // flipped menu hangs from its bottom edge, so it is the drawn height, not the
  // natural one, that decides where the top goes.
  const drawn = Math.min(menuH, maxHeight);
  const top = flipped ? anchor.top - drawn : anchor.bottom;

  // Right edges aligned, which is what `right: 0` did and what the sidebar
  // looks like today. Then two clamps, in this order: pull the menu back from
  // the right edge first, push it off the left edge second, so that a menu too
  // wide for the visible box loses its far end rather than its beginning.
  let left = anchor.right - menuW;
  if (left + menuW > visible.right - inset) left = visible.right - inset - menuW;
  if (left < visible.left + inset) left = visible.left + inset;

  return { left, top, maxHeight, flipped };
}
