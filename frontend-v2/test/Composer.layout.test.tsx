/**
 * Where the composer's controls live: the dials and Stop on a thin line above,
 * `+`, the field and Send in one pill below.
 *
 * HISTORY. Reported 2026-08-29: "the prompt is the most important part and
 * it's only taking a small part of the row. the other buttons are
 * supplementary." Measured then at 390x844, the field was 163.8px of a 343.2px
 * row idle (47.7%) and 92.8px (27.0%) once a turn started and Stop appeared
 * beside Send. That fix put the field alone on its row and the controls on a
 * bar beneath it, with Send last so it stopped jumping 71px left when Stop was
 * inserted after it. These tests pinned that bar.
 *
 * The Quiet line composer (Viktor, 2026-09-24) rewrote them on purpose. A bar
 * below the field is the height that direction removes: the controls moved to
 * a line of small type ABOVE the pill, Stop moved beside the work it stops,
 * and the pill holds `+`, the field and Send. What still holds from before:
 * Send is the last control in its group, and the field takes the whole width
 * the pill has left, since nothing else shares its row but two 32px circles.
 *
 * Layout is asserted structurally here; jsdom has no layout engine. Sizes were
 * measured on the prototype in Chromium at 1:1 (spec section 4.1).
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { ComponentProps } from "solid-js";
import { Composer } from "../src/components/Composer";
import type { WorkingRow } from "../src/components/timeline.logic";

const noop = () => {};
const sent = async (): Promise<boolean> => true;

/** A turn in flight, with a call running. */
const WORKING: WorkingRow = {
  kind: "working",
  key: "working-t1",
  turnKey: "t1",
  tool: "Edit",
  toolLabel: "a.ts",
  steps: 3,
};

const mount = (props: Partial<ComponentProps<typeof Composer>> = {}) =>
  render(() => <Composer pending={[]} onSend={sent} onStop={noop} onResolve={noop} {...props} />);

const firstClass = (e: Element) => (e.className || "").toString().split(" ")[0];

describe("<Composer>: one pill for writing", () => {
  it("holds exactly +, the field and the end group, in that order", () => {
    const { container } = mount({ live: WORKING, onAttach: async () => [] });
    const pill = container.querySelector(".tl-pill")!;
    expect(Array.from(pill.children).map(firstClass)).toEqual([
      "tl-plus",
      "tl-field",
      "tl-pill-end",
    ]);
    // The field and the chip layer drawn behind it, which is not a control and
    // takes no space of its own — see `.tl-composer-mirror`.
    const field = pill.querySelector(".tl-field")!;
    expect(field.querySelector("textarea.tl-composer-input")).not.toBeNull();
    expect(field.children).toHaveLength(2);
  });

  it("keeps Send the pill's last control, working or not", () => {
    for (const live of [WORKING, undefined]) {
      const { container, unmount } = mount({ live });
      const end = container.querySelector(".tl-pill-end")!;
      const last = end.lastElementChild!;
      expect(last.classList.contains("tl-send"), live ? "working" : "idle").toBe(true);
      unmount();
    }
  });
});

describe("<Composer>: the controls sit on the line above", () => {
  it("puts the dials in the status line, before the pill, with no bar anywhere", () => {
    const { container } = mount({
      live: WORKING,
      mode: "manual",
      onCycleMode: noop,
      onPickMode: noop,
      onAttach: async () => [],
    });
    const line = container.querySelector(".tl-statusline")!;
    const dial = line.querySelector('.tl-dial[data-dial="mode"]');
    expect(dial, "the mode dial is on the line").not.toBeNull();
    const pill = container.querySelector(".tl-pill")!;
    expect(line.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      container.querySelector(".tl-composer-bar"),
      "the bar below the field is gone",
    ).toBeNull();
  });

  it("lets nothing follow the pill", () => {
    const { container } = mount({ live: WORKING, onAttach: async () => [] });
    const dock = container.querySelector(".tl-composer")!;
    expect(firstClass(dock.lastElementChild!)).toBe("tl-pillwrap");
    // Inside the wrap, only the two hidden pickers come after the pill.
    const wrap = dock.lastElementChild!;
    const after = Array.from(wrap.children).slice(
      Array.from(wrap.children).indexOf(container.querySelector(".tl-pill")!) + 1,
    );
    expect(after.every((e) => e instanceof HTMLInputElement && e.hidden)).toBe(true);
  });

  it("puts Stop beside the work it stops, and Send in the pill", () => {
    const { container } = mount({ live: WORKING });
    expect(container.querySelector(".tl-status-state .tl-stop")).not.toBeNull();
    expect(container.querySelector(".tl-pill .tl-send")).not.toBeNull();
    expect(container.querySelector(".tl-pill .tl-stop")).toBeNull();
  });
});

describe("<Composer>: every control still does its job from its new home", () => {
  it("sends, stops, opens the mode list, and steps the mode on Shift+Tab", () => {
    const onSend = vi.fn(sent);
    const onStop = vi.fn();
    const onCycleMode = vi.fn();
    const { container, getByLabelText } = mount({
      live: WORKING,
      onSend,
      onStop,
      mode: "bypassPermissions",
      onCycleMode,
      onPickMode: noop,
    });
    const ta = getByLabelText("Message to send to the session") as HTMLTextAreaElement;
    ta.value = "hello";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    fireEvent.click(container.querySelector(".tl-send")!);
    fireEvent.click(container.querySelector(".tl-stop")!);
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(onStop).toHaveBeenCalledTimes(1);

    // A click opens the list. It used to step the mode, and does not any more.
    fireEvent.click(container.querySelector('.tl-dial[data-dial="mode"]')!);
    expect(container.querySelector(".tl-dial-pop-mode")).not.toBeNull();
    expect(onCycleMode).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });
});
