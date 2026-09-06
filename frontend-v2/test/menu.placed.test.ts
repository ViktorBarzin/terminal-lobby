/**
 * The sidebar ⋯ popups are placed against the window; the other three are not.
 *
 * `.tl-menu` is five popups: the session card's ⋯, the group header's ⋯, the
 * sidebar header's ordering picker, the session bar's overflow menu and the
 * model picker. Only the first two were unreadable — they hang off a row that
 * can sit anywhere down a scrolling list, and measured at 1440x900 with 25
 * sessions on 2026-09-06 the card menu stood 317px tall and hung 259px past the
 * bottom of the window. The other three live in top bars with the whole screen
 * below them, and one carries placement of its own, so the change is opt-in and
 * this file is what says so: the base rule still anchors to its row, and exactly
 * two components ask for anything else.
 *
 * The CSS half is asserted as stylesheet text because jsdom does no layout and
 * loads no stylesheet, so `position: fixed` has no observable consequence in a
 * test — the declaration IS the behaviour here. `visibleViewport` reads the DOM
 * rather than laying it out, so that half is asserted for real.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { visibleViewport } from "../src/components/menu";

const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");

/** The body of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1]!.trim().split("\n").pop()!.trim();
    if (sel === selector) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

/** Every file under src/ whose text contains `needle`, repo-relative. */
function srcFilesContaining(needle: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && readFileSync(p, "utf8").includes(needle)) {
        out.push(p.slice(resolve(process.cwd(), "src").length + 1));
      }
    }
  };
  walk(resolve(process.cwd(), "src"));
  return out.sort();
}

describe("the placed popup escapes the list it was trapped in", () => {
  const placed = ruleBody(".tl-menu-placed");

  it("is fixed, so no scroll port or overflow:hidden ancestor clips it", () => {
    // Absolute made the popup part of the session list: opening it grew
    // .tl-sidebar-scroll's scrollHeight from 908px to 1216px, so the options at
    // the bottom of it had to be scrolled to.
    expect(placed).toMatch(/(^|[\s;])position:\s*fixed/);
  });

  it("drops the row-relative anchoring the base rule sets", () => {
    // Leaving either in place would fight the computed left/top: `right: 0`
    // pins the far edge to the viewport and `top: 100%` is a whole window down.
    expect(placed).toMatch(/(^|[\s;])right:\s*auto/);
    expect(placed).toMatch(/(^|[\s;])top:\s*0/);
  });

  it("stays hidden until it has been measured", () => {
    // The popup has to be laid out somewhere to have a height at all, and this
    // is what keeps the reader from seeing it there. createDismissableMenu
    // writes `visibility: visible` into the inline style once it has placed it.
    expect(placed).toMatch(/(^|[\s;])visibility:\s*hidden/);
  });

  it("scrolls inside itself when it is taller than the room it has", () => {
    // Pairs with the max-height placeMenu computes. Slack at three projects,
    // where the menu is 317px; it grows a row per project.
    expect(placed).toMatch(/(^|[\s;])overflow-y:\s*auto/);
  });
});

describe("the three popups that were fine are left alone", () => {
  it("keeps the base rule anchored to the row that owns it", () => {
    const base = ruleBody(".tl-menu");
    expect(base).toMatch(/(^|[\s;])position:\s*absolute/);
    expect(base).toMatch(/(^|[\s;])top:\s*100%/);
    expect(base).toMatch(/(^|[\s;])right:\s*0/);
    expect(base).not.toMatch(/(^|[\s;])position:\s*fixed/);
  });

  it("is opted into by the two sidebar menus and nothing else", () => {
    // Both halves of the opt-in, matched as they are WRITTEN at a call site so
    // that menu.ts naming either one in its own documentation does not count.
    const sidebar = ["components/ProjectGroup.tsx", "components/SessionCard.tsx"];
    expect(srcFilesContaining('class="tl-menu tl-menu-placed"')).toEqual(sidebar);
    expect(srcFilesContaining(", { placed: true })")).toEqual(sidebar);
  });
});

describe("the box a popup has to stay inside", () => {
  afterEach(() => document.documentElement.style.removeProperty("--kb-offset"));

  it("is the whole window when no keyboard is up", () => {
    expect(visibleViewport()).toEqual({
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    });
  });

  it("gives up whatever the soft keyboard covers", () => {
    // A menu placed behind the keyboard is exactly as unreachable as one placed
    // off the bottom of the screen, and --kb-offset is the number the shell
    // already measures for every other fixed-bottom surface in the app.
    document.documentElement.style.setProperty("--kb-offset", "336px");
    expect(visibleViewport().bottom).toBe(window.innerHeight - 336);
  });

  it("reads no keyboard when the property is absent or not a length", () => {
    // The property only exists once mobile/viewport.ts has wired its listeners,
    // and a NaN here would put the popup nowhere at all.
    document.documentElement.style.setProperty("--kb-offset", "auto");
    expect(visibleViewport().bottom).toBe(window.innerHeight);
  });
});
