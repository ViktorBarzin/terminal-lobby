/**
 * The field is the right size before anyone touches it.
 *
 * Viktor: "the prompt is not the right size ... when i click it it resizes
 * correctly." That second half names the bug precisely. Clicking the textarea
 * calls sync(), which calls autosize() — so the field was only ever measured
 * once the reader touched it, and whatever height the ONE measurement at mount
 * produced was frozen in px until then.
 *
 * A single measurement is the wrong shape here, because more than one thing
 * that decides a line's height arrives after it:
 *   - the webfont, which changes the metrics when it swaps in;
 *   - the pinch scale, which reaches the field through a custom property on an
 *     ancestor;
 *   - the field's own width, which decides how many lines the text wraps to.
 *
 * So the height is re-derived whenever any of those move, rather than pinned by
 * whichever moment mount happened to fall in. Width only, from the observer:
 * autosize writes the HEIGHT, so reacting to height would chase itself.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";

const noop = () => {};
const sent = async (): Promise<boolean> => true;

/** Observers created during a render, so one can be fired on demand. */
type Stub = { target: Element; fire: () => void };
let observers: Stub[] = [];

function installResizeObserver() {
  class FakeRO {
    private cb: () => void;
    constructor(cb: () => void) {
      this.cb = cb;
    }
    observe(target: Element) {
      observers.push({ target, fire: () => this.cb() });
    }
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal("ResizeObserver", FakeRO as unknown as typeof ResizeObserver);
}

/** A textarea whose one line is `lh` tall, in a border-box with 18px padding. */
function stubBox(ta: HTMLTextAreaElement, lh: () => number) {
  const PAD = 18;
  Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => lh() + PAD });
  Object.defineProperty(ta, "offsetHeight", {
    configurable: true,
    get: () => parseFloat(ta.style.height) || lh() + PAD,
  });
  Object.defineProperty(ta, "clientHeight", {
    configurable: true,
    get: () => parseFloat(ta.style.height) || lh() + PAD,
  });
}

const mount = () => {
  observers = [];
  installResizeObserver();
  const r = render(() => (
    <Composer working={false} pending={[]} onSend={sent} onStop={noop} onResolve={noop} />
  ));
  const ta = r.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
  return { ...r, ta };
};

describe("the field is sized before it is touched", () => {
  it("measures itself on mount, with no draft and no click", () => {
    const { ta } = mount();
    stubBox(ta, () => 24);
    // The observer fires once when the element is first laid out.
    observers.forEach((o) => o.fire());
    expect(parseFloat(ta.style.height), "a height without a click").toBeGreaterThan(0);
    expect(ta.scrollHeight).toBeLessThanOrEqual(ta.clientHeight + 1);
  });

  it("re-measures when the box it sits in changes width", () => {
    // The width decides how many lines the text wraps to, and it changes when
    // the sidebar collapses or the phone rotates.
    const { ta } = mount();
    let lh = 24;
    let width = 400;
    stubBox(ta, () => lh);
    Object.defineProperty(ta, "clientWidth", { configurable: true, get: () => width });
    observers.forEach((o) => o.fire());
    const first = parseFloat(ta.style.height);
    width = 200; // narrower...
    lh = 48; // ...so the same text now wraps to two lines
    observers.forEach((o) => o.fire());
    expect(parseFloat(ta.style.height)).toBeGreaterThan(first);
  });

  it("re-measures once the webfont has swapped in", async () => {
    // Before the font loads the metrics are the fallback's, and a height frozen
    // then is wrong for the type the reader actually sees.
    let resolveFonts: () => void = noop;
    const ready = new Promise<void>((r) => (resolveFonts = r));
    vi.stubGlobal("document", document);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready, status: "loading" },
    });
    const { ta } = mount();
    let lh = 20; // fallback metrics
    stubBox(ta, () => lh);
    observers.forEach((o) => o.fire());
    const fallback = parseFloat(ta.style.height);
    lh = 28; // the real font is taller
    resolveFonts();
    await ready;
    await Promise.resolve();
    expect(parseFloat(ta.style.height), "re-measured after the font").toBeGreaterThan(fallback);
  });
});
