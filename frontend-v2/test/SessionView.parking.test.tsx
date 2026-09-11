import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

/**
 * The terminal is scenery here, and expensive scenery: a real one boots xterm,
 * which calls `matchMedia`, which jsdom does not ship — so `term.open()`
 * rejects and Vitest fails the FILE on the unhandled rejection while every
 * assertion in it passes. TerminalNative.wiring.test.tsx exercises the real one.
 */
vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: () => <div class="tl-terminal-native" />,
}));

import { SessionView } from "../src/components/SessionView";
import { OFF_SCREEN_PARK_MS, WINDOW_PARK_MS } from "../src/store/session";

/**
 * WHEN the transcript stream closes.
 *
 * The lobby keeps every session you have opened MOUNTED and CSS-hides the ones
 * you are not looking at, for 24 hours (store/keepalive.ts), so until now a
 * sitting spent hopping between fifteen sessions ended with fifteen live SSE
 * streams, each re-deriving its own timeline on every event it received. Off
 * screen is the signal that nobody is reading one.
 *
 * The grace is what makes it free: flicking between two sessions to compare
 * them must not cost a reconnect each way, so the countdown is the same
 * OFF_SCREEN_PARK_MS the terminal's battery saver uses for the same question.
 *
 * Off screen is not the whole question, though. A tab pushed into the
 * background leaves the session ON screen and still unread, so that parks too,
 * on the longer WINDOW_PARK_MS.
 */
interface FakeSource {
  url: string;
  closed: boolean;
}

const eventSources: FakeSource[] = [];
const g = globalThis as unknown as { EventSource?: unknown };

/**
 * THE TAB THESE TESTS RUN IN. jsdom answers `document.hidden === false`, which
 * is the ordinary visible tab almost every case below describes; the ones that
 * want a background tab move `tabHidden` and then dispatch the event the
 * browser would have, so the listener under test is the one doing the work.
 *
 * `document.hasFocus()` was stubbed here until 2026-09-11, when the park stopped
 * reading it. SessionView asks the document one question now, `hidden`, so
 * jsdom's answer of false costs these tests nothing and the stub went with the
 * input.
 */
let tabHidden = false;
const hide = (): void => {
  tabHidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
};
const show = (): void => {
  tabHidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("<SessionView> — a session nobody is looking at parks its stream", () => {
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
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: JSON.stringify({ cursor: 0, epoch: "e1" }) });
      }
      removeEventListener(): void {}
      close(): void {
        this.closed = true;
      }
    };
    localStorage.clear();
    // Land in Text mode, so mount is the moment the stream opens and the test
    // is about going off screen rather than about the view switch.
    localStorage.setItem("tl:viewmode:v1:qa-park", "text");
    tabHidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => tabHidden });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    g.EventSource = origES;
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    localStorage.clear();
  });

  it("keeps the stream through a flick to another session and back", () => {
    const [visible, setVisible] = createSignal(true);
    render(() => <SessionView session="qa-park" visible={visible()} />);
    expect(eventSources).toHaveLength(1);

    setVisible(false);
    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS - 1000);
    expect(eventSources[0]!.closed).toBe(false);

    setVisible(true);
    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS * 2);
    // Nothing closed, and nothing reopened: a glance elsewhere is free.
    expect(eventSources[0]!.closed).toBe(false);
    expect(eventSources).toHaveLength(1);
  });

  it("closes it once the session has been off screen for the grace", () => {
    const [visible, setVisible] = createSignal(true);
    render(() => <SessionView session="qa-park" visible={visible()} />);

    setVisible(false);
    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS + 1);
    expect(eventSources[0]!.closed).toBe(true);
    expect(eventSources).toHaveLength(1);
  });

  it("opens it again the moment the session is back on screen", () => {
    const [visible, setVisible] = createSignal(true);
    render(() => <SessionView session="qa-park" visible={visible()} />);

    setVisible(false);
    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS + 1);
    setVisible(true);
    // No grace on the way back: the reader is looking at it now.
    expect(eventSources).toHaveLength(2);
    expect(eventSources[1]!.closed).toBe(false);
  });

  it("parks a session that was never on screen at all", () => {
    // The hover preload mounts a session before anyone has looked at it. Its
    // stream must age out like any other, or preloading would be a way to
    // accumulate exactly the cost this change removes.
    render(() => <SessionView session="qa-park" visible={false} />);
    expect(eventSources).toHaveLength(1);

    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS + 1);
    expect(eventSources[0]!.closed).toBe(true);
  });

  it("opens nothing for a session that never showed its Text view", () => {
    localStorage.setItem("tl:viewmode:v1:qa-park", "terminal");
    const [visible, setVisible] = createSignal(true);
    render(() => <SessionView session="qa-park" visible={visible()} />);
    expect(eventSources).toHaveLength(0);

    setVisible(false);
    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS + 1);
    setVisible(true);
    // Coming back on screen is not what opens a session's first stream — Text
    // mode is (SessionView's own lazy-open effect, and SessionView.lazysse).
    expect(eventSources).toHaveLength(0);
  });

  /**
   * The window-wide half of the question, and the only one left of it: a lobby
   * left open on a tab nobody has in front of them. `props.visible` never
   * changes, so the session is on screen for the whole of this and still unread.
   */
  it("closes it once the tab has been hidden for the longer grace", () => {
    render(() => <SessionView session="qa-park" visible={true} />);
    expect(eventSources).toHaveLength(1);

    hide();
    vi.advanceTimersByTime(WINDOW_PARK_MS - 1000);
    expect(eventSources[0]!.closed, "the minute is not up").toBe(false);

    vi.advanceTimersByTime(2000);
    expect(eventSources[0]!.closed).toBe(true);

    show();
    expect(eventSources).toHaveLength(2);
    expect(eventSources[1]!.closed).toBe(false);
  });

  it("waits the tab's full minute, not the shorter off-screen half", () => {
    render(() => <SessionView session="qa-park" visible={true} />);
    hide();
    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS + 1);
    expect(eventSources[0]!.closed, "off screen is the shorter clock, and this is not it").toBe(
      false,
    );
  });

  /**
   * ONE CONDITION CLEARED IS NOT EVERYONE BACK, the same rule the socket's
   * battery saver keeps. A session brought to the front of a tab that is still
   * in the background is still unread.
   */
  it("stays parked while the tab is still hidden", () => {
    const [visible, setVisible] = createSignal(false);
    render(() => <SessionView session="qa-park" visible={visible()} />);
    hide();
    vi.advanceTimersByTime(OFF_SCREEN_PARK_MS + 1);
    expect(eventSources[0]!.closed).toBe(true);

    setVisible(true);
    expect(eventSources, "on screen, but the tab is in the background").toHaveLength(1);

    show();
    expect(eventSources).toHaveLength(2);
  });

  it("stops counting when the view goes away mid-grace", () => {
    const [visible, setVisible] = createSignal(true);
    const { unmount } = render(() => <SessionView session="qa-park" visible={visible()} />);
    setVisible(false);
    unmount();
    expect(eventSources[0]!.closed).toBe(true);
    // The timer has to go with the view, or it fires against a disposed store.
    expect(() => vi.advanceTimersByTime(OFF_SCREEN_PARK_MS * 2)).not.toThrow();
    expect(eventSources).toHaveLength(1);
  });
});
