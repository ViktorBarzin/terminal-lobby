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
    <Composer
      working={false}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));

const field = (c: HTMLElement) =>
  c.querySelector<HTMLTextAreaElement>(".tl-composer-input")!;

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
        working={false}
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

  it("shows a queued prompt rather than letting it vanish", () => {
    const { container } = render(() => (
      <Composer
        working={true}
        pending={[]}
        queued={["the one Claude has not started yet"]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
      />
    ));
    expect(container.querySelector(".tl-queued-item")?.textContent).toContain(
      "the one Claude has not started yet",
    );
  });

  it("cycles the mode from the chip", () => {
    const onCycleMode = vi.fn();
    const { container } = render(() => (
      <Composer
        working={false}
        pending={[]}
        mode="bypassPermissions"
        onCycleMode={onCycleMode}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
      />
    ));
    const chip = container.querySelector<HTMLButtonElement>(".tl-mode-chip")!;
    expect(chip.textContent).toBe("bypass");
    fireEvent.click(chip);
    expect(onCycleMode).toHaveBeenCalled();
  });
});
