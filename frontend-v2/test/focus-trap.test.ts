import { describe, it, expect, beforeEach } from "vitest";
import { tabbables, wrapTab } from "../src/lib/focus-trap";

/** A dialog with three tabbable controls and one that is not. */
function dialog(): HTMLElement {
  document.body.innerHTML = `
    <button id="behind">app behind the dialog</button>
    <div id="dlg" tabindex="-1">
      <a href="#" id="a">first</a>
      <button id="b">middle</button>
      <button id="c" disabled>disabled</button>
      <span id="d">not tabbable</span>
      <input id="e" />
    </div>`;
  return document.getElementById("dlg") as HTMLElement;
}

const key = (shift = false): KeyboardEvent =>
  new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, cancelable: true });

describe("tabbables", () => {
  beforeEach(() => void dialog());

  it("returns the focusable descendants in DOM order", () => {
    expect(tabbables(dialog()).map((el) => el.id)).toEqual(["a", "b", "e"]);
  });

  it("leaves out a disabled control and a plain element", () => {
    const ids = tabbables(dialog()).map((el) => el.id);
    expect(ids).not.toContain("c");
    expect(ids).not.toContain("d");
  });

  it("does not include the dialog's own tabindex=-1 root", () => {
    expect(tabbables(dialog()).map((el) => el.id)).not.toContain("dlg");
  });
});

describe("wrapTab", () => {
  let dlg: HTMLElement;
  beforeEach(() => {
    dlg = dialog();
  });

  it("sends Tab off the last control back to the first", () => {
    (document.getElementById("e") as HTMLElement).focus();
    const e = key();
    wrapTab(e, dlg);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("sends Shift-Tab off the first control to the last", () => {
    (document.getElementById("a") as HTMLElement).focus();
    const e = key(true);
    wrapTab(e, dlg);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("e");
  });

  it("treats Shift-Tab on the dialog root as being at the start", () => {
    dlg.focus();
    wrapTab(key(true), dlg);
    expect(document.activeElement?.id).toBe("e");
  });

  // aria-modal="true" promises Tab cannot leave, so focus parked outside has to
  // be pulled back in rather than allowed to walk the app behind the backdrop.
  it("pulls focus back in when it is outside the dialog", () => {
    (document.getElementById("behind") as HTMLElement).focus();
    wrapTab(key(), dlg);
    expect(document.activeElement?.id).toBe("a");
  });

  it("pulls focus back to the end for Shift-Tab from outside", () => {
    (document.getElementById("behind") as HTMLElement).focus();
    wrapTab(key(true), dlg);
    expect(document.activeElement?.id).toBe("e");
  });

  it("leaves a Tab in the middle of the run to the browser", () => {
    (document.getElementById("a") as HTMLElement).focus();
    const e = key();
    wrapTab(e, dlg);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement?.id).toBe("a");
  });

  it("focuses the dialog itself when it holds nothing tabbable", () => {
    document.body.innerHTML = `<div id="empty" tabindex="-1"><span>text</span></div>`;
    const empty = document.getElementById("empty") as HTMLElement;
    const e = key();
    wrapTab(e, empty);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("empty");
  });
});
