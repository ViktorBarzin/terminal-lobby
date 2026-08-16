import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { SessionView } from "../src/components/SessionView";
import { WATCH_KEY_PREFIX } from "../src/store/watchmode";
import { terminalUrl } from "../src/lib/terminal-url";

// Spy on the URL builder so the toggle→attach wiring can be asserted directly.
// jsdom does not navigate an iframe, so the built URL is otherwise unobservable.
vi.mock("../src/lib/terminal-url", async (orig) => {
  const real = await orig<typeof import("../src/lib/terminal-url")>();
  return { ...real, terminalUrl: vi.fn(real.terminalUrl) };
});

/**
 * The Watch toggle, as mounted in the session bar.
 *
 * These cover the wiring the unit tests cannot: that the control is REACHABLE
 * from the Text view (the Terminal view's first show is what triggers the
 * attach, so a toggle only reachable from Terminal would always be one attach
 * too late), that flipping it persists per session, and that the choice reaches
 * the terminal attach as arg5.
 *
 * SSE and the terminal iframe are inert here — jsdom loads neither — which is
 * fine: what is under test is the bar and the URL it produces.
 */

// The session store opens an EventSource; jsdom has none, so stub it away. The
// timeline is not what these tests are about.
class FakeEventSource {
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]"))));
  vi.mocked(terminalUrl).mockClear();
});

const watchButton = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>("button.tl-watch-btn")!;

describe("<SessionView> — the Watch toggle", () => {
  it("is present while the TEXT view is showing, so it can be set before the attach", () => {
    localStorage.setItem("tl:viewmode:v1:main", "text"); // start in text mode
    const { container } = render(() => <SessionView session="main" />);

    expect(container.querySelector(".tl-session-view")?.getAttribute("data-mode")).toBe("text");
    const btn = watchButton(container);
    expect(btn, "no Watch button in the session bar").toBeTruthy();
    expect(btn.offsetParent === null && btn.hidden).toBe(false);
  });

  it("starts off, so opening a session behaves exactly as it does today", () => {
    const { container } = render(() => <SessionView session="main" />);
    const btn = watchButton(container);
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.classList.contains("tl-watch-on")).toBe(false);
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBeNull();
  });

  it("clicking it turns watching on, and says so", async () => {
    const { container } = render(() => <SessionView session="main" />);
    const btn = watchButton(container);

    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-pressed")).toBe("true"));
    expect(btn.classList.contains("tl-watch-on")).toBe(true);
    expect(btn.textContent).toContain("Watching");
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBe("ro");

    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-pressed")).toBe("false"));
    // Turning it off records an EXPLICIT choice to drive, not an absence. With
    // no choice stored, the automatic rule would put a driven session straight
    // back into watch mode and the button would look inert.
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBe("rw");
  });

  it("joins as a viewer when someone is already driving, with nothing stored", () => {
    const { container } = render(() => (
      <SessionView session="main" driven={() => true} />
    ));
    expect(watchButton(container).getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBeNull();
  });

  it("drives a session nobody else is on, as before", () => {
    const { container } = render(() => (
      <SessionView session="main" driven={() => false} />
    ));
    expect(watchButton(container).getAttribute("aria-pressed")).toBe("false");
  });

  it("take-control sticks even while the other device keeps driving", async () => {
    const { container } = render(() => (
      <SessionView session="main" driven={() => true} />
    ));
    const btn = watchButton(container);
    expect(btn.getAttribute("aria-pressed")).toBe("true"); // auto-joined

    fireEvent.click(btn); // take control
    await waitFor(() => expect(btn.getAttribute("aria-pressed")).toBe("false"));
    expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBe("rw");
  });

  it("remembers per session — watching one does not silence another", async () => {
    const a = render(() => <SessionView session="main" />);
    fireEvent.click(watchButton(a.container));
    await waitFor(() =>
      expect(localStorage.getItem(WATCH_KEY_PREFIX + "main")).toBe("ro"),
    );
    a.unmount();

    const b = render(() => <SessionView session="other" />);
    expect(watchButton(b.container).getAttribute("aria-pressed")).toBe("false");
  });

  it("a session already marked as watched comes up watching", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "main", "ro");
    const { container } = render(() => <SessionView session="main" />);
    expect(watchButton(container).getAttribute("aria-pressed")).toBe("true");
  });

  /**
   * The end of the chain inside the browser: the toggle has to reach the
   * terminal iframe's URL as arg5. Losing it here means a client that asked to
   * watch attaches read-WRITE and takes the grid — the exact failure the whole
   * feature exists to prevent.
   */
  it("passes the request down to the terminal attach", async () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "main", "ro");
    render(() => <SessionView session="main" />);

    // jsdom never navigates contentWindow.location.replace, so asserting on the
    // iframe's src would pass vacuously. Assert the seam instead: what the view
    // asked the URL builder for. buildTerminalUrl's own output — that this lands
    // on arg5 with every earlier slot filled — is pinned in terminal-url.test.ts
    // and executed against the shipped term.html in test_watch_mode_e2e.py.
    await waitFor(() => expect(terminalUrl).toHaveBeenCalled());
    const calls = vi.mocked(terminalUrl).mock.calls;
    const withWatch = calls.filter(([, opts]) => opts?.watch === true);
    expect(
      withWatch.length,
      `terminalUrl never asked for watch; calls: ${JSON.stringify(calls)}`,
    ).toBeGreaterThan(0);
    expect(withWatch[0]![0]).toBe("main");
  });

  it("a session that is NOT watched asks for no such thing", async () => {
    render(() => <SessionView session="main" />);
    await waitFor(() => expect(terminalUrl).toHaveBeenCalled());
    for (const [, opts] of vi.mocked(terminalUrl).mock.calls) {
      expect(opts?.watch).toBeFalsy();
    }
  });
});
