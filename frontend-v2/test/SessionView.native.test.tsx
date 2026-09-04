/**
 * WHICH TERMINAL a tab gets, and the two levers the shell holds over it.
 *
 * Two things are checked here, both of them SessionView's own wiring rather
 * than either terminal's behaviour:
 *
 *   - the `?native` read. Presence was the whole test until now, so `?native=0`
 *     turned native ON, which makes the flag useless as the way back to the
 *     iframe once native is the default (the de-iframe plan's "a URL override
 *     that works in both directions").
 *   - the ADR-0016 connection ask. `askConn` was passed on the iframe branch
 *     only, so the badge and Run check could not ask a native terminal what its
 *     socket was doing. What the native terminal DOES when asked is
 *     TerminalNative.wiring.test.tsx and terminal.attach.test.ts.
 *
 * `TerminalNative` is stubbed for exactly that reason: this file is about the
 * branch and the handover, and a real one would boot xterm, a socket and a
 * ResizeObserver to answer a question about neither. The iframe branch stays
 * real, so `iframe.tl-ttyd` is the shipped component and not a stand-in.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import type { TerminalReport } from "../src/diagnostics/status";

/** The control object the stub hands up, and how often each lever was pulled. */
const native = vi.hoisted(() => ({ asks: 0, retries: 0, mounted: 0 }));

vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: (props: {
    onReady?: (control: { reconnect: () => void; ask: () => void }) => void;
  }) => {
    native.mounted++;
    props.onReady?.({
      reconnect: () => void native.retries++,
      ask: () => void native.asks++,
    });
    return <div class="tl-terminal-native" />;
  },
}));

import { SessionView, nativeFromSearch } from "../src/components/SessionView";

/** The status surface a mounted view is handed, with both levers captured. */
function statusProbe() {
  const held = { ask: () => {}, retry: () => {} };
  return {
    held,
    props: {
      channels: () => [],
      onOpen: () => {},
      onTranscript: () => {},
      onFrameConn: (_r: TerminalReport | null) => {},
      askConn: (ask: () => void) => void (held.ask = ask),
      retryConn: (retry: () => void) => void (held.retry = retry),
    },
  };
}

/** Put the tab on a URL, the way someone typing the flag would. */
function at(search: string): void {
  window.history.replaceState({}, "", "/" + search);
}

afterEach(() => {
  at("");
  native.asks = 0;
  native.retries = 0;
  native.mounted = 0;
});

/* ------------------------------------------------------------------ *
 * The flag itself
 * ------------------------------------------------------------------ */

describe("reading ?native", () => {
  /**
   * The tokens a person would actually type, in both directions. `null` is
   * "the URL did not say", which is what leaves the default standing, and the
   * default is still the iframe in this pass.
   */
  it.each([
    ["?native=1", true],
    ["?native=true", true],
    ["?native=yes", true],
    ["?native=on", true],
    ["?native=TRUE", true],
    // A bare flag and an empty value are the same string once parsed, so they
    // cannot be told apart and both read as yes.
    ["?native", true],
    ["?native=", true],
    ["?native=0", false],
    ["?native=false", false],
    ["?native=no", false],
    ["?native=off", false],
    ["?native=OFF", false],
    ["", null],
    ["?other=1", null],
    ["?native=banana", null],
  ])("reads %j as %o", (search, want) => {
    expect(nativeFromSearch(search)).toBe(want);
  });

  /** The flag lives beside the rest of the query, not alone. */
  it("finds the flag among other params", () => {
    expect(nativeFromSearch("?arg=demo&native=0&lens=emo")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * What the flag selects
 * ------------------------------------------------------------------ */

describe("which terminal <SessionView> mounts for the flag", () => {
  const iframe = (root: HTMLElement): Element | null =>
    root.querySelector("iframe.tl-ttyd");
  const host = (root: HTMLElement): Element | null =>
    root.querySelector(".tl-terminal-native");

  it("mounts the iframe when the URL says nothing", () => {
    const { container } = render(() => <SessionView session="qa-native-off" />);
    expect(iframe(container)).toBeTruthy();
    expect(host(container)).toBeNull();
  });

  /**
   * The bug this pass fixes. `.has("native")` read `?native=0` as a request
   * FOR native, so the one URL a person would try to get back to the iframe
   * did the opposite.
   */
  it("mounts the iframe for ?native=0", () => {
    at("?native=0");
    const { container } = render(() => <SessionView session="qa-native-0" />);
    expect(iframe(container)).toBeTruthy();
    expect(host(container)).toBeNull();
    expect(native.mounted).toBe(0);
  });

  it("mounts the app's own terminal for ?native=1", () => {
    at("?native=1");
    const { container } = render(() => <SessionView session="qa-native-1" />);
    expect(host(container)).toBeTruthy();
    expect(iframe(container)).toBeNull();
  });

  /** An unrecognised value is not a vote, so the default stands. */
  it("mounts the iframe for a value it does not understand", () => {
    at("?native=maybe");
    const { container } = render(() => <SessionView session="qa-native-junk" />);
    expect(iframe(container)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * The ADR-0016 levers, on the native branch
 * ------------------------------------------------------------------ */

describe("the connection levers <SessionView> gives a native terminal", () => {
  it("routes the status model's ask to the native terminal", () => {
    at("?native=1");
    const probe = statusProbe();
    render(() => <SessionView session="qa-native-ask" status={probe.props} />);
    // The effect asks once on becoming visible, because a terminal that was
    // already open volunteers nothing on return.
    const onMount = native.asks;
    expect(onMount).toBeGreaterThan(0);
    probe.held.ask();
    expect(native.asks).toBe(onMount + 1);
  });

  it("routes Reconnect to the native terminal", () => {
    at("?native=1");
    const probe = statusProbe();
    render(() => <SessionView session="qa-native-retry" status={probe.props} />);
    probe.held.retry();
    expect(native.retries).toBe(1);
  });

  /** The iframe branch keeps the levers it already had. */
  it("leaves the iframe branch asking the frame", () => {
    const probe = statusProbe();
    render(() => <SessionView session="qa-native-iframe" status={probe.props} />);
    expect(() => probe.held.ask()).not.toThrow();
    expect(native.asks).toBe(0);
  });
});
