/**
 * The soft keyboard must survive a tap anywhere on the terminal.
 *
 * Viktor, 2026-09-05: *"I still see the keyboard flicker on opening keyboard in
 * terminal mode. and it doesn't work unless I tap in the upper half of the
 * screen"*.
 *
 * A tap focuses the compose mirror at touchend; the tap's compat mousedown
 * arrives 10-44ms later and is hit-tested where the finger was, against the
 * layout as it stands then. The keyboard reserve has meanwhile shrunk the
 * terminal host, so on a viewport that does not shrink with it the press lands
 * off the grid, on something focusable=false, and blurs the mirror.
 *
 * Measured on the shared Android emulator, real Chrome and real touches: with
 * the shipped `interactive-widget=resizes-content` the reserve is 51.6px, the
 * grid is still under the finger, every mousedown targets `div.xterm-screen`,
 * and taps at 30% and 75% of the screen both keep the keyboard. That is the
 * same mechanism seen from its healthy side, and it is why this never showed on
 * Android.
 */
import { describe, it, expect } from "vitest";
import { shouldKeepFocus, takesFocus, type KeepFocusWorld } from "../src/terminal/keepfocus";

/** The reported case: a touch, off the grid, mirror focused, plain chrome under it. */
const flickering: KeepFocusWorld = {
  trusted: true,
  coarsePointer: true,
  insideScreen: false,
  mirrorFocused: true,
  targetTakesFocus: false,
};

describe("shouldKeepFocus", () => {
  it("holds focus for the press that was taking the keyboard down", () => {
    expect(shouldKeepFocus(flickering)).toBe(true);
  });

  it("leaves a press inside the grid to dragselect, which already prevents it", () => {
    expect(shouldKeepFocus({ ...flickering, insideScreen: true })).toBe(false);
  });

  it("leaves a mouse alone, since a fine pointer has no compat mousedown", () => {
    expect(shouldKeepFocus({ ...flickering, coarsePointer: false })).toBe(false);
  });

  it("does nothing when the mirror is not focused, because no keyboard is at stake", () => {
    expect(shouldKeepFocus({ ...flickering, mirrorFocused: false })).toBe(false);
  });

  it("lets a press on a real control focus it", () => {
    expect(shouldKeepFocus({ ...flickering, targetTakesFocus: true })).toBe(false);
  });

  it("ignores our own synthesized clone", () => {
    // dragselect replays a press as an untrusted MouseEvent on the same node.
    expect(shouldKeepFocus({ ...flickering, trusted: false })).toBe(false);
  });

  it("needs every clause, so no single change turns it on by accident", () => {
    const off: KeepFocusWorld = {
      trusted: false,
      coarsePointer: false,
      insideScreen: true,
      mirrorFocused: false,
      targetTakesFocus: true,
    };
    expect(shouldKeepFocus(off)).toBe(false);
    for (const k of Object.keys(off) as (keyof KeepFocusWorld)[]) {
      expect(shouldKeepFocus({ ...off, [k]: !off[k] }), `${k} alone`).toBe(false);
    }
  });
});

describe("takesFocus", () => {
  const el = (html: string): Element => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d.firstElementChild!;
  };

  it("recognises the controls a person means to focus", () => {
    for (const h of ['<input>', '<textarea></textarea>', '<select></select>']) {
      expect(takesFocus(el(h)), h).toBe(true);
    }
  });

  it("finds one through a wrapper, since a press lands on the innermost node", () => {
    const wrap = el('<label><span>name</span><input></label>');
    expect(takesFocus(wrap.querySelector("span"))).toBe(false);
    expect(takesFocus(wrap.querySelector("input"))).toBe(true);
  });

  it("counts a contenteditable", () => {
    const d = document.createElement("div");
    d.setAttribute("contenteditable", "true");
    document.body.appendChild(d);
    expect(takesFocus(d)).toBe(true);
    d.remove();
  });

  it("does NOT count a button: its click still fires, and focus stays in the terminal", () => {
    // This is the soft-key row. Keeping focus is exactly what stops the keyboard
    // collapsing between keystrokes.
    expect(takesFocus(el("<button>Esc</button>"))).toBe(false);
    expect(takesFocus(el('<a href="#">x</a>'))).toBe(false);
  });

  it("is false for the chrome a shrinking host leaves under a finger", () => {
    for (const h of ['<div id="soft-keys"></div>', '<div class="sk-group"></div>',
                     '<div class="tl-session-view"></div>']) {
      expect(takesFocus(el(h)), h).toBe(false);
    }
  });

  it("is false for nothing at all", () => {
    expect(takesFocus(null)).toBe(false);
  });
});
