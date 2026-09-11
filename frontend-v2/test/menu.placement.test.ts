/**
 * Where a sidebar ⋯ popup goes, decided as arithmetic so a test can see it.
 *
 * Measured in a real browser on 2026-09-06 at 1440x900 with 25 sessions
 * listed. The popup is a `.tl-menu` rendered inside the card that owns it, at
 * `position: absolute; top: 100%; right: 0`. Opened on a card near the bottom
 * it stood 317px tall, hung 308px past the end of the sidebar's scroll port and
 * 259px past the window, and grew `.tl-sidebar-scroll`'s scrollHeight from
 * 908px to 1216px. So reaching the options at the bottom of it meant scrolling
 * the session list, which is the report: "near the bottom of the screen it goes
 * off screen and i have to scroll to see the options".
 *
 * The fix is a `position: fixed` popup whose left and top are computed when it
 * opens. `placeMenu` is that computation, and it lives away from the DOM for
 * one reason: jsdom does no layout, so `getBoundingClientRect` returns zeros
 * there. A placement asserted through a rendered component would be asserting
 * against a viewport 0px wide and a menu 0px tall, which is to say against
 * nothing. Handing the function plain rectangles is what makes the decision
 * testable at all.
 *
 * The floor device is an iPad on iPadOS 15.8, which is why vite.config.ts pins
 * `target: "safari15"`. That rules out the popover API (Safari 17) and CSS
 * anchor positioning, so measuring and then placing in JS is not a preference
 * here, it is the only route that clears the floor.
 */
import { describe, expect, it } from "vitest";
import { MENU_INSET_PX, placeMenu, type Box } from "../src/components/menu.logic";

/** The window the bug was measured in. */
const desktop: Box = { top: 0, bottom: 900, left: 0, right: 1440 };

/** A session card in that sidebar: 242px wide, starting 10px in. */
const card = (top: number, height = 29.5): Box => ({
  top,
  bottom: top + height,
  left: 10,
  right: 252,
});

/** The desktop menu as it measures today: 8 items, 13px rows. */
const MENU_W = 167;
const MENU_H = 317;

describe("which side the popup opens on", () => {
  it("opens below the row when the menu fits below", () => {
    const p = placeMenu(card(100), MENU_W, MENU_H, desktop);
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(129.5);
  });

  it("flips above when there is no room below", () => {
    // 900 - 730 = 170px below, and the menu wants 317.
    const p = placeMenu(card(700, 30), MENU_W, MENU_H, desktop);
    expect(p.flipped).toBe(true);
    // Flipped means the menu's BOTTOM edge sits on the row's top edge, so the
    // popup grows away from the row exactly as it does downwards.
    expect(p.top).toBe(700 - MENU_H);
  });

  it("opens below when both sides fit", () => {
    // Not an arbitrary tie-break. Below is what the popup does today and the
    // ask was to fix visibility without moving the menu people already know.
    const p = placeMenu(card(400, 30), MENU_W, 100, desktop);
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(430);
  });

  it("counts the inset as part of fitting, so the popup is never flush", () => {
    // Exactly 325px below: 317 of menu and 8 of inset. One pixel less and the
    // promise of a gap at the bottom edge would be the thing that broke.
    expect(placeMenu(card(570, 5), MENU_W, MENU_H, desktop).flipped).toBe(false);
    expect(placeMenu(card(571, 5), MENU_W, MENU_H, desktop).flipped).toBe(true);
  });
});

