/**
 * The session bar: the T3 header's geometry, and that it FITS on a phone.
 *
 * The header is a round back button (phone only), a title with a
 * "project · state" subtitle, and one rounded group holding the view icon and
 * "…" (docs/plans/2026-09-27-text-view-t3-pass.md, "Phone header"; prototype
 * composer/6-t3.html, `.hd`). Sizes are the prototype's: 56px on a desktop pane
 * with a 15px title and a 36px group; on a phone a 44px back button, a 17px/650
 * title over a 13px subtitle, and a 44px group with a 22px radius.
 *
 * TWO HISTORIES THIS KEEPS. Reported 2026-08-17 and 2026-08-19: the old bar ran
 * past its right edge at 390px and pushed the way back to the terminal off
 * screen, because the session name could not shrink. The title block is now the
 * one item that gives up width, and every control beside it is fixed.
 *
 * And the BarSlot comment in SessionView.tsx: a change in the bar's height
 * resizes the terminal under it and sends grid POSTs. So the height is a fixed
 * number, the same in the Text and Terminal views and whatever the bar holds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FLIP_QUERY } from "../src/mobile/pointer";

const css = readFileSync(resolve(process.cwd(), "src/sidebar.css"), "utf8");

/** The body of the block opened by `at`, found by balancing braces. */
const blockAt = (at: number, what: string): string => {
  expect(at, what).toBeGreaterThan(-1);
  const start = css.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced ${what}`);
};

/** The phone block, by the query mobile/pointer.ts shares with it. */
const phone = (): string => blockAt(css.indexOf(`@media ${FLIP_QUERY}`), "the phone block");

/** The top level of the sheet: every @media block cut out. */
const topLevel = (): string => {
  let out = "";
  let from = 0;
  for (;;) {
    const at = css.indexOf("@media", from);
    if (at < 0) return out + css.slice(from);
    out += css.slice(from, at);
    const body = blockAt(at, "a media block");
    from = css.indexOf(body, at) + body.length + 1;
  }
};

/** The declarations of the rule one of whose selectors is exactly `selector`.
 *  Comments go first: several quote a rule, braces and all. */
const ruleFor = (block: string, selector: string): string => {
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((x) => x.trim());
    if (selectors.includes(selector)) return m[2] ?? "";
  }
  expect.fail(`${selector} in the block`);
};

describe("the header on a desktop pane", () => {
  it("is a fixed 56px, so switching views or tiles never moves the terminal", () => {
    const bar = ruleFor(topLevel(), ".tl-session-bar");
    expect(bar).toMatch(/height:\s*56px/);
    expect(bar).toMatch(/box-sizing:\s*border-box/);
    expect(bar).toMatch(/flex:\s*0 0 auto/);
  });

  it("draws the title at 15px over a 12.5px subtitle", () => {
    const top = topLevel();
    expect(ruleFor(top, ".tl-bar-title")).toMatch(/font-size:\s*15px/);
    expect(ruleFor(top, ".tl-bar-sub")).toMatch(/font-size:\s*12\.5px/);
  });

  it("holds the view icon and … in one 36px group with a pill radius", () => {
    const group = ruleFor(topLevel(), ".tl-bar-group");
    expect(group).toMatch(/height:\s*36px/);
    expect(group).toMatch(/border-radius:\s*18px/);
  });

  it("pulses the running dot and nothing else", () => {
    expect(ruleFor(topLevel(), '.tl-bar-state[data-s="working"]')).toMatch(/animation:/);
  });
});

describe("the header on a phone", () => {
  it("is 58px: a 44px row with the prototype's 6px over and 8px under", () => {
    const bar = ruleFor(phone(), ".tl-session-bar");
    expect(bar).toMatch(/height:\s*58px/);
    expect(bar).toMatch(/padding:\s*6px 14px 8px/);
  });

  it("draws a round 44px back button", () => {
    const back = ruleFor(phone(), ".tl-session-bar .tl-back-btn");
    expect(back).toMatch(/width:\s*44px/);
    expect(back).toMatch(/height:\s*44px/);
    expect(back).toMatch(/border-radius:\s*50%/);
  });

  it("titles at 17px/650 over a 13px subtitle", () => {
    const title = ruleFor(phone(), ".tl-bar-title");
    expect(title).toMatch(/font-size:\s*17px/);
    expect(title).toMatch(/font-weight:\s*650/);
    expect(ruleFor(phone(), ".tl-bar-sub")).toMatch(/font-size:\s*13px/);
  });

  it("grows the group to 44px with a 22px radius", () => {
    const group = ruleFor(phone(), ".tl-bar-group");
    expect(group).toMatch(/height:\s*44px/);
    expect(group).toMatch(/border-radius:\s*22px/);
  });
});

describe("the header fits at 390px", () => {
  // The title block is the ONE item that shrinks: it ellipsizes, while a
  // control that shrank below its content would paint over its neighbour.
  it("lets the title block give up width, and nothing else", () => {
    const head = ruleFor(topLevel(), ".tl-bar-head");
    expect(head).toMatch(/flex:\s*1 1 auto/);
    expect(head).toMatch(/min-width:\s*0/);
    expect(ruleFor(topLevel(), ".tl-session-bar > *")).toMatch(/flex:\s*0 0 auto/);
  });

  // Each line clips itself, so the block does not have to: a clipping block
  // would cut off the switcher's menu as it drops below the title.
  it("ellipsizes the title and the subtitle rather than wrapping them", () => {
    const title = ruleFor(topLevel(), ".tl-bar-title");
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/white-space:\s*nowrap/);
    expect(ruleFor(topLevel(), ".tl-bar-sub")).toMatch(/white-space:\s*nowrap/);
    const text = ruleFor(topLevel(), ".tl-bar-sub-text");
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
    expect(text).toMatch(/min-width:\s*0/);
    expect(ruleFor(topLevel(), ".tl-bar-head")).not.toMatch(/overflow:/);
  });

  // On a phone the title is the session switcher, so the flex child inside the
  // title block is the picker wrapper, and the button inside it has to be free
  // to ellipsize (the 2026-08-19 report: the Terminal segment started at
  // x=389.6 because the wrapper could not shrink).
  it("lets the switcher's wrapper shrink with it", () => {
    const wrapper = ruleFor(topLevel(), ".tl-bar-head > .tl-session-picker");
    expect(wrapper).toMatch(/display:\s*flex/);
    expect(wrapper).toMatch(/min-width:\s*0/);
    expect(ruleFor(topLevel(), ".tl-session-picker > .tl-bar-title")).toMatch(/min-width:\s*0/);
  });

  it("hides the terminal tools the soft-key row already carries", () => {
    const narrow = blockAt(css.indexOf("@media (max-width: 520px)"), "the narrow block");
    expect(ruleFor(narrow, ".tl-term-tools")).toMatch(/display:\s*none/);
  });

  // The touch block sets `.tl-session-bar > * { flex: 0 0 auto }` so a control
  // cannot shrink below its content. The act-as chip is the other item whose
  // text ellipsizes, and it needs the same selector shape to win.
  it("makes the act-as chip shrink too", () => {
    const narrow = blockAt(css.indexOf("@media (max-width: 520px)"), "the narrow block");
    const rule = ruleFor(narrow, ".tl-session-bar > .tl-actas-chip");
    expect(rule).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/max-width:\s*26vw/);
  });
});
