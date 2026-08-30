import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { installSoftKeysReserve } from "../src/mobile/softkeys-reserve";

const on = () => document.body.classList.contains("has-soft-keys");
/** Solid queues effects past the synchronous block they are created in. */
const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));

describe("installSoftKeysReserve", () => {
  beforeEach(() => document.body.classList.remove("has-soft-keys"));

  it("reserves the height on a coarse pointer", async () => {
    const dispose = createRoot((d) => {
      installSoftKeysReserve(() => true);
      return d;
    });
    await flush();
    expect(on()).toBe(true);
    dispose();
  });

  it("reserves nothing on a fine pointer", async () => {
    const dispose = createRoot((d) => {
      installSoftKeysReserve(() => false);
      return d;
    });
    await flush();
    expect(on()).toBe(false);
    dispose();
  });

  it("follows the pointer type when it flips", async () => {
    const [coarse, setCoarse] = createSignal(false);
    const dispose = createRoot((d) => {
      installSoftKeysReserve(coarse);
      return d;
    });
    await flush();
    expect(on()).toBe(false);
    setCoarse(true);
    await flush();
    expect(on()).toBe(true);
    dispose();
  });

  it("gives the height back when its owner goes away", async () => {
    const dispose = createRoot((d) => {
      installSoftKeysReserve(() => true);
      return d;
    });
    await flush();
    expect(on()).toBe(true);
    dispose();
    expect(on()).toBe(false);
  });

  // Why this must be installed once per APP and never per session: the class is
  // one piece of shared document state, so a second owner disposing takes it
  // away from the first. SessionView held this until 2026-08-30 and the shell
  // keeps every opened session mounted, so closing one session dropped the
  // keyboard reservation for every session still on screen.
  it("is taken away by any owner disposing, which is why there is exactly one", async () => {
    const disposeA = createRoot((d) => {
      installSoftKeysReserve(() => true);
      return d;
    });
    const disposeB = createRoot((d) => {
      installSoftKeysReserve(() => true);
      return d;
    });
    await flush();
    expect(on()).toBe(true);
    disposeB();
    expect(on()).toBe(false); // A is still running and has lost its reservation
    disposeA();
  });
});
