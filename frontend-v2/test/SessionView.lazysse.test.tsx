import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";

/**
 * The terminal is scenery here, and since the flip (2026-09-04) the scenery is
 * expensive: a bare URL mounts the terminal the app renders itself, which boots
 * a real xterm, and xterm's `CoreBrowserService` calls `matchMedia`, which
 * jsdom does not ship. So `term.open()` rejects and Vitest fails the FILE on
 * the unhandled rejection while every assertion in it passes.
 *
 * Stubbed rather than sent to `?native=0`, so these tests keep mounting the
 * branch a person actually gets. What the real component does is
 * TerminalNative.wiring.test.tsx, which brings its own `matchMedia`.
 */
vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: () => <div class="tl-terminal-native" />,
}));

import { SessionView } from "../src/components/SessionView";

/**
 * WHEN the transcript stream opens.
 *
 * v1 ships terminal-first: a session opens on the Terminal view and Text is
 * opt-in. The session store used to connect `/events/<session>` from its
 * constructor and the view creates that store on mount, so every session opened
 * a stream for a view it may never show — pointless connections and reconnect
 * ladders on a mobile network, plus a 404 per plain-shell session per load
 * (no Claude in it, so session-events has no transcript to stream).
 *
 * So the first connect waits for Text mode to actually be shown. Only the FIRST
 * one: once open the stream stays open for the life of this view, because the
 * [Text] segment's activity dot is exactly the promise that the timeline keeps
 * filling while you are looking at the terminal.
 */

interface FakeSource {
  url: string;
  closed: boolean;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}

const eventSources: FakeSource[] = [];
const g = globalThis as unknown as { EventSource?: unknown };

const segments = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"));

const dots = (root: HTMLElement): boolean[] =>
  segments(root).map((b) => !!b.querySelector(".tl-activity-dot"));

const mode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;

const feed = (src: FakeSource | undefined, id: number, body: string): void =>
  src?.onmessage?.({
    data: JSON.stringify({ id, kind: "text", session: "qa-lazy", body }),
  });

describe("<SessionView> — the transcript stream is opened by Text mode", () => {
  let origES: unknown;
  beforeEach(() => {
    origES = g.EventSource;
    eventSources.length = 0;
    g.EventSource = class implements FakeSource {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      closed = false;
      constructor(public url: string) {
        eventSources.push(this);
      }
      // The store holds its first paint until the opening window is complete;
      // this fake has no replay, so it is complete the moment it is asked for.
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: "0" });
      }
      close(): void {
        this.closed = true;
      }
    };
    localStorage.clear();
  });
  afterEach(() => {
    g.EventSource = origES;
    localStorage.clear();
  });

  it("opens no stream for a session that lands on the Terminal view", () => {
    const { container } = render(() => <SessionView session="qa-lazy" />);
    expect(mode(container)).toBe("terminal");
    expect(eventSources).toHaveLength(0);
  });

  it("opens the stream when Text mode is first shown", () => {
    const { container } = render(() => <SessionView session="qa-lazy" />);
    expect(eventSources).toHaveLength(0);

    fireEvent.click(segments(container)[0]!); // [Text]
    expect(mode(container)).toBe("text");
    expect(eventSources).toHaveLength(1);
    expect(eventSources[0]?.url).toContain("qa-lazy");
  });

  it("connects on mount for a session you left in Text mode", () => {
    localStorage.setItem("tl:viewmode:v1:qa-lazy", "text");
    const { container } = render(() => <SessionView session="qa-lazy" />);
    expect(mode(container)).toBe("text");
    // The remembered mode IS the view being shown — there is no click to wait
    // for, so mount is the moment Text is first shown.
    expect(eventSources).toHaveLength(1);
  });

  it("keeps the stream when you switch back to the Terminal", async () => {
    const { container } = render(() => <SessionView session="qa-lazy" />);
    fireEvent.click(segments(container)[0]!); // [Text]
    expect(eventSources).toHaveLength(1);

    fireEvent.click(segments(container)[1]!); // [Terminal]
    expect(mode(container)).toBe("terminal");
    expect(eventSources[0]?.closed).toBe(false);
    expect(eventSources).toHaveLength(1);

    // ...and it is still filling the timeline, which is what the [Text]
    // segment's activity dot reports while you are not looking at it.
    feed(eventSources[0], 1, "arrived while you were in the terminal");
    // The store coalesces arriving events into one write per frame, so the dot
    // appears on the next frame rather than inside this tick.
    await new Promise((r) => setTimeout(r, 40));
    expect(dots(container)).toEqual([true, false]);
  });

  it("opens exactly one stream however often you toggle the view", () => {
    const { container } = render(() => <SessionView session="qa-lazy" />);
    for (let i = 0; i < 3; i++) {
      fireEvent.click(segments(container)[0]!); // [Text]
      fireEvent.click(segments(container)[1]!); // [Terminal]
    }
    fireEvent.click(segments(container)[0]!); // [Text]
    expect(eventSources).toHaveLength(1);
  });

  it("reports the first open of Text as connecting, not as a failure", () => {
    const published: (string | null)[] = [];
    const { container } = render(() => (
      <SessionView
        session="qa-lazy"
        status={{
          channels: () => [],
          onOpen: () => {},
          onTranscript: (s) => void published.push(s),
          onFrameConn: () => {},
          askConn: () => {},
          retryConn: () => {},
        }}
      />
    ));
    // Before Text: nothing has asked the stream to open, so the view says
    // NOTHING about it rather than publishing the `connecting` initial value —
    // which is what made a terminal-only session look broken (c494629).
    expect(published.every((s) => s === null)).toBe(true);

    fireEvent.click(segments(container)[0]!); // [Text] opens the stream
    // Now it reports the connection it just triggered, not the vocabulary of a
    // broken one.
    expect(published[published.length - 1]).toBe("connecting");
  });

  it("unmounts cleanly when the stream was never opened", () => {
    const { unmount } = render(() => <SessionView session="qa-lazy" />);
    expect(eventSources).toHaveLength(0);
    expect(() => unmount()).not.toThrow();
    expect(eventSources).toHaveLength(0);
  });

  it("closes the stream on unmount once it HAS been opened", () => {
    const { container, unmount } = render(() => <SessionView session="qa-lazy" />);
    fireEvent.click(segments(container)[0]!); // [Text]
    expect(eventSources).toHaveLength(1);

    unmount();
    expect(eventSources[0]?.closed).toBe(true);
  });

  it("renders the transcript-derived surfaces on an empty stream", () => {
    // Nothing has connected, so `store.events` is empty — the timeline, the
    // pending-permission list and the preview store's recent-files list all
    // derive from it and must simply render nothing.
    const { container } = render(() => <SessionView session="qa-lazy" />);
    expect(eventSources).toHaveLength(0);
    expect(dots(container)).toEqual([false, false]);

    fireEvent.click(container.querySelector('[aria-label="File preview"]')!);
    expect(container.querySelector(".tl-preview-panel")).toBeTruthy();
    expect(container.querySelector(".tl-preview-recents")).toBeNull();
  });
});