describe("when the menu fits on neither side", () => {
  /** A sidebar in a 300px-tall window: no side has room for 317px of menu. */
  const cramped: Box = { top: 0, bottom: 300, left: 0, right: 1440 };

  it.each([
    {
      name: "more room above, so it flips and clamps to the room above",
      anchor: card(200, 30),
      flipped: true,
      maxHeight: 192, // 200 above, less the 8px inset
      top: 8, // and the clamped menu's top edge lands on that inset
    },
    {
      name: "more room below, so it stays below and clamps to the room below",
      anchor: card(60, 30),
      flipped: false,
      maxHeight: 202, // 300 - 90 - 8
      top: 90,
    },
  ])("$name", ({ anchor, flipped, maxHeight, top }) => {
    const p = placeMenu(anchor, MENU_W, MENU_H, cramped);
    expect(p.flipped).toBe(flipped);
    expect(p.maxHeight).toBe(maxHeight);
    expect(p.top).toBe(top);

    // The clamp is only worth anything if what it produces is on screen. The
    // popup scrolls its own overflow at `maxHeight`, so that, not the menu's
    // natural height, is what occupies the window.
    const shown = Math.min(MENU_H, p.maxHeight);
    expect(p.top).toBeGreaterThanOrEqual(cramped.top);
    expect(p.top + shown).toBeLessThanOrEqual(cramped.bottom);
  });
});

describe("how far down the popup is allowed to grow", () => {
  it("offers the room on the side it chose, less the inset", () => {
    const p = placeMenu(card(813, 29.5), MENU_W, MENU_H, desktop);
    expect(p.flipped).toBe(true);
    expect(p.maxHeight).toBe(813 - MENU_INSET_PX);
  });

  it("changes nothing at the menu's size today", () => {
    // The safety net has to be invisible at three projects. The menu only
    // grows by one "Move to" row per project, so a max-height that bites now
    // would be a regression, not a guard.
    for (const top of [40, 300, 600, 813]) {
      const p = placeMenu(card(top), MENU_W, MENU_H, desktop);
      expect(p.maxHeight).toBeGreaterThanOrEqual(MENU_H);
    }
  });

  it("never offers a negative height, however little room there is", () => {
    // A window barely taller than the row it holds leaves less than the inset
    // on both sides. The caller writes this number straight into `max-height`,
    // where a negative is a parse error and the whole declaration is dropped,
    // taking the clamp with it.
    const p = placeMenu({ top: 5, bottom: 55, left: 10, right: 252 }, MENU_W, MENU_H, {
      top: 0,
      bottom: 60,
      left: 0,
      right: 1440,
    });
    expect(p.maxHeight).toBe(0);
  });
});

describe("where the popup sits horizontally", () => {
  it("aligns its right edge with the row's right edge", () => {
    // What `right: 0` does today. The change is about visibility, so the look
    // stays put.
    const p = placeMenu(card(100), MENU_W, MENU_H, desktop);
    expect(p.left).toBe(252 - MENU_W);
  });

  it.each([
    {
      name: "a row near the left edge cannot push the menu off the left",
      anchor: { top: 100, bottom: 130, left: 2, right: 60 },
      menuW: MENU_W,
      left: 8, // visible.left + inset, rather than 60 - 167 = -107
    },
    {
      name: "a row near the right edge cannot push the menu off the right",
      anchor: { top: 100, bottom: 130, left: 1300, right: 1438 },
      menuW: MENU_W,
      left: 1265, // so the right edge lands on 1432, the inset short of 1440
    },
    {
      // Both clamps want this one and they disagree, so the left edge wins and
      // the menu's far end is what runs off. A popup you cannot see the start
      // of is worse than one you cannot see the end of.
      name: "a menu wider than the window keeps its left edge on screen",
      anchor: { top: 100, bottom: 130, left: 1300, right: 1438 },
      menuW: 1440,
      left: 8,
    },
  ])("$name", ({ anchor, menuW, left }) => {
    expect(placeMenu(anchor, menuW, MENU_H, desktop).left).toBe(left);
  });
});

