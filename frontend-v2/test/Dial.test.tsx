/**
 * The labelled dials on the composer's thin line, and the floats they open.
 *
 * Each dial names what it sets ("mode Manual", "model Opus 5.5 · High",
 * "context 42%") and opens a list that explains every choice (Quiet line
 * composer, 2026-09-24). With a fine pointer that list is a popover above the
 * dial. With a coarse one every dial opens ONE bottom sheet with a tab per
 * dial, including a dial the line had to fold away for room, so a phone never
 * loses a setting to a narrow screen.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { DialBar, type DialSpec } from "../src/components/Dial";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A coarse pointer, as `(pointer: coarse)` answers on a phone. */
function coarse(): void {
  vi.stubGlobal(
    "matchMedia",
    (q: string) =>
      ({
        matches: q.includes("coarse"),
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );
}

const spec = (id: string, over: Partial<DialSpec> = {}): DialSpec => ({
  id,
  label: id,
  tab: id[0]!.toUpperCase() + id.slice(1),
  title: `${id} settings`,
  value: () => <span class="tl-dial-value">{id} value</span>,
  ariaLabel: () => `${id}: change it`,
  hint: () => `${id} hint`,
  panel: (ctx) => (
    <div role="radiogroup" aria-label={`${id} rows`}>
      <button type="button" role="radio" class="tl-pick-row" aria-checked="false">
        first {id}
      </button>
      <button type="button" role="radio" class="tl-pick-row" aria-checked="true">
        second {id}
      </button>
      <button type="button" class="probe-close" onClick={ctx.close}>
        pick
      </button>
    </div>
  ),
  ...over,
});

const mount = (dials: DialSpec[]) =>
  render(() => (
    <div>
      <DialBar dials={dials} sheetTitle="This session" />
      <textarea aria-label="outside" />
    </div>
  ));

const dial = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLButtonElement>(`.tl-dial[data-dial="${id}"]`)!;

describe("a dial on the line", () => {
  it("names what it sets, in words, and says how to change it", () => {
    const { container } = mount([spec("mode")]);
    const d = dial(container, "mode");
    expect(d.querySelector(".tl-dial-label")?.textContent).toBe("mode");
    expect(d.textContent).toContain("mode value");
    expect(d.getAttribute("aria-label")).toBe("mode: change it");
    expect(d.getAttribute("title")).toBe("mode hint");
    expect(d.getAttribute("aria-expanded")).toBe("false");
  });

  it("draws a divider between two dials, carrying the fold of the dial after it", () => {
    const { container } = mount([
      spec("mode"),
      spec("model", { fold: 1 }),
      spec("ctx", { fold: 2 }),
    ]);
    const kids = Array.from(container.querySelector(".tl-dials")!.children).filter(
      (e) => !e.classList.contains("tl-dial-pop"),
    );
    expect(kids.map((e) => e.className.split(" ")[0])).toEqual([
      "tl-dial",
      "tl-dial-div",
      "tl-dial",
      "tl-dial-div",
      "tl-dial",
    ]);
    expect(kids[1]!.hasAttribute("data-fold")).toBe(true);
    expect(kids[2]!.hasAttribute("data-fold")).toBe(true);
    expect(kids[3]!.hasAttribute("data-fold2")).toBe(true);
    expect(kids[4]!.hasAttribute("data-fold2")).toBe(true);
  });
});

describe("with a fine pointer", () => {
  it("opens a popover above the dial, named for what it sets", () => {
    const { container } = mount([spec("mode")]);
    fireEvent.click(dial(container, "mode"));
    const pop = container.querySelector(".tl-dial-pop")!;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-label")).toBe("mode settings");
    expect(pop.classList.contains("tl-dial-pop-mode")).toBe(true);
    expect(dial(container, "mode").getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".tl-sheet")).toBeNull();
  });

  it("closes on Escape and puts focus back on the dial", () => {
    const { container } = mount([spec("mode")]);
    const d = dial(container, "mode");
    d.focus();
    fireEvent.click(d);
    const row = container.querySelector<HTMLButtonElement>(".tl-pick-row")!;
    row.focus();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(container.querySelector(".tl-dial-pop")).toBeNull();
    expect(document.activeElement).toBe(d);
  });

  it("closes on a press anywhere else", () => {
    const { container } = mount([spec("mode")]);
    fireEvent.click(dial(container, "mode"));
    fireEvent.pointerDown(container.querySelector("textarea")!);
    expect(container.querySelector(".tl-dial-pop")).toBeNull();
  });

  it("stays open for a press inside it", () => {
    const { container } = mount([spec("mode")]);
    fireEvent.click(dial(container, "mode"));
    fireEvent.pointerDown(container.querySelector(".tl-pick-row")!);
    expect(container.querySelector(".tl-dial-pop")).not.toBeNull();
  });

  it("shows one float at a time", () => {
    const { container } = mount([spec("mode"), spec("model")]);
    fireEvent.click(dial(container, "mode"));
    fireEvent.click(dial(container, "model"));
    const pops = container.querySelectorAll(".tl-dial-pop");
    expect(pops).toHaveLength(1);
    expect(pops[0]!.classList.contains("tl-dial-pop-model")).toBe(true);
    expect(dial(container, "mode").getAttribute("aria-expanded")).toBe("false");
  });

  it("closes again on a second press of the same dial", () => {
    const { container } = mount([spec("mode")]);
    fireEvent.click(dial(container, "mode"));
    fireEvent.click(dial(container, "mode"));
    expect(container.querySelector(".tl-dial-pop")).toBeNull();
  });

  it("lets the panel close it, which is what a pick does", () => {
    const { container } = mount([spec("mode")]);
    fireEvent.click(dial(container, "mode"));
    fireEvent.click(container.querySelector(".probe-close")!);
    expect(container.querySelector(".tl-dial-pop")).toBeNull();
  });

  // A keyboard activation arrives as a click with no pointer detail, and the
  // list it opens has to take the focus or the arrows have nowhere to go.
  it("moves focus to the chosen row when opened from the keyboard, and arrows walk the rows", () => {
    const { container } = mount([spec("mode")]);
    fireEvent.click(dial(container, "mode"), { detail: 0 });
    const rows = container.querySelectorAll<HTMLButtonElement>(".tl-pick-row");
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[1]);
  });
});

