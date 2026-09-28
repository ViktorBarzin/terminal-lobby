/**
 * The model button in the composer's box, and the one sheet it opens.
 *
 * The T3 pass (2026-09-27, docs/plans/2026-09-27-text-view-t3-pass.md)
 * replaced the Quiet line's three dials with ONE button, "✳ Opus 5.5 ⌄", and
 * one sheet behind it: Model, Effort, Mode and a quiet context line. On a
 * desktop the sheet is a 360px popover above the box; with a coarse pointer it
 * is a bottom sheet. Bypass and No ask put a small red shield on the button.
 *
 * What the button shows is the SESSION's own reading (the transcript for
 * Claude, the pane for codex, the stamp for pi), not the stored preference for
 * the next session. A pick of a model or an effort goes to `onPickModel`
 * (POST /model), a pick of a mode to `onPickMode` (the server's Shift+Tab
 * walk). Picking what is already in force sends nothing.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { createSignal, type ComponentProps } from "solid-js";
import { ModelSheet } from "../src/components/ModelSheet";
import type { ContextState } from "../src/components/context.logic";

afterEach(() => {
  cleanup();
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

type Props = ComponentProps<typeof ModelSheet>;

function mount(p: Partial<Props> = {}) {
  const r = render(() => (
    <div>
      <ModelSheet
        harness="claude"
        mode="manual"
        onPickMode={() => {}}
        onPickModel={() => {}}
        {...p}
      />
      <textarea aria-label="outside" />
    </div>
  ));
  return r.container;
}

const button = () => document.querySelector<HTMLButtonElement>(".tl-model-btn")!;
const open = () => fireEvent.click(button());
const float = () => document.querySelector<HTMLElement>(".tl-ms-pop, .tl-ms-sheet");
const modelRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-ms-model"));
const modeRows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-ms-mode"));
const efforts = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tl-ms-seg button"));
const nameOf = (b: HTMLElement) => b.querySelector(".tl-ms-name")?.textContent ?? "";
const modelRow = (name: string) => modelRows().find((b) => nameOf(b) === name)!;
const modeRow = (name: string) => modeRows().find((b) => nameOf(b) === name)!;
const effort = (id: string) => efforts().find((b) => b.getAttribute("data-value") === id)!;
const heads = () =>
  Array.from(document.querySelectorAll(".tl-ms-h")).map(
    (h) => h.firstChild?.textContent?.trim() ?? "",
  );

const CTX: ContextState = {
  reading: { usedTokens: 420_000, maxTokens: 1_000_000, percent: 42, model: "claude-opus-5-5" },
  turnsAgo: 1,
};

describe("the model button", () => {
  it("shows the sparkle, the model's name and a chevron", () => {
    mount({ model: { model: "claude-opus-5-5", effort: "high" } });
    const b = button();
    expect(b.querySelector(".tl-model-name")?.textContent).toBe("Opus 5.5");
    expect(b.querySelector(".tl-model-spark")).not.toBeNull();
    expect(b.querySelector(".tl-model-chev")).not.toBeNull();
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  // The name drops the rest of the slug, so the title carries all of it.
  it("puts the exact slug and the effort in its title", () => {
    mount({ model: { model: "claude-haiku-4-5-20251001", effort: "low" } });
    expect(button().querySelector(".tl-model-name")?.textContent).toBe("Haiku 4.5");
    expect(button().getAttribute("title")).toBe(
      "Model and effort: claude-haiku-4-5-20251001 · low",
    );
  });

  // A session that has not answered yet has said nothing true to show.
  it("reads Model until the session reports one", () => {
    mount({});
    expect(button().querySelector(".tl-model-name")?.textContent).toBe("Model");
    expect(button().hasAttribute("data-unknown")).toBe(true);
    expect(button().getAttribute("title")).toMatch(/has not answered yet/);
  });

  it("reads Switching… while a change is driven, and opens nothing", () => {
    mount({ model: { model: "claude-opus-5" }, modelBusy: true });
    expect(button().querySelector(".tl-model-name")?.textContent).toBe("Switching…");
    expect(button().hasAttribute("data-busy")).toBe(true);
    open();
    expect(float()).toBeNull();
  });

  it("opens nothing while a mode walk is being driven either", () => {
    mount({ model: { model: "claude-opus-5" }, modeBusy: true });
    expect(button().hasAttribute("data-busy")).toBe(true);
    open();
    expect(float()).toBeNull();
  });

  it("carries a small red shield in Bypass and No ask, and nothing else changes", () => {
    for (const mode of ["bypassPermissions", "dontAsk"]) {
      mount({ mode, model: { model: "claude-opus-5-5" } });
      expect(button().querySelector(".tl-model-shield"), mode).not.toBeNull();
      expect(button().hasAttribute("data-danger")).toBe(true);
      expect(button().querySelector(".tl-model-name")?.textContent).toBe("Opus 5.5");
      cleanup();
    }
    mount({ mode: "auto" });
    expect(button().querySelector(".tl-model-shield")).toBeNull();
    expect(button().hasAttribute("data-danger")).toBe(false);
  });

  it("carries the mode for the stylesheet and for anyone asking", () => {
    mount({ mode: "acceptEdits", model: { model: "claude-opus-5-5", effort: "high" } });
    expect(button().getAttribute("data-mode")).toBe("acceptEdits");
    expect(button().getAttribute("aria-label")).toMatch(/Permission mode: Edits/);
  });

  // Every dialog on the pane holds it: the model picker and the mode walk both
  // type into the pane, where a dialog would take the keys.
  it("is held while a dialog is on the pane, with the reason as its title", () => {
    const why = "Answer Claude first: a model change now would type into the open dialog";
    mount({ model: { model: "claude-opus-5-5" }, modelHeld: why, modeHeld: "mode reason" });
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(button().getAttribute("title")).toBe(why);
    expect(button().getAttribute("aria-label")).toContain(why);
    open();
    expect(float()).toBeNull();
  });

  it("is free when nothing holds it", () => {
    mount({ model: { model: "claude-opus-5-5" } });
    expect(button().getAttribute("aria-disabled")).toBeNull();
  });

  it("names a pi session's setting the way pi does", () => {
    mount({ harness: "pi", model: { model: "anthropic/claude-opus-5", effort: "high" } });
    expect(button().querySelector(".tl-model-name")?.textContent).toBe("anthropic/claude-opus-5");
    expect(button().getAttribute("title")).toBe(
      "Model and thinking: anthropic/claude-opus-5 · high",
    );
  });
});

describe("the sheet, on a desktop", () => {
  it("opens as a popover above the box, named for what it sets", () => {
    mount({ model: { model: "claude-opus-5-5", effort: "high" } });
    open();
    const pop = document.querySelector(".tl-ms-pop")!;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-label")).toBe("Model, effort and mode");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".tl-ms-sheet")).toBeNull();
  });

  /**
   * Found live on 2026-09-27: in a 700px or 450px window the lobby stacks its
   * sidebar above the pane, and the popover, capped at the pane's room above
   * the box, was 227px tall and showed five of six models with Effort and
   * Mode out of view. It is drawn over the page now, so the window's room
   * above the box is what caps it.
   */
  it("reaches above a short pane, capped by the window's room above the box", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 450);
    const r = render(() => (
      <div class="tl-textview">
        <div class="tl-pill">
          <ModelSheet harness="claude" mode="manual" onPickMode={() => {}} onPickModel={() => {}} />
        </div>
      </div>
    ));
    const rect = (top: number, left: number, width: number) => (): DOMRect =>
      ({ top, left, width, right: left + width, bottom: top + 110, height: 110 }) as DOMRect;
    r.container.querySelector<HTMLElement>(".tl-textview")!.getBoundingClientRect = rect(
      444,
      0,
      450,
    );
    r.container.querySelector<HTMLElement>(".tl-pill")!.getBoundingClientRect = rect(671, 16, 418);
    open();
    const pop = document.querySelector<HTMLElement>(".tl-ms-pop")!;
    expect(r.container.contains(pop)).toBe(false);
    expect(pop.style.maxHeight).toBe(`${671 - 16}px`);
    expect(pop.style.bottom).toBe(`${800 - 671 + 8}px`);
    // Its left edge just past the +.
    expect(pop.style.left).toBe(`${16 + 36}px`);
  });

  // Found live on 2026-09-28 at 1280x800: six models tall, the popover rose
  // over the session's title and the lobby's bar.
  it("stays under the pane's header when the pane has room for it", () => {
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 1280);
    const r = render(() => (
      <div class="tl-textview">
        <div class="tl-pill">
          <ModelSheet harness="claude" mode="manual" onPickMode={() => {}} onPickModel={() => {}} />
        </div>
      </div>
    ));
    const rect = (top: number, left: number, width: number) => (): DOMRect =>
      ({ top, left, width, right: left + width, bottom: top + 110, height: 110 }) as DOMRect;
    r.container.querySelector<HTMLElement>(".tl-textview")!.getBoundingClientRect = rect(
      100,
      260,
      1020,
    );
    r.container.querySelector<HTMLElement>(".tl-pill")!.getBoundingClientRect = rect(678, 390, 760);
    open();
    const pop = document.querySelector<HTMLElement>(".tl-ms-pop")!;
    expect(pop.style.maxHeight).toBe(`${678 - 100 - 16}px`);
  });

  it("says there is more below while the rest of the sheet is out of view", () => {
    mount({ model: { model: "claude-opus-5-5", effort: "high" } });
    open();
    const pop = document.querySelector<HTMLElement>(".tl-ms-pop")!;
    Object.defineProperty(pop, "scrollHeight", { value: 684, configurable: true });
    Object.defineProperty(pop, "clientHeight", { value: 561, configurable: true });
    pop.scrollTop = 0;
    fireEvent.scroll(pop);
    expect(pop.hasAttribute("data-more")).toBe(true);
    pop.scrollTop = 123;
    fireEvent.scroll(pop);
    expect(pop.hasAttribute("data-more")).toBe(false);
  });

  it("keeps the models in one column on a desktop, as the prototype draws them", () => {
    mount({ model: { model: "claude-opus-5-5" } });
    open();
    expect(document.querySelector(".tl-ms-models")!.getAttribute("data-cols")).toBeNull();
  });

  it("has Model, Effort and Mode sections, in that order", () => {
    mount({ model: { model: "claude-opus-5-5", effort: "high" }, context: CTX });
    open();
    expect(heads()).toEqual(["Model", "Effort", "Mode"]);
    const mode = Array.from(document.querySelectorAll(".tl-ms-h")).at(-1)!;
    expect(mode.querySelector(".tl-ms-aside")?.textContent).toBe("Manual");
  });

  it("closes on Escape and gives the focus back to the button", () => {
    mount({ model: { model: "claude-opus-5-5" } });
    button().focus();
    open();
    const row = modelRows()[0]!;
    row.focus();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(float()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it("closes on a press anywhere else, and stays open for a press inside", () => {
    mount({ model: { model: "claude-opus-5-5" } });
    open();
    fireEvent.pointerDown(modelRows()[0]!);
    expect(float()).not.toBeNull();
    fireEvent.pointerDown(document.querySelector("textarea")!);
    expect(float()).toBeNull();
  });

  it("closes again on a second press of the button", () => {
    mount({});
    open();
    open();
    expect(float()).toBeNull();
  });

  // A keyboard activation arrives as a click with no pointer detail, and the
  // list it opens has to take the focus or the arrows have nowhere to go.
  it("moves the focus to the current model from the keyboard, and the arrows walk the rows", () => {
    mount({ model: { model: "claude-opus-5", effort: "high" } });
    fireEvent.click(button(), { detail: 0 });
    const opus5 = modelRow("Opus 5");
    expect(document.activeElement).toBe(opus5);
    fireEvent.keyDown(opus5, { key: "ArrowDown" });
    expect(document.activeElement).toBe(modelRow("Opus 5 · 1M"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(opus5);
  });

  it("walks the effort row with the side arrows, and steps over it as one stop", () => {
    mount({ model: { model: "claude-opus-4-8", effort: "high" } });
    open();
    const last = modelRows().at(-1)!;
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowDown" });
    expect(document.activeElement).toBe(effort("high"));
    fireEvent.keyDown(effort("high"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(effort("xhigh"));
  });
});

describe("the sheet, with a coarse pointer", () => {
  it("opens as a bottom sheet with a scrim and a grab handle", () => {
    coarse();
    mount({ model: { model: "claude-opus-5-5", effort: "high" } });
    open();
    const sheet = document.querySelector(".tl-ms-sheet")!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.getAttribute("aria-label")).toBe("Model, effort and mode");
    expect(sheet.querySelector(".tl-ms-grab")).not.toBeNull();
    expect(document.querySelector(".tl-ms-scrim")).not.toBeNull();
    expect(document.querySelector(".tl-ms-pop")).toBeNull();
    expect(heads()).toEqual(["Model", "Effort", "Mode"]);
  });

  it("closes from the scrim and from Escape", () => {
    coarse();
    mount({});
    open();
    fireEvent.click(document.querySelector(".tl-ms-scrim")!);
    expect(float()).toBeNull();
    open();
    fireEvent.keyDown(document.querySelector(".tl-ms-sheet")!, { key: "Escape" });
    expect(float()).toBeNull();
  });

  // The sheet opens over the message field. Taking the focus is what puts the
  // phone's keyboard away, and Tab must not walk out behind the scrim.
  it("takes the focus, keeps it inside, and hands it back on close", async () => {
    coarse();
    mount({ model: { model: "claude-opus-5-5" } });
    button().focus();
    open();
    await Promise.resolve();
    const sheet = document.querySelector<HTMLElement>(".tl-ms-sheet")!;
    expect(sheet.contains(document.activeElement)).toBe(true);
    const buttons = Array.from(sheet.querySelectorAll<HTMLButtonElement>("button"));
    const last = buttons[buttons.length - 1]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.click(document.querySelector(".tl-ms-scrim")!);
    expect(document.activeElement).toBe(button());
  });

  it("lays more than three models in two columns, so the whole sheet fits a phone", () => {
    // Found live on 2026-09-27: six models at 48px each pushed Bypass, No ask
    // and the context line below a 412x783 screen's sheet.
    coarse();
    mount({ model: { model: "claude-opus-5-5" } });
    open();
    const list = document.querySelector<HTMLElement>(".tl-ms-models")!;
    expect(modelRows().length).toBeGreaterThan(3);
    expect(list.getAttribute("data-cols")).toBe("2");
  });

  it("closes after a pick, which applies it", () => {
    coarse();
    const onPickModel = vi.fn();
    mount({ model: { model: "claude-opus-5-5" }, onPickModel });
    open();
    fireEvent.click(modelRow("Sonnet 5"));
    expect(onPickModel).toHaveBeenCalledWith("model", "claude-sonnet-5");
    expect(float()).toBeNull();
  });
});

describe("the Model section", () => {
  // The prototype's rows: a name and a short note ("Most capable"), found
  // showing the raw slug in the live check on 2026-09-28. The exact slug,
  // which Viktor asked to see on 2026-09-06, stays in the row's title.
  it("names each model with a short note, keeps its exact slug in the title, and ticks the current one", () => {
    mount({ model: { model: "claude-opus-5-5", effort: "high" } });
    open();
    const opus = modelRow("Opus 5.5");
    expect(opus.querySelector(".tl-ms-sub")?.textContent).toBe("Most capable");
    expect(modelRow("Sonnet 5").querySelector(".tl-ms-sub")?.textContent).toBe(
      "Fast, strong at code",
    );
    expect(modelRow("Haiku 4.5").querySelector(".tl-ms-sub")?.textContent).toBe("Fastest");
    expect(opus.textContent).not.toContain("claude-opus-5-5");
    expect(opus.getAttribute("title")).toBe("claude-opus-5-5");
    expect(opus.querySelector(".tl-ms-spark")).not.toBeNull();
    const ticked = modelRows().filter((b) => b.getAttribute("aria-checked") === "true");
    expect(ticked.map(nameOf)).toEqual(["Opus 5.5"]);
  });

  // "Leave it alone" answers a question only a session not yet started can be
  // asked. This one is already on something.
  it("does not offer the default", () => {
    mount({});
    open();
    expect(modelRows().map((b) => b.getAttribute("data-value"))).not.toContain("default");
    expect(efforts().map((b) => b.getAttribute("data-value"))).not.toContain("default");
  });

  it("ticks a receipt's bare family on the family's first row only", () => {
    mount({ model: { model: "opus" } });
    open();
    const ticked = modelRows().filter((b) => b.getAttribute("aria-checked") === "true");
    expect(ticked.map(nameOf)).toEqual(["Opus 5.5"]);
  });

  it("applies a pick by its exact slug and closes", () => {
    const onPickModel = vi.fn();
    mount({ model: { model: "claude-opus-5" }, onPickModel });
    open();
    fireEvent.click(modelRow("Haiku 4.5"));
    expect(onPickModel).toHaveBeenCalledWith("model", "claude-haiku-4-5-20251001");
    expect(float()).toBeNull();
  });

  // Driving a picker types into somebody's live pane. Landing on the row it is
  // already on would put a `/model` line in the conversation and change nothing.
  it("sends nothing for the model it is already on", () => {
    const onPickModel = vi.fn();
    mount({ model: { model: "claude-opus-5" }, onPickModel });
    open();
    fireEvent.click(modelRow("Opus 5"));
    expect(onPickModel).not.toHaveBeenCalled();
    expect(float()).toBeNull();
  });

  it("offers codex's own rows, with the slug said once", () => {
    mount({ harness: "codex", model: { model: "gpt-5.6-terra", effort: "medium" } });
    open();
    const terra = modelRow("gpt-5.6-terra");
    expect(terra.querySelector(".tl-ms-sub")).toBeNull();
    expect(modelRows().map(nameOf)).not.toContain("Opus 5");
    expect(efforts().map((b) => b.textContent)).toContain("ultra");
  });

  // Codex's picker writes its config file and has no "this session only" key.
  it("warns that a codex change also moves codex's default", () => {
    mount({ harness: "codex" });
    open();
    expect(float()!.textContent).toMatch(/default for new sessions/);
    cleanup();
    mount({ harness: "claude" });
    open();
    expect(float()!.textContent).not.toMatch(/default for new sessions/);
  });

  it("has no Model or Effort section on a session with no model to pick", () => {
    // Rendered bare: a spread `harness: undefined` would fall back to the
    // mount's default, the way Solid merges props.
    render(() => <ModelSheet mode="auto" onPickMode={() => {}} />);
    expect(button().querySelector(".tl-model-name")?.textContent).toBe("Auto");
    open();
    expect(heads()).toEqual(["Mode"]);
  });
});

describe("the Effort section", () => {
  it("offers the levels this model has, as the CLI spells them, and ticks the current one", () => {
    mount({ model: { model: "claude-opus-5-5", effort: "high" } });
    open();
    expect(efforts().map((b) => b.textContent)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts().filter((b) => b.getAttribute("aria-checked") === "true")).toEqual([
      effort("high"),
    ]);
  });

  it("offers Sonnet 5 its xhigh", () => {
    mount({ model: { model: "claude-sonnet-5", effort: "xhigh" } });
    open();
    expect(effort("xhigh").getAttribute("aria-checked")).toBe("true");
  });

  it("says Haiku 4.5 has one effort level, and draws no control", () => {
    mount({ model: { model: "claude-haiku-4-5-20251001" } });
    open();
    expect(efforts()).toEqual([]);
    expect(document.querySelector(".tl-ms-none")?.textContent).toBe(
      "Haiku 4.5 has one effort level.",
    );
  });

  // Ultracode is xhigh plus workflows, not a rung of thinking, so the row
  // leaves it out; but a session on it still shows what it is on.
  it("shows a level the session is on even when the row would leave it out", () => {
    mount({ model: { model: "claude-opus-5-5", effort: "ultracode" } });
    open();
    expect(efforts().map((b) => b.textContent)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
    expect(effort("ultracode").getAttribute("aria-checked")).toBe("true");
  });

  it("applies an effort pick and sends nothing for the current one", () => {
    const onPickModel = vi.fn();
    mount({ model: { model: "claude-opus-5-5", effort: "high" }, onPickModel });
    open();
    fireEvent.click(effort("high"));
    expect(onPickModel).not.toHaveBeenCalled();
    open();
    fireEvent.click(effort("max"));
    expect(onPickModel).toHaveBeenCalledWith("effort", "max");
  });

  it("holds the model and effort rows while a change is in flight", () => {
    // Opened first, then a change starts: the rows it shows are held.
    const [busy, setBusy] = createSignal(false);
    const onPickModel = vi.fn();
    render(() => (
      <ModelSheet
        harness="claude"
        model={{ model: "claude-opus-5-5", effort: "high" }}
        modelBusy={busy()}
        onPickModel={onPickModel}
      />
    ));
    open();
    expect(modelRow("Sonnet 5").getAttribute("aria-disabled")).toBeNull();
    setBusy(true);
    expect(modelRow("Sonnet 5").getAttribute("aria-disabled")).toBe("true");
    expect(effort("max").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(modelRow("Sonnet 5"));
    expect(onPickModel).not.toHaveBeenCalled();
  });
});

describe("a pi session's sheet", () => {
  const OPUS = "anthropic/claude-opus-5";
  const MINI = "openai/gpt-5.4-mini";

  it("offers pi's models and the levels the session stamped, under Thinking", () => {
    mount({
      harness: "pi",
      model: { model: OPUS, effort: "high" },
      modelOffer: { models: [OPUS, MINI], levels: ["off", "low", "medium", "high"] },
      mode: "",
    });
    open();
    expect(modelRows().map(nameOf)).toEqual([OPUS, MINI]);
    expect(efforts().map((b) => b.textContent)).toEqual(["off", "low", "medium", "high"]);
    expect(heads()).toEqual(["Model", "Thinking"]);
  });

  // A heading over no rows reads like a broken list.
  it("leaves the Model heading out until pi has listed a model", () => {
    mount({ harness: "pi", model: { model: OPUS, effort: "high" }, mode: "" });
    open();
    expect(heads()).toEqual(["Thinking"]);
  });

  it("applies pi's own values", () => {
    const onPickModel = vi.fn();
    mount({
      harness: "pi",
      model: { model: OPUS, effort: "high" },
      modelOffer: { models: [OPUS, MINI] },
      onPickModel,
      mode: "",
    });
    open();
    fireEvent.click(modelRow(MINI));
    expect(onPickModel).toHaveBeenCalledWith("model", MINI);
    open();
    fireEvent.click(effort("minimal"));
    expect(onPickModel).toHaveBeenCalledWith("effort", "minimal");
  });
});

describe("the Mode section", () => {
  it("lists Manual, Edits, Auto and Plan, a rule, then Bypass and No ask in the danger tone", () => {
    mount({});
    open();
    expect(modeRows().map(nameOf)).toEqual(["Manual", "Edits", "Auto", "Plan", "Bypass", "No ask"]);
    const group = document.querySelector('[role="radiogroup"][aria-label="Permission mode"]')!;
    const kids = Array.from(group.children);
    const rule = kids.findIndex((k) => k.classList.contains("tl-ms-rule"));
    expect(rule).toBe(4);
    for (const k of kids.slice(rule + 1)) {
      expect(k.hasAttribute("data-danger")).toBe(true);
      expect(k.querySelector(".tl-ms-shield")).not.toBeNull();
    }
    expect(modeRow("Plan").querySelector(".tl-ms-desc")?.textContent).toBe(
      "Reads and plans. Changes nothing",
    );
  });

  it("ticks the mode in force, reading an old `default` as Manual", () => {
    mount({ mode: "default" });
    open();
    const ticked = modeRows().filter((b) => b.getAttribute("aria-checked") === "true");
    expect(ticked.map(nameOf)).toEqual(["Manual"]);
  });

  it("hands a pick to the server walk by the CLI's identifier, and closes", () => {
    const onPickMode = vi.fn();
    mount({ onPickMode });
    open();
    fireEvent.click(modeRow("Plan"));
    expect(onPickMode).toHaveBeenCalledWith("plan");
    expect(float()).toBeNull();
    open();
    fireEvent.click(modeRow("Bypass"));
    expect(onPickMode.mock.calls).toEqual([["plan"], ["bypassPermissions"]]);
  });

  it("sends nothing for the mode already in force", () => {
    const onPickMode = vi.fn();
    mount({ mode: "auto", onPickMode });
    open();
    fireEvent.click(modeRow("Auto"));
    expect(onPickMode).not.toHaveBeenCalled();
  });

  // No ask is not a stop on Shift+Tab: a session can start in it, and the
  // first press leaves it for good (memory #13911).
  it("offers No ask only to a session already in it, and says why", () => {
    const onPickMode = vi.fn();
    mount({ onPickMode });
    open();
    const noAsk = modeRow("No ask");
    expect(noAsk.getAttribute("aria-disabled")).toBe("true");
    // The settled line stays under the name, as the prototype draws it; the
    // reason is the row's title.
    expect(noAsk.querySelector(".tl-ms-desc")?.textContent).toBe(
      "Nothing asks. Anything that would ask is refused",
    );
    expect(noAsk.getAttribute("title")).toMatch(/set when the session starts/i);
    fireEvent.click(noAsk);
    expect(onPickMode).not.toHaveBeenCalled();
    cleanup();
    mount({ mode: "dontAsk" });
    open();
    expect(modeRow("No ask").getAttribute("aria-disabled")).toBeNull();
    expect(modeRow("No ask").getAttribute("aria-checked")).toBe("true");
  });

  it("disables a mode the server said this session does not offer, and says so", () => {
    const onPickMode = vi.fn();
    mount({ modesUnavailable: new Set(["auto"]), onPickMode });
    open();
    expect(modeRow("Auto").getAttribute("aria-disabled")).toBe("true");
    expect(modeRow("Auto").querySelector(".tl-ms-desc")?.textContent).toBe(
      "Not offered in this session",
    );
    fireEvent.click(modeRow("Auto"));
    expect(onPickMode).not.toHaveBeenCalled();
  });

  it("has no Mode section while nothing has read a mode", () => {
    mount({ mode: "" });
    open();
    expect(heads()).toEqual(["Model", "Effort"]);
  });
});

describe("the context line", () => {
  it("says how much of the context is used, with a small bar", () => {
    mount({ context: CTX });
    open();
    const line = document.querySelector<HTMLElement>(".tl-ms-ctx")!;
    expect(line.textContent).toBe("Context 42% used");
    expect(line.querySelector("i")!.style.getPropertyValue("--p")).toBe("42%");
    expect(line.getAttribute("title")).toBe(
      "420k of 1m tokens on claude-opus-5-5, read 1 turn ago",
    );
  });

  it("is absent until a /context reading exists", () => {
    mount({});
    open();
    expect(document.querySelector(".tl-ms-ctx")).toBeNull();
  });
});

describe("rows that cannot act", () => {
  it("are inert while watching, and say so", () => {
    const onPickMode = vi.fn();
    const onPickModel = vi.fn();
    mount({
      model: { model: "claude-opus-5-5", effort: "high" },
      inertReason: "Watching: another device is typing",
      onPickMode,
      onPickModel,
    });
    open();
    for (const b of [...modelRows(), ...modeRows(), ...efforts()]) {
      expect(b.getAttribute("aria-disabled"), b.textContent ?? "").toBe("true");
    }
    fireEvent.click(modelRow("Sonnet 5"));
    fireEvent.click(modeRow("Plan"));
    fireEvent.click(effort("max"));
    expect(onPickModel).not.toHaveBeenCalled();
    expect(onPickMode).not.toHaveBeenCalled();
    expect(float()!.textContent).toContain("Watching: another device is typing");
  });

  // A dialog can arrive while the sheet is open: every row is held then.
  it("are held when a dialog lands on the pane while the sheet is open", () => {
    const [held, setHeld] = createSignal("");
    const onPickMode = vi.fn();
    render(() => (
      <ModelSheet
        harness="claude"
        mode="manual"
        model={{ model: "claude-opus-5-5", effort: "high" }}
        modeHeld={held()}
        modelHeld={held()}
        onPickMode={onPickMode}
        onPickModel={() => {}}
      />
    ));
    open();
    setHeld("Answer Claude first");
    for (const b of [...modelRows(), ...modeRows(), ...efforts()]) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
    }
    fireEvent.click(modeRow("Plan"));
    expect(onPickMode).not.toHaveBeenCalled();
    expect(float()!.textContent).toContain("Answer Claude first");
  });
});
