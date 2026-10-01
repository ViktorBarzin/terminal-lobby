/**
 * The Browser panel inside a session's pane (design 2026-10-01, "The Browser
 * panel"). Beside the view, the panel takes about half the pane and at least
 * 360px; a desktop window under 720px wide left the chat about 30px
 * (review 2026-10-01). So the pane is measured, and under 720px the panel
 * covers it and the view keeps its full width behind, whatever the pointer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { SessionView } from "../src/components/SessionView";

// A real terminal boots xterm, which jsdom cannot run; the pane is under test.
vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: () => <div class="tl-terminal-native" />,
}));

class FakeEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

/** Every element observed for its size, and a way to report a new one. */
let observed: { target: Element; cb: ResizeObserverCallback; ro: ResizeObserver }[] = [];
class FakeRO {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    observed.push({ target, cb: this.cb, ro: this as unknown as ResizeObserver });
  }
  unobserve(): void {}
  disconnect(): void {
    observed = observed.filter((o) => o.ro !== (this as unknown as ResizeObserver));
  }
}

/** Report `width` for the pane, the way a real observer does on a resize. */
const resizePane = (pane: Element, width: number): void => {
  for (const o of observed.filter((x) => x.target === pane)) {
    o.cb(
      [{ target: pane, contentRect: { width, height: 800 } } as unknown as ResizeObserverEntry],
      o.ro,
    );
  }
};

beforeEach(() => {
  localStorage.clear();
  observed = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", FakeRO);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("[]"))),
  );
});

const openPanel = () => {
  localStorage.setItem("tl:viewmode:v1:main", "text");
  const r = render(() => <SessionView session="main" browser={() => "live"} />);
  const button = r.container.querySelector<HTMLButtonElement>(".tl-browser-indicator");
  expect(button, "the bar's browser button").toBeTruthy();
  fireEvent.click(button!);
  const pane = r.container.querySelector("main.tl-views")!;
  const panel = () => r.container.querySelector(".tl-browser-panel");
  expect(panel()).toBeTruthy();
  return { ...r, pane, panel };
};

describe("<SessionView> — the Browser panel's room", () => {
  it("sits beside the view in a wide pane", () => {
    const { pane, panel } = openPanel();
    resizePane(pane, 1440);
    expect(pane.classList.contains("tl-browser-split")).toBe(true);
    expect(panel()!.hasAttribute("data-full")).toBe(false);
  });

  it("covers a pane under 720px, leaving the view its full width behind", () => {
    const { pane, panel } = openPanel();
    resizePane(pane, 700);
    expect(pane.classList.contains("tl-browser-split")).toBe(false);
    expect(panel()!.hasAttribute("data-full")).toBe(true);
    // Widening the window puts it back beside the view.
    resizePane(pane, 1200);
    expect(pane.classList.contains("tl-browser-split")).toBe(true);
    expect(panel()!.hasAttribute("data-full")).toBe(false);
  });
});
