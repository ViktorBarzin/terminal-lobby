/**
 * The prompt is the point of the composer, so it gets the whole row.
 *
 * Reported 2026-08-29: "the prompt is the most important part and it's only
 * taking a small part of the row. the other buttons are supplementary."
 * Measured on master at 390x844: the field was 163.8px of a 343.2px row idle
 * (47.7%), and 92.8px (27.0%) once a turn started and Stop appeared beside
 * Send. With the context meter present it fell to 26px, 7.6%, and the row
 * overflowed its own width by 20px.
 *
 * So the field is alone on its row and the controls move to a bar beneath it,
 * split into a left group that may scroll and a right group that never shrinks.
 * Send is the last child of the right group, permanently — today it jumps 71px
 * left the moment a turn starts, because Stop is inserted after it.
 *
 * Layout is asserted structurally here; jsdom has no layout engine. The widths
 * above and after were measured in a browser (see the workflow write-up).
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer } from "../src/components/Composer";

const noop = () => {};
const sent = async (): Promise<boolean> => true;

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) =>
  render(() => (
    <Composer
      working={false}
      pending={[]}
      onSend={sent}
      onStop={noop}
      onResolve={noop}
      {...props}
    />
  ));

const barKids = (c: HTMLElement, sel: string) =>
  Array.from(c.querySelectorAll(`${sel} > *`))
    .map((e) => (e.className || "").toString().split(" ")[0])
    .filter(Boolean);

describe("<Composer> — the field owns its row", () => {
  it("puts nothing but the textarea in the row", () => {
    const { container } = mount({ working: true, onAttach: async () => [] });
    const row = container.querySelector(".tl-composer-row")!;
    const kids = Array.from(row.children).filter(
      (e) => !(e instanceof HTMLInputElement && e.type === "file"),
    );
    expect(kids.length, "one child, the field").toBe(1);
    expect(kids[0]!.className).toContain("tl-composer-input");
  });

  it("puts the controls on their own bar below it", () => {
    const { container } = mount({ working: true, onAttach: async () => [] });
    const bar = container.querySelector(".tl-composer-bar");
    expect(bar, "a control bar").not.toBeNull();
    // The bar follows the row, so the field is the thing you look at first.
    expect(
      container.querySelector(".tl-composer-row")!.compareDocumentPosition(bar!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("<Composer> — Send stops moving", () => {
  it("keeps Send last in the right group while working", () => {
    const { container } = mount({ working: true });
    const right = barKids(container, ".tl-bar-right");
    expect(right[right.length - 1]).toBe("tl-send");
    expect(right).toContain("tl-stop");
    // Stop is inserted BEFORE Send, so Send does not shift when a turn starts.
    expect(right.indexOf("tl-stop")).toBeLessThan(right.indexOf("tl-send"));
  });

  it("keeps Send last in the right group while idle", () => {
    const { container } = mount({ working: false });
    const right = barKids(container, ".tl-bar-right");
    expect(right[right.length - 1]).toBe("tl-send");
    expect(right).not.toContain("tl-stop");
  });
});

describe("<Composer> — the two groups", () => {
  it("puts the supplementary controls on the left", () => {
    const { container } = mount({
      working: true,
      onAttach: async () => [],
      mode: "bypass",
      onCycleMode: noop,
    });
    const left = barKids(container, ".tl-bar-left");
    expect(left).toContain("tl-attach-btn");
    expect(left).toContain("tl-mode-chip");
    // ...and never the ones that must stay reachable.
    expect(left).not.toContain("tl-send");
    expect(left).not.toContain("tl-stop");
  });

  it("still sends, stops and cycles the mode from their new home", () => {
    const onSend = vi.fn(sent);
    const onStop = vi.fn();
    const onCycleMode = vi.fn();
    const { container, getByLabelText } = mount({
      working: true,
      onSend,
      onStop,
      mode: "bypass",
      onCycleMode,
    });
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    ta.value = "hello";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    (container.querySelector(".tl-send") as HTMLButtonElement).click();
    (container.querySelector(".tl-stop") as HTMLButtonElement).click();
    (container.querySelector(".tl-mode-chip") as HTMLButtonElement).click();
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });
});
