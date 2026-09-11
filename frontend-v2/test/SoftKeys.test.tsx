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
  it("renders the eight keys of the single row, and nothing else", () => {
    const send = vi.fn();
    const { container, getByText, getByLabelText } = render(() => (
      <SoftKeys send={send} onCopy={() => {}} onPaste={() => {}} onDismissKeyboard={() => {}} />
    ));
    expect(getByText("Esc")).toBeInTheDocument();
    expect(getByText("Tab")).toBeInTheDocument();
    for (const arrow of ["Up", "Down", "Left", "Right"]) {
      expect(getByLabelText(`${arrow} arrow`)).toBeInTheDocument();
    }
    expect(getByLabelText("Copy the visible screen")).toBeInTheDocument();
    expect(getByLabelText("Paste")).toBeInTheDocument();
    expect(getByLabelText("Dismiss keyboard")).toBeInTheDocument();
    expect(container.querySelectorAll("#soft-keys button")).toHaveLength(9);
  });

  it("leads with Tab, the most-tapped key that is not an arrow", () => {
    const send = vi.fn();
    const { container } = render(() => (
      <SoftKeys send={send} onCopy={() => {}} onPaste={() => {}} onDismissKeyboard={() => {}} />
    ));
    const order = [...container.querySelectorAll("#soft-keys button")].map(
      (b) => (b.getAttribute("aria-label") || b.textContent || "").trim(),
    );
    expect(order).toEqual([
      "Tab",
      "Escape",
      "Up arrow",
      "Down arrow",
      "Left arrow",
      "Right arrow",
      "Copy the visible screen",
      "Paste",
      "Dismiss keyboard",
    ]);
  });

  it("captions the two icon keys, which are the only ones an icon hides", () => {
    const send = vi.fn();
    const { container } = render(() => (
      <SoftKeys send={send} onCopy={() => {}} onPaste={() => {}} onDismissKeyboard={() => {}} />
    ));
    const caps = [...container.querySelectorAll("#soft-keys .sk-cap")].map(
      (e) => e.textContent,
    );
    expect(caps).toEqual(["Copy", "Paste"]);
  });

  it("has no second tier and no ⋯ toggle to open one", () => {
    // The whole point of the 2026-09-06 flatten: one line above the keyboard.
    const send = vi.fn();
    const { container, queryByLabelText } = render(() => <SoftKeys send={send} />);
    expect(container.querySelector(".sk-extra")).toBeNull();
    expect(queryByLabelText("More keys")).toBeNull();
    expect(container.querySelectorAll("#soft-keys .sk-line")).toHaveLength(1);
  });

  it("carries no Ctrl/Alt modifier buttons", () => {
    // They remapped only this toolbar's own bytes, none of which start with a
    // letter, so Ctrl was a no-op on every device it ever shipped to.
    const send = vi.fn();
    const { container } = render(() => <SoftKeys send={send} />);
    expect(container.querySelector("[data-mod]")).toBeNull();
  });

  it("sends the pre-baked bytes on a committed tap (Esc → ESC)", () => {
    const send = vi.fn();
    const { getByText } = render(() => <SoftKeys send={send} />);
    tap(getByText("Esc"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\x1b");
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

  it("Tab keeps its hold-to-repeat down-fire after the promotion out of ⋯", () => {
    const send = vi.fn();
    const { getByText } = render(() => (
      <SoftKeys send={send} keyRepeat={() => false} />
    ));
    const tabKey = getByText("Tab");
    firePointer(tabKey, "pointerdown", { pointerId: 1 });
    firePointer(tabKey, "pointerup", { pointerId: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("\t");
  });

  it("Copy / Paste / dismiss delegate to their callbacks from the row itself", () => {
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
    // No ⋯ press first: on a phone in terminal mode this row is the only route
    // to either clipboard action, so both are one tap away.
    fireEvent.click(getByLabelText("Copy the visible screen"));
    fireEvent.click(getByLabelText("Paste"));
    fireEvent.click(getByLabelText("Dismiss keyboard"));
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onPaste).toHaveBeenCalledOnce();
    expect(onDismissKeyboard).toHaveBeenCalledOnce();
  });

  it("pins the dismiss key outside the scrolling row", () => {
    // .sk-row is the overflow-x:auto scroller; ⌨ must not live in it or a
    // narrow screen scrolls it out of reach.
    const send = vi.fn();
    const { container } = render(() => (
      <SoftKeys send={send} onDismissKeyboard={() => {}} />
    ));
    const dismiss = container.querySelector(".sk-dismiss")!;
    expect(dismiss.closest(".sk-row")).toBeNull();
    expect(dismiss.parentElement?.classList.contains("sk-line")).toBe(true);
  });
});
