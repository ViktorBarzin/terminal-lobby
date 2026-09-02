/**
 * The compose field has to be as tall as the text in it.
 *
 * Viktor sent a screenshot of a draft sliced in half: the glyphs' top halves
 * showed and the rest was cut off by the field's own bottom edge. Measured on
 * master at 390x844 with one line typed:
 *
 *   font 16px, line-height 24px, inline height 42px, clientHeight 40,
 *   scrollHeight 42  -> clipped by 2px
 *   after a pinch:  font 23.5px, line-height 35.2px, height STILL 42px,
 *   scrollHeight 53 -> clipped by 13px
 *
 * Two separate faults.
 *
 * ONE: autosize sets `height = scrollHeight`, and everything here is
 * border-box (app.css:5). scrollHeight covers content plus padding but NOT the
 * border, so a bordered field is short by exactly its borders on every measure.
 * The 2px is the 1px top and bottom.
 *
 * TWO: nothing re-measures when the FONT changes. The height is written in px
 * at the moment of typing, so a pinch afterwards grows the text inside a box
 * that stays where it was. That is the 13px, and it grows with the scale.
 */
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { Composer } from "../src/components/Composer";

const noop = () => {};
const sent = async (): Promise<boolean> => true;

/** jsdom lays nothing out, so the box model is supplied. A textarea whose text
 *  needs `lines` lines at `lh` line-height, in a border-box with 9px padding
 *  and a 1px border. */
function stubBox(ta: HTMLTextAreaElement, lh: () => number, lines: () => number) {
  const PAD = 18;
  const BORDER = 2;
  // scrollHeight is content + padding, never the border — the behaviour the
  // fix exists for.
  const content = () => lines() * lh() + PAD;
  const fixed = () => {
    const h = parseFloat(ta.style.height);
    return Number.isFinite(h) ? h : null;
  };
  Object.defineProperty(ta, "scrollHeight", { configurable: true, get: content });
  // With height:auto the box is whatever the content needs; with a px height it
  // is that. border-box, so clientHeight excludes the border either way.
  Object.defineProperty(ta, "offsetHeight", {
    configurable: true,
    get: () => fixed() ?? content() + BORDER,
  });
  Object.defineProperty(ta, "clientHeight", {
    configurable: true,
    get: () => (fixed() ?? content() + BORDER) - BORDER,
  });
}

describe("the compose field fits its own text", () => {
  it("leaves room for the border, which scrollHeight does not include", () => {
    const { getByLabelText } = render(() => (
      <Composer working={false} pending={[]} onSend={sent} onStop={noop} onResolve={noop} />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    stubBox(ta, () => 24, () => 1);
    fireEvent.input(ta, { target: { value: "done i sized int, try now" } });
    // scrollHeight is 1*24 + 18 = 42; the field must be 44 so the content box
    // is still 24. Setting 42 leaves 22 for a 24px line.
    expect(parseFloat(ta.style.height)).toBeGreaterThanOrEqual(44);
    expect(ta.scrollHeight, "no overflow left").toBeLessThanOrEqual(ta.clientHeight + 1);
  });

  it("grows when the pinch grows the text under it", () => {
    // The field is sized in px at the moment of typing. A pinch afterwards
    // changes the font and nothing re-measured, so the line outgrew its box.
    const [size, setSize] = createSignal(15);
    const { getByLabelText } = render(() => (
      <Composer
        working={false}
        pending={[]}
        onSend={sent}
        onStop={noop}
        onResolve={noop}
        textSize={size()}
      />
    ));
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    let lh = 24;
    stubBox(ta, () => lh, () => 1);
    fireEvent.input(ta, { target: { value: "one line" } });
    const small = parseFloat(ta.style.height);

    lh = 36; // the same one line, at a bigger size
    setSize(22);
    expect(parseFloat(ta.style.height), "re-measured after the size changed").toBeGreaterThan(small);
    expect(ta.scrollHeight).toBeLessThanOrEqual(ta.clientHeight + 1);
  });
});

describe("the field does not draw a second box inside the composer's", () => {
  it("has no border of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");
    const rule = /\.tl-composer-input\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""));
    expect(rule, "a rule for .tl-composer-input").not.toBeNull();
    const body = rule![1]!;
    // The composer box around it carries the border and the fill. The field
    // declared `border: 0` and then set one again lower in the same block, so
    // the later declaration won and there were two boxes.
    expect(body.match(/border:\s*1px/), "a second border").toBeNull();
    expect(body.match(/background:\s*var\(--bg-card\)/), "a second fill").toBeNull();
  });
});
