import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { SoftKeys } from "../src/components/SoftKeys";

// jsdom has no PointerEvent; dispatch a MouseEvent (carries clientX/clientY) as
// the pointer type and attach pointerId so the tap-commit handlers read it. The
// pointerdown/up handlers are delegated (bubble to document); pointercancel/leave
// are attached to the element directly, so bubbles is fine either way.
function firePointer(
  el: Element,
  type: string,
  opts: { clientX?: number; clientY?: number; pointerId?: number } = {},
): void {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
  });
  Object.defineProperty(ev, "pointerId", {
    value: opts.pointerId ?? 1,
    configurable: true,
  });
  el.dispatchEvent(ev);
}

/** A committed tap: down then up within the 10px travel gate (same pointer). */
function tap(el: Element): void {
  firePointer(el, "pointerdown", { clientX: 0, clientY: 0, pointerId: 1 });
  firePointer(el, "pointerup", { clientX: 1, clientY: 1, pointerId: 1 });
}

describe("<SoftKeys>", () => {
  it("renders the always-visible primary keys", () => {
    const send = vi.fn();
    const { getByText, getByLabelText } = render(() => <SoftKeys send={send} />);
    expect(getByText("Esc")).toBeInTheDocument();
    expect(getByText("⇧Tab")).toBeInTheDocument();
    expect(getByLabelText("Up arrow")).toBeInTheDocument();
    expect(getByLabelText("Right arrow")).toBeInTheDocument();
  });

  it("sends the pre-baked bytes on a committed tap (Esc → ESC)", () => {
    const send = vi.fn();
    const { getByText } = render(() => <SoftKeys send={send} />);
    tap(getByText("Esc"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\x1b");
  });

  it("sends CSI Z for ⇧Tab (the only mobile back-tab route)", () => {
    const send = vi.fn();
    const { getByText } = render(() => <SoftKeys send={send} />);
    tap(getByText("⇧Tab"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\x1b[Z");
  });

  it("does NOT fire when the tap travels ≥10px (a row-scroll, not a tap)", () => {
    const send = vi.fn();
    const { getByText } = render(() => <SoftKeys send={send} />);
    const esc = getByText("Esc");
    firePointer(esc, "pointerdown", { clientX: 0, clientY: 0, pointerId: 1 });
    firePointer(esc, "pointerup", { clientX: 0, clientY: 20, pointerId: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("arrows fire on pointerdown (down-fire for hold-to-repeat)", () => {
    const send = vi.fn();
    const { getByLabelText } = render(() => (
      <SoftKeys send={send} keyRepeat={() => false} />
    ));
    const up = getByLabelText("Up arrow");
    firePointer(up, "pointerdown", { pointerId: 1 });
    firePointer(up, "pointerup", { pointerId: 1 }); // stop the (disabled) repeat
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\x1b[A");
  });

  it("⋯ toggles the overflow tier and its glyph keys become tappable", () => {
    const send = vi.fn();
    const { getByLabelText, container } = render(() => <SoftKeys send={send} />);
    const toolbar = container.querySelector("#soft-keys")!;
    expect(toolbar.classList.contains("expanded")).toBe(false);
    fireEvent.click(getByLabelText("More keys"));
    expect(toolbar.classList.contains("expanded")).toBe(true);
    tap(getByLabelText("More keys") /* keeps focus behavior */);
    // The pipe glyph lives in the overflow tier.
    const pipe = container.querySelector(".sk-extra")!;
    expect(pipe.textContent).toContain("|");
  });

  it("Ctrl cycles idle → armed → latched via the tri-state paint", () => {
    const send = vi.fn();
    const { getByLabelText, container } = render(() => <SoftKeys send={send} />);
    fireEvent.click(getByLabelText("More keys")); // reveal the modifiers
    const ctrl = container.querySelector('[data-mod="ctrl"]')!;
    expect(ctrl.classList.contains("armed")).toBe(false);
    firePointer(ctrl, "pointerdown", { pointerId: 1 });
    expect(ctrl.classList.contains("armed")).toBe(true);
    firePointer(ctrl, "pointerdown", { pointerId: 1 });
    expect(ctrl.classList.contains("latched")).toBe(true);
    firePointer(ctrl, "pointerdown", { pointerId: 1 });
    expect(ctrl.classList.contains("armed")).toBe(false);
    expect(ctrl.classList.contains("latched")).toBe(false);
  });

  it("armed Alt ESC-prefixes the next key, then consumes (one-shot)", () => {
    const send = vi.fn();
    const { getByLabelText, container } = render(() => (
      <SoftKeys send={send} keyRepeat={() => false} />
    ));
    fireEvent.click(getByLabelText("More keys"));
    const alt = container.querySelector('[data-mod="alt"]')!;
    firePointer(alt, "pointerdown", { pointerId: 1 }); // arm Alt
    expect(alt.classList.contains("armed")).toBe(true);

    const up = getByLabelText("Up arrow");
    firePointer(up, "pointerdown", { pointerId: 1 });
    firePointer(up, "pointerup", { pointerId: 1 });
    // Alt + Up = ESC then the up sequence.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\x1b\x1b[A");
    // One-shot: armed Alt is consumed after the key.
    expect(alt.classList.contains("armed")).toBe(false);
  });

  it("Copy / Paste / dismiss delegate to their callbacks", () => {
    const send = vi.fn();
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    const onDismissKeyboard = vi.fn();
    const { getByLabelText } = render(() => (
      <SoftKeys
        send={send}
        onCopy={onCopy}
        onPaste={onPaste}
        onDismissKeyboard={onDismissKeyboard}
      />
    ));
    fireEvent.click(getByLabelText("More keys"));
    fireEvent.click(getByLabelText("Copy"));
    fireEvent.click(getByLabelText("Paste"));
    fireEvent.click(getByLabelText("Dismiss keyboard"));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onDismissKeyboard).toHaveBeenCalledOnce();
  });
});
