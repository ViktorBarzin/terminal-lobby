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

const g = globalThis as unknown as { EventSource?: unknown; fetch?: unknown };

interface FakeSource {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}
const eventSources: FakeSource[] = [];

/** Let the SSE client's async failure classification settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const conn = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>(".tl-conn");

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
    eventSources.length = 0;
    g.EventSource = class {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      constructor(public url: string) {
        eventSources.push(this);
      }
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

  // Text mode is the DEFAULT view, so a plain shell session (no Claude, hence
  // no transcript registered with session-events) opens straight onto this
  // badge. It used to sit on RECONNECTING forever while the client hammered a
  // permanent 404.
  it("badges a session with no transcript as such, not as a failing connection", async () => {
    const origFetch = g.fetch;
    g.fetch = async () => new Response(null, { status: 404 });
    try {
      const { container } = render(() => <SessionView session="qa-vs" />);
      expect(conn(container)?.textContent).toBe("connecting");

      eventSources[0]!.onerror?.(null); // the 404 the browser reports opaquely
      await flush();

      expect(conn(container)?.getAttribute("data-status")).toBe("no-transcript");
      expect(conn(container)?.textContent).toBe("no transcript");
      expect(conn(container)?.getAttribute("title")).toContain("no Claude transcript");
    } finally {
      g.fetch = origFetch;
    }
  });

  it("still says reconnecting when the stream is merely unreachable", async () => {
    const origFetch = g.fetch;
    g.fetch = async () => new Response(null, { status: 502 });
    try {
      const { container } = render(() => <SessionView session="qa-vs" />);
      eventSources[0]!.onerror?.(null);
      await flush();
      expect(conn(container)?.getAttribute("data-status")).toBe("reconnecting");
      expect(conn(container)?.textContent).toBe("reconnecting");
    } finally {
      g.fetch = origFetch;
    }
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
