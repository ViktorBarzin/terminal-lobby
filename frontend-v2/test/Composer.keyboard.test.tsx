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
import { describe, it, expect, vi } from "vitest";
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
  // dial opens the list instead, and Shift+Tab in the field is what steps.
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
    const dial = container.querySelector<HTMLButtonElement>('.tl-dial[data-dial="mode"]')!;
    expect(dial.querySelector(".tl-dial-value")?.textContent).toBe("Bypass");
    fireEvent.click(dial);
    expect(container.querySelector(".tl-dial-pop-mode")).not.toBeNull();
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });
});

/**
 * The phone keyboard's blue send/return key.
 *
 * Reported 2026-08-17: pressing it cleared the field and sent nothing, while the
 * app's own Send button worked. Two things were wrong. The send itself forked on
 * a coarse pointer into the terminal iframe, which in Text mode has not attached
 * (the attach is lazy), so the bytes were dropped and the field cleared anyway.
 * And Enter on a textarea does not reach a keydown handler the same way on every
 * mobile keyboard — with a composition in progress it arrives as a commit and is
 * correctly skipped, leaving the message unsent. `beforeinput` with inputType
 * "insertLineBreak" is that key, unambiguously.
 */
describe("the keyboard's send key", () => {
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
