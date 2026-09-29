/**
 * The composer's shape: a pill at rest on the phone, a box when focused and
 * always on a desktop (the T3 pass, docs/plans/2026-09-27-text-view-t3-pass.md).
 *
 * HISTORY. Reported 2026-08-29: "the prompt is the most important part and
 * it's only taking a small part of the row." That fix put the field alone on
 * its row. The Quiet line composer (2026-09-24) then moved the controls to a
 * thin status line above one pill. Viktor chose the T3 pass on 2026-09-27 and
 * these tests were rewritten on purpose for it:
 *
 *  - the phone at rest shows ONE 50px pill: `+`, the field, the round button;
 *  - focused on the phone, and always on a desktop, a box: the text on top,
 *    then a row with `+`, the model button's slot and the round button;
 *  - there is no status line above either;
 *  - Bypass and No ask put a danger border on the surface and change nothing
 *    else, the placeholder included.
 *
 * "Phone" is the coarse-pointer flip (mobile/pointer.ts FLIP_QUERY), not width
 * alone: a desktop window someone shrank keeps its box, and so does a tablet.
 *
 * Layout is asserted structurally here; jsdom has no layout engine. The sizes
 * are in composer.css.test.ts.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal, type ComponentProps } from "solid-js";
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

type Device = "desktop" | "tablet" | "phone";

/** Answer the two pointer queries the way the device would. */
function stubDevice(device: Device): void {
  const coarse = device !== "desktop";
  window.matchMedia = ((q: string) => {
    const matches = q.includes("pointer: coarse")
      ? coarse && (q === "(pointer: coarse)" || device === "phone")
      : false;
    return {
      media: q,
      matches,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
  document.body.innerHTML = "";
});

const mount = (
  props: Partial<ComponentProps<typeof Composer>> = {},
  device: Device = "desktop",
) => {
  stubDevice(device);
  const r = render(() => (
    <Composer pending={[]} onSend={sent} onStop={noop} onResolve={noop} {...props} />
  ));
  const ta = r.getByLabelText("Message to send to the session") as HTMLTextAreaElement;
  const surface = () => r.container.querySelector<HTMLElement>(".tl-pill")!;
  return { ...r, ta, surface };
};

const firstClass = (e: Element) => (e.className || "").toString().split(" ")[0];

describe("<Composer>: pill or box", () => {
  it("is always the box on a desktop, focused or not", () => {
    const { ta, surface } = mount();
    expect(surface().getAttribute("data-shape")).toBe("box");
    fireEvent.focus(ta);
    expect(surface().getAttribute("data-shape")).toBe("box");
    fireEvent.blur(ta);
    expect(surface().getAttribute("data-shape")).toBe("box");
  });

  it("keeps the box on a tablet, which is coarse but not a phone", () => {
    const { surface } = mount({}, "tablet");
    expect(surface().getAttribute("data-shape")).toBe("box");
  });

  it("rests as the pill on a phone and opens into the box on focus", () => {
    const { ta, surface } = mount({}, "phone");
    expect(surface().getAttribute("data-shape")).toBe("pill");
    ta.focus();
    expect(surface().getAttribute("data-shape")).toBe("box");
  });

  it("folds back into the pill when the conversation is pressed, and puts the keyboard away", () => {
    const { ta, surface } = mount({}, "phone");
    const timeline = document.createElement("div");
    timeline.className = "tl-timeline";
    const line = document.createElement("p");
    timeline.appendChild(line);
    document.body.appendChild(timeline);
    ta.focus();
    expect(surface().getAttribute("data-shape")).toBe("box");
    fireEvent.pointerDown(line);
    expect(surface().getAttribute("data-shape")).toBe("pill");
    expect(document.activeElement).not.toBe(ta);
  });

  // Found on the Android emulator on 2026-09-27: Chrome keeps the focus in the
  // field when the keyboard is put away with the back gesture, so the box
  // stayed open with no keyboard under it. The keyboard going away is the sign.
  it("folds back into the pill when the phone's keyboard goes away", () => {
    const vv = Object.assign(new EventTarget(), { height: 783 });
    vi.stubGlobal("visualViewport", vv);
    try {
      const { ta, surface } = mount({}, "phone");
      ta.focus();
      expect(surface().getAttribute("data-shape")).toBe("box");
      vv.height = 471; // the keyboard comes up
      vv.dispatchEvent(new Event("resize"));
      expect(surface().getAttribute("data-shape")).toBe("box");
      vv.height = 783; // and goes away
      vv.dispatchEvent(new Event("resize"));
      expect(surface().getAttribute("data-shape")).toBe("pill");
      expect(document.activeElement).not.toBe(ta);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stays the box when the viewport moves by less than a keyboard", () => {
    const vv = Object.assign(new EventTarget(), { height: 471 });
    vi.stubGlobal("visualViewport", vv);
    try {
      const { ta, surface } = mount({}, "phone");
      ta.focus();
      vv.height = 527; // the URL bar folding away
      vv.dispatchEvent(new Event("resize"));
      expect(surface().getAttribute("data-shape")).toBe("box");
      expect(document.activeElement).toBe(ta);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The box grows upward from where the pill was, so the finger that opened
  // it is over the box's bottom row by the time its click fires. Measured in
  // Chromium's phone emulation on 2026-09-27: a tap on the pill opened the
  // dials' sheet, which then held the focus, and typing went nowhere. The
  // model button sits in the same row now.
  it("swallows the click of the tap that opened it, so nothing under the finger fires", () => {
    const { ta, surface, container } = mount(
      { mode: "manual", onCycleMode: noop, onPickMode: noop },
      "phone",
    );
    fireEvent.pointerDown(ta, { pointerType: "touch" });
    expect(surface().getAttribute("data-shape")).toBe("box");
    expect(document.activeElement).toBe(ta);
    fireEvent.click(container.querySelector(".tl-model-btn")!);
    expect(document.querySelector(".tl-ms-pop, .tl-ms-sheet")).toBeNull();
    // The next press is the reader's own.
    fireEvent.click(container.querySelector(".tl-model-btn")!);
    expect(document.querySelector(".tl-ms-pop, .tl-ms-sheet")).not.toBeNull();
  });

  // Measured on the Android emulator on 2026-09-27: a tap on Send blurred the
  // field, which put the keyboard away and left an open box with nothing to
  // type into. A chat app keeps the keyboard up across a send.
  it("keeps the field focused through a finger's press on Send", () => {
    const { ta, container } = mount({}, "phone");
    ta.focus();
    fireEvent.input(ta, { target: { value: "hello" } });
    const send = container.querySelector(".tl-send")!;
    const press = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    });
    send.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("stays open when the press lands inside the composer itself", () => {
    // The + and the round button are pressed with the box open; folding under
    // the finger would move them before the click lands.
    const { ta, surface, container } = mount({ onAttach: async () => [] }, "phone");
    ta.focus();
    fireEvent.pointerDown(container.querySelector(".tl-plus")!);
    expect(surface().getAttribute("data-shape")).toBe("box");
  });

  it("shows a folded draft's first line in the pill, and nothing of it in the box", () => {
    const { ta, surface, container } = mount({}, "phone");
    fireEvent.input(ta, { target: { value: "first line of it\nsecond line" } });
    expect(surface().getAttribute("data-shape")).toBe("pill");
    expect(container.querySelector(".tl-pill-draft")?.textContent).toBe("first line of it");
    ta.focus();
    expect(container.querySelector(".tl-pill-draft")).toBeNull();
  });

  // Seen on the Android emulator on 2026-09-29: a photo draft folded to
  // "[img] Look at this one". The token reads as a chip naming the picture.
  it("draws an attachment token in a folded draft as a chip that names it", () => {
    const { ta, container } = mount({}, "phone");
    fireEvent.input(ta, { target: { value: "[img] Look at this one" } });
    const line = container.querySelector(".tl-pill-draft");
    expect(line?.textContent).toBe("Photo Look at this one");
    expect(line?.querySelector(".tl-inline-chip")?.textContent).toBe("Photo");
  });

  it("shows no draft line in an empty pill, so the placeholder reads", () => {
    const { container } = mount({}, "phone");
    expect(container.querySelector(".tl-pill-draft")).toBeNull();
  });
});

describe("<Composer>: the placeholder is one sentence", () => {
  it.each(["manual", "acceptEdits", "auto", "plan", "bypassPermissions", "dontAsk", ""])(
    "reads the same in mode %j",
    (mode) => {
      const { ta } = mount({ mode, onCycleMode: noop });
      expect(ta.getAttribute("placeholder")).toBe("Ask Claude, or run a command…");
    },
  );
});

describe("<Composer>: the modes that ask nothing", () => {
  it.each([
    ["bypassPermissions", true],
    ["dontAsk", true],
    ["manual", false],
    ["acceptEdits", false],
    ["auto", false],
    ["plan", false],
    ["", false],
  ] as const)("mode %j marks the surface danger: %s", (mode, danger) => {
    const { surface } = mount({ mode, onCycleMode: noop });
    expect(surface().hasAttribute("data-danger")).toBe(danger);
  });
});

describe("<Composer>: the dock", () => {
  it("draws nothing above the surface, and puts no state on the dock", () => {
    const { container } = mount({ live: WORKING, mode: "manual", onCycleMode: noop });
    const dock = container.querySelector(".tl-composer")!;
    expect(dock.hasAttribute("data-status")).toBe(false);
    expect(firstClass(dock.lastElementChild!)).toBe("tl-pillwrap");
  });
});

describe("<Composer>: what the box holds", () => {
  // In the DOM, + comes first; the grid draws the field across the top and the
  // rest on the row beneath it (composer.css.test.ts).
  it("holds +, the field, the model slot and the round button", () => {
    const { surface } = mount({ onAttach: async () => [] });
    expect(Array.from(surface().children).map(firstClass)).toEqual([
      "tl-plus",
      "tl-field",
      "tl-box-tools",
      "tl-pill-end",
    ]);
    const field = surface().querySelector(".tl-field")!;
    expect(field.querySelector("textarea.tl-composer-input")).not.toBeNull();
  });

  it("keeps the round button the surface's last control, working or not", () => {
    for (const live of [WORKING, undefined]) {
      const { surface, unmount } = mount({ live });
      const end = surface().lastElementChild!;
      expect(end.lastElementChild!.classList.contains("tl-send"), live ? "working" : "idle").toBe(
        true,
      );
      unmount();
    }
  });

  it("holds the one model button in the model slot", () => {
    const { surface } = mount({
      mode: "manual",
      onCycleMode: noop,
      onPickMode: noop,
      harness: "claude",
      model: { model: "claude-opus-5-5", effort: "high" },
      onPickModel: noop,
    });
    const tools = surface().querySelector(".tl-box-tools")!;
    expect(tools.querySelectorAll(".tl-model-btn")).toHaveLength(1);
    expect(tools.querySelector(".tl-model-name")?.textContent).toBe("Opus 5.5");
  });

  // A plain shell has no model, no mode and no /context reading.
  it("has no model button for a plain shell", () => {
    const { surface } = mount({});
    expect(surface().querySelector(".tl-model-btn")).toBeNull();
  });

  it("says what is still running in the background in the row, not on a line", () => {
    const { surface } = mount({ background: "2 agents" });
    const note = surface().querySelector('.tl-box-note[data-kind="background"]');
    expect(note?.textContent).toContain("2 agents");
  });
});

describe("<Composer>: every control still does its job", () => {
  it("sends, stops, opens the model sheet, and steps the mode on Shift+Tab", () => {
    const onSend = vi.fn(sent);
    const onStop = vi.fn();
    const onCycleMode = vi.fn();
    const { container, ta } = mount({
      live: WORKING,
      claudeState: "running",
      onSend,
      onStop,
      mode: "bypassPermissions",
      onCycleMode,
      onPickMode: noop,
    });
    // Stop while the field is empty, then Send once something is typed: the
    // same round button.
    fireEvent.click(container.querySelector('.tl-send[data-kind="stop"]')!);
    fireEvent.input(ta, { target: { value: "hello" } });
    fireEvent.click(container.querySelector('.tl-send[data-kind="send"]')!);
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(onStop).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".tl-model-btn")!);
    expect(document.querySelector(".tl-ms-pop .tl-ms-mode")).not.toBeNull();
    expect(onCycleMode).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });
});

describe("<Composer>: a watching device", () => {
  const REASON = "Watching: this device does not type into the session";

  it("reads Watching with Take control in the pill, on a desktop too", () => {
    const onTakeControl = vi.fn();
    const { surface, container } = mount({ inertReason: REASON, onTakeControl });
    expect(surface().getAttribute("data-shape")).toBe("pill");
    expect(surface().hasAttribute("data-watch")).toBe(true);
    const watch = container.querySelector(".tl-watch")!;
    expect(watch.textContent).toContain("Watching");
    fireEvent.click(watch.querySelector(".tl-take")!);
    expect(onTakeControl).toHaveBeenCalledTimes(1);
  });

  it("keeps the field mounted under it, so a draft survives the watch", () => {
    const { ta } = mount({ inertReason: REASON, onTakeControl: noop });
    expect(ta.isConnected).toBe(true);
  });

  it.each(["desktop", "phone"] as const)(
    "reads Watching with Take control and has no textbox, + or round button on a %s",
    (device) => {
      const onTakeControl = vi.fn();
      const r = mount(
        {
          inertReason: REASON,
          onTakeControl,
          mode: "manual",
          onPickMode: noop,
          harness: "claude",
          model: { model: "claude-opus-5-5", effort: "high" },
          onPickModel: noop,
        },
        device,
      );
      expect(r.queryByRole("textbox")).toBeNull();
      // The one control left is Take control: no +, no model button, no Send.
      const buttons = r.queryAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["Take control"]);
      expect(r.container.querySelector(".tl-watch")?.textContent).toMatch(/^Watching/);
      fireEvent.click(buttons[0]!);
      expect(onTakeControl).toHaveBeenCalledTimes(1);
    },
  );

  it("gives the field back when this device takes control", () => {
    const [reason, setReason] = createSignal<string | undefined>(REASON);
    stubDevice("desktop");
    const r = render(() => (
      <Composer pending={[]} onSend={sent} onStop={noop} onResolve={noop} inertReason={reason()} />
    ));
    expect(r.queryByRole("textbox")).toBeNull();
    setReason(undefined);
    expect(r.getByRole("textbox")).toBeDefined();
    expect(r.container.querySelector(".tl-watch")).toBeNull();
  });

  it("closes an open + menu and model sheet when the watch starts", () => {
    const [reason, setReason] = createSignal<string | undefined>();
    stubDevice("desktop");
    const r = render(() => (
      <Composer
        pending={[]}
        onSend={sent}
        onStop={noop}
        onResolve={noop}
        inertReason={reason()}
        onAttach={async () => []}
        harness="claude"
        model={{ model: "claude-opus-5-5", effort: "high" }}
        onPickModel={noop}
      />
    ));
    fireEvent.click(r.container.querySelector(".tl-plus")!);
    expect(r.container.querySelector(".tl-plus-menu")).not.toBeNull();
    setReason(REASON);
    expect(r.container.querySelector(".tl-plus-menu")).toBeNull();

    setReason(undefined);
    fireEvent.click(r.container.querySelector(".tl-model-btn")!);
    expect(document.querySelector(".tl-ms-pop")).not.toBeNull();
    setReason(REASON);
    expect(document.querySelector(".tl-ms-pop")).toBeNull();
  });

  it("offers no Take control when there is no way to take it", () => {
    const { container } = mount({ inertReason: REASON });
    expect(container.querySelector(".tl-watch")).not.toBeNull();
    expect(container.querySelector(".tl-take")).toBeNull();
  });
});
