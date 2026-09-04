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

/**
 * The two upstream behaviours the native paste fix rests on.
 *
 * Ctrl+V on the app-rendered terminal used to send a raw 0x16 to the pty, which
 * in zsh is quoted-insert and swallowed the next key, so the paste that followed
 * arrived corrupted. The fix answers `false` from `attachCustomKeyEventHandler`
 * for the paste chord and lets the browser's own paste event carry the text.
 * That works only because of two things xterm does today, neither of them
 * promised by its API:
 *
 *   1. `_keyDown` consults the custom handler FIRST and returns before it emits
 *      data or cancels the event, so one `false` suppresses both the 0x16 and
 *      the `preventDefault` that would have eaten the paste event.
 *   2. `handlePasteEvent` is registered on the helper textarea and on `.xterm`,
 *      both DESCENDANTS of the host, which is the only reason a capture-phase
 *      listener on the host can stop the event before xterm sees it and paste
 *      the text exactly once.
 *
 * Bump xterm past a rewrite of either and the component keeps typechecking and
 * every mocked test keeps passing, while Ctrl+V becomes a silent no-op (case 1)
 * or pastes twice (case 2). This is the file that runs the real library, so
 * this is where those two get pinned.
 */
describe("what the native paste fix borrows from xterm", () => {
  const openReal = (): { term: Terminal; host: HTMLDivElement } => {
    shimJsdomGaps();
    const host = document.createElement("div");
    Object.defineProperty(host, "clientWidth", { value: 800 });
    Object.defineProperty(host, "clientHeight", { value: 600 });
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24 });
    term.open(host);
    return { term, host };
  };

  it("lets a custom handler suppress BOTH the data and the preventDefault", () => {
    const { term, host } = openReal();
    const data: string[] = [];
    term.onData((d) => void data.push(d));
    term.attachCustomKeyEventHandler((e) => !(e.key === "v" && e.ctrlKey));

    const textarea = host.querySelector("textarea");
    expect(textarea, "xterm no longer mounts a helper textarea").not.toBeNull();
    const ev = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea?.dispatchEvent(ev);

    expect(data, "a refused chord still reached the pty").toEqual([]);
    expect(
      ev.defaultPrevented,
      "xterm cancelled a keydown its custom handler refused, so the browser " +
        "paste event that carries the clipboard will never fire and Ctrl+V " +
        "becomes a silent no-op on the native terminal",
    ).toBe(false);
    term.dispose();
    host.remove();
  });

  it("registers its own paste listener inside the host, not on the document", () => {
    const { term, host } = openReal();
    const data: string[] = [];
    term.onData((d) => void data.push(d));

    // Dispatched at the host itself, which is ABOVE anything xterm listens on.
    // If xterm had moved its listener to the document, this would still reach
    // it and the component's own capture listener could not deduplicate.
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: () => "pasted" },
    });
    host.dispatchEvent(ev);

    expect(
      data,
      "a paste dispatched AT the host reached xterm, so xterm now listens at or " +
        "above the host. The native terminal stops the event on the host to " +
        "keep xterm from pasting the same text a second time, and that no " +
        "longer works, so every Ctrl+V pastes twice",
    ).toEqual([]);

    // The same event one level down MUST arrive, or the assertion above proves
    // nothing: a malformed clipboardData would be ignored wherever it was
    // dispatched, and this test would pass while measuring the fake rather than
    // xterm. Dispatched at the helper textarea, which is where xterm does
    // listen.
    const textarea = host.querySelector("textarea");
    const inner = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(inner, "clipboardData", {
      value: { getData: () => "pasted" },
    });
    textarea?.dispatchEvent(inner);
    expect(
      data,
      "xterm ignored a paste dispatched at its own textarea, so the negative " +
        "assertion above is vacuous and this file is not measuring what it says",
    ).toEqual(["pasted"]);

    term.dispose();
    host.remove();
  });
});
