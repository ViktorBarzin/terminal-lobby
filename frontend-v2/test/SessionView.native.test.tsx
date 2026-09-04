/**
 * WHICH TERMINAL a tab gets, and what the shell hands the one it mounted.
 *
 * Three things are checked here, all of them SessionView's own wiring rather
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
 *   - `active` and `onAttention`, which the iframe branch already gets and the
 *     native branch did not. terminal/attention.ts needs both: its `view`
 *     event is the negation of `active`, and its `signal` action is the
 *     hand-up. A branch that is handed neither cannot tell that nobody is
 *     looking, and has nowhere to say so. What the module DECIDES from them is
 *     terminal.attention.test.ts; these props are only how they reach it.
 *
 * `TerminalNative` is stubbed for exactly that reason: this file is about the
 * branch and the handover, and a real one would boot xterm, a socket and a
 * ResizeObserver to answer a question about neither. The iframe branch stays
 * real, so `iframe.tl-ttyd` is the shipped component and not a stand-in.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { TerminalReport } from "../src/diagnostics/status";

/** The control object the stub hands up, and how often each lever was pulled. */
const native = vi.hoisted(() => ({
  asks: 0,
  retries: 0,
  mounted: 0,
  /**
   * `props.active` read AT THE MOMENT OF ASKING rather than captured at mount.
   * Solid compiles a prop whose expression calls a signal into a getter, so the
   * view switch that happens after mount is exactly what a stored boolean would
   * miss, and that switch is the interesting half of this prop.
   */
  active: null as null | (() => boolean | undefined),
  /** Fire the hand-up, standing in for attention.ts's `signal` action. */
  signal: null as null | ((kind: "bell" | "output") => void),
}));

vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: (props: {
    active?: boolean;
    onAttention?: (kind: "bell" | "output") => void;
    onReady?: (control: { reconnect: () => void; ask: () => void }) => void;
  }) => {
    native.mounted++;
    native.active = () => props.active;
    native.signal = (kind) => props.onAttention?.(kind);
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

/** The [Text | Terminal] switch, and its two activity dots, in that order. */
const segments = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"));

const dots = (root: HTMLElement): boolean[] =>
  segments(root).map((b) => !!b.querySelector(".tl-activity-dot"));

const mode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;

afterEach(() => {
  at("");
  native.asks = 0;
  native.retries = 0;
  native.mounted = 0;
  native.active = null;
  native.signal = null;
  // The view mode persists per session (store/viewmode.ts), and these tests
  // switch views, so a name reused across files would inherit the deviation.
  localStorage.clear();
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

/* ------------------------------------------------------------------ *
 * What attention.ts needs, on the native branch
 * ------------------------------------------------------------------ */

describe("the attention props <SessionView> gives a native terminal", () => {
  /**
   * `ownsBridges` cannot stand in for this one. It is `onScreen()` alone, so it
   * stays TRUE while the text view shows over a terminal that is still mounted
   * and still attached. That period is precisely the one attention.ts exists to
   * report, since output arriving then is what dots the [Terminal] segment.
   */
  it("hands over `active`, and takes it away when the text view shows", () => {
    at("?native=1");
    const { container } = render(() => <SessionView session="qa-native-active" />);
    expect(native.active?.(), "the terminal is the default view").toBe(true);

    fireEvent.click(segments(container)[0]!); // [Text]
    expect(mode(container)).toBe("text");
    expect(native.active?.(), "the text view is over the terminal now").toBe(false);

    fireEvent.click(segments(container)[1]!); // [Terminal]
    expect(native.active?.()).toBe(true);
  });

  /**
   * The other half of the same flag, and the reason it is not just the view
   * mode: the lobby keeps every visited session mounted and CSS-hides the ones
   * behind the one you are looking at (store/keepalive.ts).
   */
  it("hands over `active` as false while this session's pane is hidden", () => {
    at("?native=1");
    render(() => <SessionView session="qa-native-behind" visible={false} />);
    expect(native.active?.()).toBe(false);
  });

  /**
   * One handler for both terminals. The iframe's `tl-attention` message and the
   * native module's `signal` action have to land in the same place, or the tab
   * badge and the [Terminal] dot speak for one terminal and not the other.
   */
  it("routes a native attention signal up, naming this session", () => {
    at("?native=1");
    const seen: [string, string | null][] = [];
    render(() => (
      <SessionView
        session="qa-native-bell"
        onFrameAttention={(kind, from) => void seen.push([kind, from])}
      />
    ));
    native.signal?.("bell");
    // The name is SessionView's to supply: the component is handed `args`, not
    // a session, and there is no document boundary to distrust here.
    expect(seen).toEqual([["bell", "qa-native-bell"]]);
  });

  /** The dot itself, driven from the native path rather than a postMessage. */
  it("dots the [Terminal] segment for native output behind the text view", () => {
    at("?native=1");
    const { container } = render(() => <SessionView session="qa-native-dot" />);
    fireEvent.click(segments(container)[0]!); // [Text]
    expect(dots(container)).toEqual([false, false]);

    native.signal?.("output");
    // [Text (selected), Terminal (hidden, and something happened in it)]
    expect(dots(container)).toEqual([false, true]);
  });
});
