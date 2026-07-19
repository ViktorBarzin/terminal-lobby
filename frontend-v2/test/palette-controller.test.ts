import { describe, it, expect, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  createPaletteController,
  type PaletteController,
  type PaletteEnv,
} from "../src/keybindings/palette-controller";

/**
 * The reactive palette controller (open/close/filter/select/run). Ranking itself
 * is covered by palette.logic.test.ts; this verifies the controller wiring — the
 * async session cache, the ">"-prefix filter through to rows, keyboard selection
 * clamping, and the keepFocus-vs-refocus close semantics.
 */

function makeEnv(over: Partial<PaletteEnv> = {}): PaletteEnv {
  return {
    sessions: async () => [
      { name: "api", state: "running" },
      { name: "web" },
    ],
    current: () => "api",
    attach: vi.fn(),
    actions: () => [
      { label: "New session", keepFocus: true, run: vi.fn() },
      { label: "Kill current session", danger: true, run: vi.fn() },
    ],
    refocus: vi.fn(),
    ...over,
  };
}

/** Run `body` inside a Solid root (so createMemo tracks), then dispose. */
async function withPalette(
  env: PaletteEnv,
  body: (ctrl: PaletteController) => Promise<void> | void,
): Promise<void> {
  let dispose: () => void = () => {};
  await new Promise<void>((resolve, reject) => {
    createRoot((d) => {
      dispose = d;
      // Create the controller SYNCHRONOUSLY inside the root so its createMemos
      // are owned by it; only the assertions run async.
      const ctrl = createPaletteController(env);
      Promise.resolve().then(() => body(ctrl)).then(resolve, reject);
    });
  });
  dispose();
}

/** Flush the async session-load microtask chain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const titles = (ctrl: PaletteController) => ctrl.flatItems().map((i) => i.title);

describe("createPaletteController", () => {
  it("opens with the Loading note, then lists sessions + actions", async () => {
    await withPalette(makeEnv(), async (ctrl) => {
      ctrl.open();
      expect(ctrl.isOpen()).toBe(true);
      // before the async load resolves, the Sessions group shows the note
      expect(ctrl.rows().some((r) => r.kind === "note" && r.note === "Loading sessions…")).toBe(true);
      await flush();
      expect(titles(ctrl)).toEqual(["api", "web", "New session", "Kill current session"]);
      // the attached session is marked "current"
      const api = ctrl.flatItems().find((i) => i.title === "api");
      expect(api?.meta).toBe("current");
    });
  });

  it("a '>' query restricts to actions and filters them", async () => {
    await withPalette(makeEnv(), async (ctrl) => {
      ctrl.open();
      await flush();
      ctrl.setQuery(">kill");
      expect(titles(ctrl)).toEqual(["Kill current session"]);
    });
  });

  it("filters + ranks sessions on a plain query", async () => {
    const env = makeEnv({
      sessions: async () => [{ name: "api" }, { name: "web-api" }, { name: "db" }],
    });
    await withPalette(env, async (ctrl) => {
      ctrl.open();
      await flush();
      ctrl.setQuery("api");
      // prefix "api" outranks substring "web-api"; "db" filtered out.
      expect(titles(ctrl)).toEqual(["api", "web-api"]);
    });
  });

  it("clamps keyboard selection to the visible items", async () => {
    await withPalette(makeEnv(), async (ctrl) => {
      ctrl.open();
      await flush();
      ctrl.moveSel(-1);
      expect(ctrl.selIdx()).toBe(0); // can't go below 0
      ctrl.moveSel(999);
      expect(ctrl.selIdx()).toBe(ctrl.flatItems().length - 1); // clamped to last
    });
  });

  it("runSelected runs the selected item's action", async () => {
    const attach = vi.fn();
    await withPalette(makeEnv({ attach }), async (ctrl) => {
      ctrl.open();
      await flush();
      ctrl.setSel(1); // "web"
      ctrl.runSelected();
      expect(attach).toHaveBeenCalledWith("web");
      expect(ctrl.isOpen()).toBe(false);
    });
  });

  it("keepFocus items close WITHOUT refocus; others refocus the terminal", async () => {
    const refocus = vi.fn();
    await withPalette(makeEnv({ refocus }), async (ctrl) => {
      ctrl.open();
      await flush();
      const newSession = ctrl.flatItems().find((i) => i.title === "New session")!;
      ctrl.runItem(newSession); // keepFocus: true
      expect(ctrl.isOpen()).toBe(false);
      expect(refocus).not.toHaveBeenCalled();

      ctrl.open();
      await flush();
      const kill = ctrl.flatItems().find((i) => i.title === "Kill current session")!;
      ctrl.runItem(kill); // keepFocus: false -> refocus
      expect(refocus).toHaveBeenCalledTimes(1);
    });
  });

  it("toggle opens then closes", async () => {
    await withPalette(makeEnv(), async (ctrl) => {
      ctrl.toggle();
      expect(ctrl.isOpen()).toBe(true);
      ctrl.toggle();
      expect(ctrl.isOpen()).toBe(false);
    });
  });
});
