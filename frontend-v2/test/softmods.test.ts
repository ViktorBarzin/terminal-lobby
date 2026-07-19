import { describe, it, expect } from "vitest";
import {
  applyMods,
  consumeSoftMods,
  idleMods,
  modActive,
  revertArmed,
  tapMod,
  type SoftMods,
} from "../src/mobile/softmods";

describe("softmods — tri-state tap cycle", () => {
  it("starts all idle", () => {
    expect(idleMods()).toEqual({ ctrl: "idle", alt: "idle" });
  });

  it("cycles idle → armed → latched → idle on successive taps", () => {
    let m = idleMods();
    m = tapMod(m, "ctrl");
    expect(m.ctrl).toBe("armed");
    m = tapMod(m, "ctrl");
    expect(m.ctrl).toBe("latched");
    m = tapMod(m, "ctrl");
    expect(m.ctrl).toBe("idle");
  });

  it("tracks ctrl and alt independently", () => {
    let m = idleMods();
    m = tapMod(m, "ctrl"); // ctrl armed
    m = tapMod(m, "alt"); // alt armed, ctrl untouched
    expect(m).toEqual({ ctrl: "armed", alt: "armed" });
    m = tapMod(m, "alt"); // alt latched
    expect(m).toEqual({ ctrl: "armed", alt: "latched" });
  });

  it("does not mutate the input (returns a new object)", () => {
    const m0: SoftMods = idleMods();
    const m1 = tapMod(m0, "ctrl");
    expect(m0.ctrl).toBe("idle");
    expect(m1).not.toBe(m0);
  });

  it("modActive is true for armed and latched, false for idle", () => {
    expect(modActive("idle")).toBe(false);
    expect(modActive("armed")).toBe(true);
    expect(modActive("latched")).toBe(true);
  });
});

describe("softmods — revertArmed (double-tap timer body)", () => {
  it("drops a still-armed modifier to idle", () => {
    const m = revertArmed({ ctrl: "armed", alt: "idle" }, "ctrl");
    expect(m.ctrl).toBe("idle");
  });

  it("leaves a latched modifier alone (a latch beat the timer)", () => {
    const m = revertArmed({ ctrl: "latched", alt: "idle" }, "ctrl");
    expect(m.ctrl).toBe("latched");
  });

  it("leaves an already-idle modifier alone", () => {
    const before = { ctrl: "idle", alt: "idle" } as SoftMods;
    expect(revertArmed(before, "ctrl")).toEqual(before);
  });
});

describe("softmods — consumeSoftMods (one-shot vs sticky)", () => {
  it("drops armed to idle after a key", () => {
    expect(consumeSoftMods({ ctrl: "armed", alt: "idle" })).toEqual({
      ctrl: "idle",
      alt: "idle",
    });
  });

  it("keeps latched sticky across keys", () => {
    expect(consumeSoftMods({ ctrl: "latched", alt: "armed" })).toEqual({
      ctrl: "latched",
      alt: "idle",
    });
  });

  it("is a no-op when both are idle", () => {
    expect(consumeSoftMods(idleMods())).toEqual(idleMods());
  });
});

describe("softmods — applyMods byte remap", () => {
  const armedCtrl: SoftMods = { ctrl: "armed", alt: "idle" };
  const latchedCtrl: SoftMods = { ctrl: "latched", alt: "idle" };
  const armedAlt: SoftMods = { ctrl: "idle", alt: "armed" };

  it("passes data through unchanged with no active modifier", () => {
    expect(applyMods("c", idleMods())).toBe("c");
    expect(applyMods("hello", idleMods())).toBe("hello");
  });

  it("maps Ctrl + letter to the C0 control char (Ctrl+C = 0x03)", () => {
    expect(applyMods("c", armedCtrl)).toBe("\x03");
    expect(applyMods("C", armedCtrl)).toBe("\x03"); // case-insensitive
    expect(applyMods("d", armedCtrl)).toBe("\x04");
    expect(applyMods("a", latchedCtrl)).toBe("\x01"); // latched remaps too
  });

  it("prefixes ESC for Alt (meta) and stacks with Ctrl", () => {
    expect(applyMods("b", armedAlt)).toBe("\x1bb");
    // Ctrl+Alt+c → ESC + 0x03
    expect(applyMods("c", { ctrl: "armed", alt: "latched" })).toBe("\x1b\x03");
  });

  it("only transforms the FIRST char, appending the rest verbatim", () => {
    expect(applyMods("cat", armedCtrl)).toBe("\x03at");
    expect(applyMods("xyz", armedAlt)).toBe("\x1bxyz");
  });

  it("leaves a non-letter first char alone for Ctrl (only ESC-prefix for Alt)", () => {
    expect(applyMods("1", armedCtrl)).toBe("1"); // Ctrl+digit: not a letter, unchanged
    expect(applyMods("1", armedAlt)).toBe("\x1b1"); // Alt+digit: ESC-prefixed
  });

  it("returns empty input unchanged", () => {
    expect(applyMods("", armedCtrl)).toBe("");
  });
});
