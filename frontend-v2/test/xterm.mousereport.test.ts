/**
 * THE UPSTREAM BEHAVIOUR THE TOUCH COAST RESTS ON, against the real library.
 *
 * Both scrollers work by dispatching synthetic `deltaMode: 1` wheels on
 * `term.element` (term.html's `emitLineWheel`, :6105-6113), and with mouse
 * reporting on those wheels come back as pty-bound INPUT. `TerminalNative`'s
 * `emittingWheel` and `cancelCoast` exist for exactly that: every byte bound
 * for the pty cancels a flick coast (term.html:8269 and :8341), so a coast that
 * did not exclude its own reports would cancel itself on the first wheel it
 * emitted and a flick would scroll one frame instead of decaying.
 *
 * TerminalNative.wiring.test.tsx drives that fix, and it mocks xterm, so the
 * link measured here is the one thing its fake stands in for. Reading the
 * minified bytes says `bindMouse` consults the custom wheel handler and
 * `coreMouseService.triggerMouseEvent` routes an SGR report through
 * `_coreService.triggerDataEvent` rather than `triggerBinaryEvent`, because
 * only DEFAULT encoding is binary and DECSET 1006 selects SGR. Every one of
 * those is an upstream implementation detail that holds until an xterm bump
 * rewrites it, and nothing else here would say so. So this asserts the
 * BEHAVIOUR: an xterm upgrade that moves the report to `onBinary`, stops
 * consulting the custom handler, or stops reporting a synthetic wheel at all
 * fails here rather than on a phone, where the symptom is a dead flick.
 *
 * jsdom lays nothing out, which is why the two size shims below are needed and
 * why the report's coordinates come out `NaN`. The coordinates are not part of
 * any claim here; that a STRING reaches `onData` synchronously inside
 * `dispatchEvent` is.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

/** tmux `mouse on`: VT200 tracking plus SGR extended coordinates. */
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length) restores.pop()?.();
});

/**
 * jsdom's gaps, and only jsdom's. `matchMedia` is what the baseline test shims
 * for the same library (xterm calls the deprecated `addListener`).
 *
 * The two size shims are the load-bearing ones. xterm's DOM measuring strategy
 * reads `offsetWidth`/`offsetHeight` off a span holding 32 W's; jsdom answers 0
 * for both, `hasValidSize` stays false, and `getMouseReportCoords` bails before
 * the custom wheel handler is ever consulted. A real browser has a size, so
 * giving one back is restoring the environment rather than faking the claim.
 */
function shimJsdomLayout(): void {
  const win = window as unknown as Record<string, unknown>;
  const hadMatchMedia = win.matchMedia;
  win.matchMedia = () => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  restores.push(() => {
    win.matchMedia = hadMatchMedia;
  });

  const measured = (el: HTMLElement, big: number, small: number): number =>
    el.classList.contains("xterm-char-measure-element") ? big : small;
  for (const [name, big, small] of [
    ["offsetWidth", 32 * 8, 800],
    ["offsetHeight", 17, 384],
  ] as const) {
    const had = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement): number {
        return measured(this, big, small);
      },
    });
    restores.push(() => {
      if (had) Object.defineProperty(HTMLElement.prototype, name, had);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    });
  }

  const hadRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const span = this.tagName === "SPAN";
    const width = span ? 32 * 8 : 800;
    const height = span ? 17 : 384;
    return {
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  restores.push(() => {
    Element.prototype.getBoundingClientRect = hadRect;
  });
}

interface Opened {
  term: Terminal;
  /** xterm's own root, which is the node both scrollers dispatch on (:6107). */
  element: HTMLElement;
  data: string[];
  binary: string[];
  /** What the custom wheel handler was shown, as `isTrusted` per call. */
  trust: boolean[];
}