describe("a dial that cannot act right now", () => {
  it("says why in its title, carries a lock, and opens nothing", () => {
    const { container } = mount([spec("mode", { held: () => "Answer Claude first" })]);
    const d = dial(container, "mode");
    expect(d.getAttribute("aria-disabled")).toBe("true");
    expect(d.getAttribute("title")).toBe("Answer Claude first");
    expect(d.querySelector(".tl-dial-lock")).not.toBeNull();
    fireEvent.click(d);
    expect(container.querySelector(".tl-dial-pop")).toBeNull();
  });

  it("opens nothing while a change is being driven either", () => {
    const { container } = mount([spec("model", { busy: () => true })]);
    const d = dial(container, "model");
    expect(d.hasAttribute("data-busy")).toBe(true);
    fireEvent.click(d);
    expect(container.querySelector(".tl-dial-pop")).toBeNull();
  });
});

describe("with a coarse pointer", () => {
  it("opens one sheet with a tab for every dial, on the tab that was pressed", () => {
    coarse();
    const { container } = mount([
      spec("mode"),
      spec("model", { fold: 1 }),
      spec("ctx", { fold: 2 }),
    ]);
    fireEvent.click(dial(container, "model"));
    const sheet = container.querySelector(".tl-sheet")!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.querySelector(".tl-sheet-title")?.textContent).toBe("This session");
    const tabs = Array.from(sheet.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(["Mode", "Model", "Ctx"]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(sheet.querySelector(".tl-sheet-body")?.textContent).toContain("first model");
    expect(container.querySelector(".tl-dial-pop")).toBeNull();
  });

  it("switches what it shows from its tabs", () => {
    coarse();
    const { container } = mount([spec("mode"), spec("model")]);
    fireEvent.click(dial(container, "mode"));
    const tabs = container.querySelectorAll<HTMLButtonElement>('.tl-sheet [role="tab"]');
    fireEvent.click(tabs[1]!);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".tl-sheet-body")?.textContent).toContain("first model");
    expect(dial(container, "model").getAttribute("aria-expanded")).toBe("true");
  });

  it("closes from the scrim, from its close button, and from Escape", () => {
    coarse();
    const { container } = mount([spec("mode")]);
    fireEvent.click(dial(container, "mode"));
    fireEvent.click(container.querySelector(".tl-sheet-scrim")!);
    expect(container.querySelector(".tl-sheet")).toBeNull();

    fireEvent.click(dial(container, "mode"));
    fireEvent.click(container.querySelector(".tl-sheet-x")!);
    expect(container.querySelector(".tl-sheet")).toBeNull();

    fireEvent.click(dial(container, "mode"));
    fireEvent.keyDown(container.querySelector(".tl-sheet")!, { key: "Escape" });
    expect(container.querySelector(".tl-sheet")).toBeNull();
  });

  // The sheet opens over the message field. Taking the focus is what puts the
  // phone's keyboard away, and Tab must not walk out behind the scrim.
  it("takes the focus, keeps it inside, and hands it back on close", async () => {
    coarse();
    const { container } = mount([spec("mode")]);
    const d = dial(container, "mode");
    d.focus();
    fireEvent.click(d);
    await Promise.resolve();
    const sheet = container.querySelector<HTMLElement>(".tl-sheet")!;
    expect(sheet.contains(document.activeElement)).toBe(true);

    const buttons = Array.from(sheet.querySelectorAll<HTMLButtonElement>("button"));
    const last = buttons[buttons.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(sheet.contains(document.activeElement)).toBe(true);

    fireEvent.click(container.querySelector(".tl-sheet-x")!);
    expect(document.activeElement).toBe(d);
  });
});
