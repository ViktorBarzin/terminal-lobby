/**
 * The mobile keyboard bug (2026-08-16): tapping the message field raised the
 * keyboard and immediately dismissed it, and only a tap a keyboard-height too
 * high would land.
 *
 * Mechanism: `body.has-soft-keys .tl-views` grows its bottom margin by
 * --kb-offset the moment visualViewport reports the keyboard, and the composer
 * is the bottom child of that column — so the field moves ~390px up between
 * touchstart and click, the click lands on the timeline, and iOS reads it as a
 * tap outside the input. The fix takes focus during the gesture, on
 * pointerdown, before any layout change can move anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { Composer } from "../src/components/Composer";

const mount = () =>
  render(() => (
    <Composer pending={[]} onSend={async () => true} onStop={() => {}} onResolve={() => {}} />
  ));

const field = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>(".tl-composer-input")!;

describe("the composer takes focus during the touch, not after it", () => {
  it("focuses on pointerdown from a touch", () => {
    const { container } = mount();
    const ta = field(container);
    expect(document.activeElement).not.toBe(ta);

    fireEvent.pointerDown(ta, { pointerType: "touch" });
    expect(document.activeElement).toBe(ta);
  });

  // Without preventDefault the browser's own focus-on-click still runs, and it
  // is that later click — landing wherever the reflow left the field — that
  // blurs the input and drops the keyboard.
  it("prevents the default so the later click cannot steal focus", () => {
    const { container } = mount();
    const ta = field(container);
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.pointerDown(ta, { pointerType: "touch" })).toBe(false);
  });

  // Taking the gesture over on every touch would break placing the caret
  // inside text that is already there.
  it("leaves an already-focused field alone", () => {
    const { container } = mount();
    const ta = field(container);
    ta.focus();
    expect(fireEvent.pointerDown(ta, { pointerType: "touch" })).toBe(true);
  });

  it("does not interfere with a mouse", () => {
    const { container } = mount();
    const ta = field(container);
    expect(fireEvent.pointerDown(ta, { pointerType: "mouse" })).toBe(true);
  });
});

/**
 * The same bug on the new-session screen, on an iPhone (2026-09-30, Viktor:
 * "a flicker when trying to open the keyboard"). The flight recorder's
 * viewport records show the field taking focus, the keyboard starting up, and
 * the focus on <body> 5 to 32ms later, three taps in a row.
 *
 * Focusing on pointerdown is not enough on WebKit: the tap's compat mousedown
 * still arrives after touchend, hit-tested at the finger against the layout the
 * keyboard has already moved (a standalone PWA's innerHeight drops 812 -> 629),
 * and a mousedown on a non-focusable element blurs the field. The same
 * mechanism as the terminal's (terminal/keepfocus.ts). The tap that focused
 * the field owns its own mousedown and click, wherever they land.
 */