describe("the soft keyboard's share of the window", () => {
  // A 390x844 phone. The shell already publishes the keyboard's covered height
  // as `--kb-offset` on <html> (src/mobile/viewport.ts), so the caller reads
  // that and hands the shortened box here. `--app-vh` is deliberately
  // window.innerHeight and does not shrink with the keyboard, which is why it
  // is the wrong number for this and viewport.ts says so at its line 280.
  const phone: Box = { top: 0, bottom: 844, left: 0, right: 390 };
  const covered: Box = { ...phone, bottom: 844 - 336 };
  const row: Box = { top: 470, bottom: 518, left: 8, right: 382 };
  const phoneMenuW = 190; // the (pointer: coarse) min-width
  const phoneMenuH = 280; // 40px rows

  it("opens below the row with the keyboard down", () => {
    const p = placeMenu(row, phoneMenuW, phoneMenuH, phone);
    expect(p.flipped).toBe(false);
    expect(p.top).toBe(518);
  });

  it("flips above once the keyboard takes the bottom 336px", () => {
    const p = placeMenu(row, phoneMenuW, phoneMenuH, covered);
    expect(p.flipped).toBe(true);
    expect(p.top).toBe(470 - phoneMenuH);
    // Which is the whole point: the last row of the menu is above the keys.
    expect(p.top + phoneMenuH).toBeLessThanOrEqual(covered.bottom);
  });
});

describe("the case that was measured", () => {
  // The exact rectangles read off the deployed build on 2026-09-06: the last
  // card in a 25-session list, its menu, and a 1440x900 window.
  const anchor: Box = { top: 813, bottom: 842.5, left: 10, right: 252 };

  it("puts the whole menu on screen instead of 259px past the bottom", () => {
    const p = placeMenu(anchor, MENU_W, MENU_H, desktop);
    // 900 - 842.5 leaves 57.5px below the row, against 317px of menu.
    expect(p.flipped).toBe(true);
    expect(p.top).toBe(496);
    expect(p.left).toBe(85);
    expect(p.maxHeight).toBe(805);
    expect(p.top + MENU_H).toBeLessThanOrEqual(desktop.bottom);
  });
});

describe("the popup is on screen wherever the row is", () => {
  // The sweep the bug would have failed: a row every 25px down the sidebar,
  // and the same four assertions each time. Nothing here is about a
  // particular row, which is the point.
  const rows = Array.from({ length: 35 }, (_, i) => i * 25);

  it.each(rows)("desktop, row at y=%i", (top) => {
    const p = placeMenu(card(top), MENU_W, MENU_H, desktop);
    const shown = Math.min(MENU_H, p.maxHeight);
    expect(p.top).toBeGreaterThanOrEqual(desktop.top);
    expect(p.top + shown).toBeLessThanOrEqual(desktop.bottom);
    expect(p.left).toBeGreaterThanOrEqual(desktop.left);
    expect(p.left + MENU_W).toBeLessThanOrEqual(desktop.right);
  });

  const phoneWithKeyboard: Box = { top: 0, bottom: 508, left: 0, right: 390 };
  const phoneRows = Array.from({ length: 13 }, (_, i) => i * 40);

  it.each(phoneRows)("phone behind the keyboard, row at y=%i", (top) => {
    const anchor: Box = { top, bottom: top + 48, left: 8, right: 382 };
    const p = placeMenu(anchor, 190, 328, phoneWithKeyboard);
    const shown = Math.min(328, p.maxHeight);
    expect(p.top).toBeGreaterThanOrEqual(phoneWithKeyboard.top);
    expect(p.top + shown).toBeLessThanOrEqual(phoneWithKeyboard.bottom);
    expect(p.left).toBeGreaterThanOrEqual(phoneWithKeyboard.left);
    expect(p.left + 190).toBeLessThanOrEqual(phoneWithKeyboard.right);
  });
});

describe("the inset", () => {
  it("defaults to 8px", () => {
    expect(MENU_INSET_PX).toBe(8);
  });

  it("can be turned off, which puts the popup flush against the edge", () => {
    const p = placeMenu({ top: 100, bottom: 130, left: 2, right: 60 }, MENU_W, MENU_H, desktop, 0);
    expect(p.left).toBe(0);
    expect(p.maxHeight).toBe(770);
  });
});
