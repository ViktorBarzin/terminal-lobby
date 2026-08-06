import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { SessionView } from "../src/components/SessionView";

/**
 * The per-session view surface: the Ctrl/Cmd-J bridge the lobby dispatcher needs
 * to reach this component, and the [Terminal] segment's activity dot.
 *
 * The dot is the mirror of the [Text] one: output that arrives in the pty while
 * the text view is showing has to mark the segment you are NOT looking at. The
 * signal rides the terminal iframe's `tl-attention` postMessage, so these tests
 * drive that message rather than the latch directly.
 */

const g = globalThis as unknown as { EventSource?: unknown };

const segments = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"));

const dots = (root: HTMLElement): boolean[] =>
  segments(root).map((b) => !!b.querySelector(".tl-activity-dot"));

const mode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;

/** Post a message UP from the mounted terminal iframe, as term.html does. */
function fromFrame(root: HTMLElement, data: unknown): void {
  const frame = root.querySelector<HTMLIFrameElement>("iframe.tl-ttyd");
  expect(frame, "the mounted terminal iframe").toBeTruthy();
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: location.origin,
      source: frame?.contentWindow,
    }),
  );
}

describe("<SessionView> — view toggle bridge + terminal activity dot", () => {
  let origES: unknown;
  beforeEach(() => {
    origES = g.EventSource;
    g.EventSource = class {
      onopen: unknown = null;
      onerror: unknown = null;
      onmessage: unknown = null;
      constructor(public url: string) {}
      close(): void {}
    };
    localStorage.clear();
  });
  afterEach(() => {
    g.EventSource = origES;
    localStorage.clear();
  });

  it("registers window.__tlToggleView while mounted and clears it on unmount", () => {
    const { container, unmount } = render(() => <SessionView session="qa-vs" />);
    const toggle = window.__tlToggleView;
    expect(typeof toggle).toBe("function");
    expect(mode(container)).toBe("text");

    expect(toggle?.()).toBe(true);
    expect(mode(container)).toBe("terminal");
    expect(toggle?.()).toBe(true);
    expect(mode(container)).toBe("text");

    unmount();
    expect(window.__tlToggleView).toBeUndefined();
  });

  it("dots the [Terminal] segment when the frame signals output in text mode", () => {
    const { container } = render(() => <SessionView session="qa-vs" />);
    expect(dots(container)).toEqual([false, false]);

    fromFrame(container, { type: "tl-attention", kind: "output", session: "qa-vs" });
    // [Text (selected), Terminal (hidden — has unseen output)]
    expect(dots(container)).toEqual([false, true]);
  });

  it("clears the dot when you switch to the terminal", () => {
    const { container } = render(() => <SessionView session="qa-vs" />);
    fromFrame(container, { type: "tl-attention", kind: "bell", session: "qa-vs" });
    expect(dots(container)).toEqual([false, true]);

    fireEvent.click(segments(container)[1]!); // [Terminal]
    expect(mode(container)).toBe("terminal");
    expect(dots(container)).toEqual([false, false]);
  });

  it("still forwards the attention signal to the lobby (tab badge)", () => {
    const seen: string[] = [];
    const { container } = render(() => (
      <SessionView session="qa-vs" onFrameAttention={(kind) => seen.push(kind)} />
    ));
    fromFrame(container, { type: "tl-attention", kind: "output", session: "qa-vs" });
    expect(seen).toEqual(["output"]);
  });
});