describe("the tap that focused the field keeps it", () => {
  const press = (el: Element, type: "mousedown" | "click"): boolean =>
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));

  it("holds the focus through its mousedown landing off the field", () => {
    const { container } = mount();
    const ta = field(container);
    fireEvent.pointerDown(ta, { pointerType: "touch" });
    expect(document.activeElement).toBe(ta);
    // Landed beside the field, on the column the keyboard slid under it.
    expect(press(container.firstElementChild!, "mousedown")).toBe(false);
  });

  it("does not fire what its click lands on", () => {
    const { container } = mount();
    const ta = field(container);
    const btn = document.createElement("button");
    let fired = 0;
    btn.addEventListener("click", () => fired++);
    container.appendChild(btn);
    fireEvent.pointerDown(ta, { pointerType: "touch" });
    press(btn, "mousedown");
    press(btn, "click");
    expect(fired).toBe(0);
    // The next press is the reader's own.
    press(btn, "mousedown");
    press(btn, "click");
    expect(fired).toBe(1);
  });

  it("lets its mousedown and click on the field through, to place the caret", () => {
    const { container } = mount();
    const ta = field(container);
    fireEvent.pointerDown(ta, { pointerType: "touch" });
    expect(press(ta, "mousedown")).toBe(true);
    expect(press(ta, "click")).toBe(true);
  });

  it("gives up the hold when no mousedown comes", () => {
    vi.useFakeTimers();
    try {
      const { container } = mount();
      const ta = field(container);
      fireEvent.pointerDown(ta, { pointerType: "touch" });
      vi.advanceTimersByTime(1000);
      expect(press(container.firstElementChild!, "mousedown")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the composer's affordances", () => {
  it("recalls the previous prompt with ↑ from an empty field", () => {
    const { container } = render(() => (
      <Composer
        pending={[]}
        history={["first prompt", "second prompt"]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
      />
    ));
    const ta = field(container);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("second prompt");
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("first prompt");
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(ta.value).toBe("second prompt");
  });

  // Queued prompts were chips in here until 2026-09-24. They are ghost bubbles
  // at the end of the timeline now (MessagesTimeline.ghost.test.tsx), and the
  // composer draws none of its own.
  it("leaves queued prompts to the timeline", () => {
    const { container } = render(() => (
      <Composer pending={[]} onSend={async () => true} onStop={() => {}} onResolve={() => {}} />
    ));
    expect(container.querySelector(".tl-queued")).toBeNull();
  });

  // A click on the chip stepped the mode until the Quiet line composer. The
  // model button opens the sheet with the mode list instead (the T3 pass),
  // and Shift+Tab in the field is what steps.
  it("steps the mode on Shift+Tab, and opens the list on a click", () => {
    const onCycleMode = vi.fn();
    const { container } = render(() => (
      <Composer
        pending={[]}
        mode="bypassPermissions"
        onCycleMode={onCycleMode}
        onPickMode={() => {}}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
      />
    ));
    fireEvent.keyDown(field(container), { key: "Tab", shiftKey: true });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
    const button = container.querySelector<HTMLButtonElement>(".tl-model-btn")!;
    expect(button.getAttribute("data-mode")).toBe("bypassPermissions");
    fireEvent.click(button);
    expect(document.querySelector(".tl-ms-pop .tl-ms-mode")).not.toBeNull();
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });
});

/**
 * Enter on a DESKTOP keyboard sends.
 *
 * The key's `beforeinput` (inputType "insertLineBreak") is handled as well as
 * its keydown, because an input method committing a candidate can deliver the
 * keydown as a composition keystroke, which is correctly skipped. These tests
 * pinned the phone's send key until 2026-09-28, when Viktor chose the T3 and
 * ChatGPT rule for a phone: its return key adds a line and the round button
 * sends (see "the phone keyboard's return key" below). jsdom has no
 * matchMedia, so these mount as a fine pointer, which is the desktop.
 */
describe("a desktop keyboard's Enter", () => {
  const type = (ta: HTMLTextAreaElement, value: string) =>
    fireEvent.input(ta, { target: { value } });

  it("sends on insertLineBreak, and inserts no newline", () => {
    const onSend = vi.fn(async () => true);
    const { container } = render(() => (
      <Composer pending={[]} onSend={onSend} onStop={() => {}} onResolve={() => {}} />
    ));
    const ta = field(container);
    type(ta, "ship it");
    const notPrevented = fireEvent(
      ta,
      new InputEvent("beforeinput", {
        inputType: "insertLineBreak",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onSend).toHaveBeenCalledWith("ship it", []);
    expect(notPrevented).toBe(false); // the newline never reaches the field
  });

  // The text must survive a send that did not land, whichever key sent it.
  it("puts the text back when the session refused it", async () => {
    const onSend = vi.fn(async () => false);
    const { container } = render(() => (
      <Composer pending={[]} onSend={onSend} onStop={() => {}} onResolve={() => {}} />
    ));
    const ta = field(container);
    type(ta, "do not lose me");
    fireEvent(
      ta,
      new InputEvent("beforeinput", {
        inputType: "insertLineBreak",
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe("do not lose me");
  });

  it("still lets Shift+Enter through as a soft newline", () => {
    const onSend = vi.fn(async () => true);
    const { container } = render(() => (
      <Composer pending={[]} onSend={onSend} onStop={() => {}} onResolve={() => {}} />
    ));
    const ta = field(container);
    type(ta, "line one");
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    const notPrevented = fireEvent(
      ta,
      new InputEvent("beforeinput", {
        inputType: "insertLineBreak",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true); // the field keeps the newline
  });

  // Committing an IME candidate is not a send — but the insertLineBreak that
  // follows a real send key still is, so the guard must not swallow it.
  it("does not send while an IME candidate is being committed", () => {
    const onSend = vi.fn(async () => true);
    const { container } = render(() => (
      <Composer pending={[]} onSend={onSend} onStop={() => {}} onResolve={() => {}} />
    ));
    const ta = field(container);
    type(ta, "にほんご");
    fireEvent.keyDown(ta, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

/**
 * The phone keyboard's return key adds a line (Viktor, 2026-09-28), as it does
 * in T3 Code, ChatGPT and Claude on an iPhone; the round button sends. It
 * reversed the rule from 2026-08-17 where the phone's send key sent through
 * `beforeinput` insertLineBreak. "Phone" is a coarse pointer, the same test the
 * rest of the touch ergonomics use.
 */
describe("the phone keyboard's return key", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((q: string) =>
      ({
        media: q,
        matches: q.includes("pointer: coarse"),
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });
  const type = (ta: HTMLTextAreaElement, value: string) =>
    fireEvent.input(ta, { target: { value } });
  const lineBreak = (ta: HTMLTextAreaElement) =>
    fireEvent(
      ta,
      new InputEvent("beforeinput", {
        inputType: "insertLineBreak",
        bubbles: true,
        cancelable: true,
      }),
    );

  it("adds a newline and sends nothing", () => {
    const onSend = vi.fn(async () => true);
    const { container } = render(() => (
      <Composer pending={[]} onSend={onSend} onStop={() => {}} onResolve={() => {}} />
    ));
    const ta = field(container);
    type(ta, "first line");
    const keyNotPrevented = fireEvent.keyDown(ta, { key: "Enter" });
    const inputNotPrevented = lineBreak(ta);
    expect(onSend).not.toHaveBeenCalled();
    expect(keyNotPrevented).toBe(true);
    expect(inputNotPrevented).toBe(true); // the field keeps the newline
  });

  it("labels the key return, not send", () => {
    const { container } = render(() => (
      <Composer pending={[]} onSend={async () => true} onStop={() => {}} onResolve={() => {}} />
    ));
    expect(field(container).getAttribute("enterkeyhint")).toBe("enter");
  });

  it("leaves sending to the round button, with every line intact", async () => {
    const onSend = vi.fn(async () => true);
    const { container } = render(() => (
      <Composer pending={[]} onSend={onSend} onStop={() => {}} onResolve={() => {}} />
    ));
    const ta = field(container);
    type(ta, "first line\nsecond line");
    fireEvent.click(container.querySelector<HTMLButtonElement>(".tl-send")!);
    expect(onSend).toHaveBeenCalledWith("first line\nsecond line", []);
  });

  it("still sends on Ctrl or Cmd+Enter from a hardware keyboard", () => {
    const onSend = vi.fn(async () => true);
    const { container } = render(() => (
      <Composer pending={[]} onSend={onSend} onStop={() => {}} onResolve={() => {}} />
    ));
    const ta = field(container);
    type(ta, "ship it");
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    expect(onSend).toHaveBeenCalledWith("ship it", []);
  });
});
