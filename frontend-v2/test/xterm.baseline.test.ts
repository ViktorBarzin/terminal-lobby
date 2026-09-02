/**
 * xterm has to survive the iPadOS 15.8 floor, and it is not our code.
 *
 * Bundling xterm into the SPA (ADR-0017, the native terminal) put 330 KB of
 * third-party code inside the compatibility floor for the first time. The
 * syntax guards in scripts/test_frontend_compat.py cover parsing: esbuild
 * re-checks every shipped chunk against safari15, xterm's included. They cannot
 * see a RUNTIME api, and the shipped xterm chunk reaches one the floor does not
 * have — `new OffscreenCanvas(100, 100)`, Safari 16.4, in its text-measuring
 * strategy.
 *
 * Reading the minified bytes says xterm wraps that in try/catch and installs a
 * DOM-measuring strategy instead. That is an upstream implementation detail: it
 * holds until an xterm bump rewrites those lines, and nothing here would say so.
 * This test asserts the BEHAVIOUR rather than the bytes, so an xterm upgrade
 * that drops the fallback fails here instead of on bob's iPad.
 *
 * jsdom happens to have no OffscreenCanvas, which is what makes this testable
 * at all — the environment already IS the floor for this one api. The first
 * test pins that, because an environment that quietly gains OffscreenCanvas
 * would leave the second test passing while testing nothing. A guard that
 * cannot fail is the failure mode this file exists to avoid; the same shape
 * left the runtime-api check in test_frontend_compat.py vacuous for five days.
 */
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

/** jsdom lacks these; every Safari since 5 has them. Faking a JSDOM gap is
 *  fair. Faking a Safari 15.6 gap would defeat the point, so OffscreenCanvas
 *  is deliberately left absent. */
function shimJsdomGaps(): void {
  (window as unknown as Record<string, unknown>).matchMedia = () => ({
    matches: false,
    // xterm calls the deprecated addListener, not addEventListener — which is
    // the older api, so this is one place it is friendlier to the floor.
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

describe("xterm on the iPadOS 15.8 floor", () => {
  it("runs here without OffscreenCanvas, as it would on Safari 15.6", () => {
    expect(
      (globalThis as Record<string, unknown>).OffscreenCanvas,
      "jsdom gained OffscreenCanvas, so the test below no longer exercises the " +
        "floor it claims to. Delete OffscreenCanvas from the global in this " +
        "file's setup, or the fallback goes unchecked while the suite stays green.",
    ).toBeUndefined();
  });

  it("opens, parses and renders text with the measuring fallback", async () => {
    shimJsdomGaps();
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 800 });
    Object.defineProperty(host, "clientHeight", { value: 600 });
    document.body.appendChild(host);

    const term = new Terminal({ cols: 80, rows: 24 });
    // Throws on an engine without OffscreenCanvas if the fallback ever goes.
    term.open(host);
    await new Promise<void>((resolve) => term.write("hello floor", resolve));

    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe(
      "hello floor",
    );
    expect(host.querySelector(".xterm-screen")).not.toBeNull();
    term.dispose();
  });
});