/** A real terminal, open, with mouse reporting on and the wheel path armed. */
async function openReporting(): Promise<Opened> {
  shimJsdomLayout();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800 });
  Object.defineProperty(host, "clientHeight", { value: 600 });
  document.body.appendChild(host);

  const term = new Terminal({ cols: 80, rows: 24 });
  term.open(host);
  restores.push(() => {
    term.dispose();
    host.remove();
  });

  const data: string[] = [];
  const binary: string[] = [];
  const trust: boolean[] = [];
  term.onData((d) => void data.push(d));
  term.onBinary((d) => void binary.push(d));
  // `true` is what wheel.ts answers for an untrusted wheel: `onWheel` leaves on
  // its first line and the event goes to xterm untouched.
  term.attachCustomWheelEventHandler((e) => {
    trust.push(e.isTrusted);
    return true;
  });

  await new Promise<void>((done) => term.write(MOUSE_ON, done));
  const element = term.element;
  if (!element) throw new Error("the terminal has no element");
  return { term, element, data, binary, trust };
}

/** One row of scrollback travel, as `emitLineWheel` builds it (:6107-6112). */
const lineWheel = (): WheelEvent =>
  new WheelEvent("wheel", {
    deltaY: -1,
    deltaMode: 1,
    bubbles: true,
    cancelable: true,
    clientX: 0,
    clientY: 100,
  });

describe("a synthetic wheel with mouse reporting on", () => {
  /**
   * The whole reason the exclusion exists. One wheel in, one pty-bound string
   * out, on `onData` and not `onBinary`, before `dispatchEvent` returns.
   */
  it("reports through onData, inside the dispatch", async () => {
    const t = await openReporting();
    let insideDispatch = 0;
    t.term.onData(() => void insideDispatch++);

    t.element.dispatchEvent(lineWheel());

    expect(insideDispatch).toBe(1); // synchronous: nothing awaited in between
    expect(t.data).toHaveLength(1);
    expect(t.data[0]?.startsWith("\x1b[<")).toBe(true); // an SGR report
    expect(t.binary).toEqual([]);
  });

  /**
   * The custom handler IS consulted for a script-made wheel, and sees it as
   * untrusted. Both halves matter: `onHostWheel` tests `isTrusted` to keep our
   * own coast ticks from cancelling the coast, and `wheel.ts` tests it to keep
   * the touch scroller's emissions out of the trackpad accumulator.
   */
  it("goes through the custom wheel handler, marked untrusted", async () => {
    const t = await openReporting();

    t.element.dispatchEvent(lineWheel());

    expect(t.trust).toEqual([false]);
  });

  /**
   * ONE REPORT PER DOM EVENT, magnitude discarded, which is why both scrollers
   * dispatch k separate wheels instead of one carrying `deltaY: k`
   * (term.html:6066-6068). A collapsed dispatch is one row where k events are k.
   */
  it("sends one report per event however many rows the event claims", async () => {
    const t = await openReporting();

    t.element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -5, deltaMode: 1, bubbles: true, clientY: 100 }),
    );
    expect(t.data).toHaveLength(1);

    for (let i = 0; i < 5; i++) t.element.dispatchEvent(lineWheel());
    expect(t.data).toHaveLength(6);
    // ONE HANDLER CONSULT PER DISPATCH, which is the per-row cost
    // `TerminalNative`'s eager prefs read pays: `performWheel` builds its world
    // as an argument, so k emitted rows are k reads whatever the handler then
    // answers.
    expect(t.trust).toEqual([false, false, false, false, false, false]);
  });

  /**
   * WITHOUT mouse reporting there is no report and no interrupt, which is why
   * the coast defect this pins was invisible at a bare shell prompt and broke
   * inside tmux, vim and Claude Code's own TUI.
   */
  it("says nothing to the pty when the application never asked for mice", async () => {
    shimJsdomLayout();
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 800 });
    Object.defineProperty(host, "clientHeight", { value: 600 });
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    term.open(host);
    restores.push(() => {
      term.dispose();
      host.remove();
    });
    const data: string[] = [];
    term.onData((d) => void data.push(d));
    const element = term.element;
    if (!element) throw new Error("the terminal has no element");

    element.dispatchEvent(lineWheel());

    expect(data).toEqual([]);
  });
});
