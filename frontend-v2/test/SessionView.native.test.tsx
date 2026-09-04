/**
 * WHICH TERMINAL a tab gets, and what the shell hands the one it mounted.
 *
 * THE FLIP (2026-09-04) lives here: a bare URL now mounts the terminal the app
 * renders itself, and `term.html` in an iframe is what the URL flag or this
 * device's setting selects instead. Three answers in a fixed order: the flag,
 * then the setting, then native. That order is the design, so it is tested as a
 * table rather than as a handful of cases.
 *
 * The setting is not a convenience. `manifest.webmanifest` sets
 * `"start_url": "/"`, so an app launched from a home-screen icon opens with no
 * query string and no flag can reach it; on an installed PWA the stored choice
 * is the only way back to the iframe.
 *
 * Four things are checked here, all of them SessionView's own wiring rather
 * than either terminal's behaviour:
 *
 *   - the `?native` read. Presence was the whole test until pass 1, so
 *     `?native=0` turned native ON, which makes the flag useless as the way
 *     back to the iframe now that native is the default (the de-iframe plan's
 *     "a URL override that works in both directions").
 *   - the precedence, and that the component really consults both sources. A
 *     pure function that orders them correctly is half the claim; the other
 *     half is which component ends up in the DOM.
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
  /** The attach args it was handed, read the way a prop getter is read. */
  args: null as null | (() => string | undefined),
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
    args?: string;
    active?: boolean;
    onAttention?: (kind: "bell" | "output") => void;
    onReady?: (control: { reconnect: () => void; ask: () => void }) => void;
  }) => {
    native.mounted++;
    native.active = () => props.active;
    native.args = () => props.args;
    native.signal = (kind) => props.onAttention?.(kind);
    props.onReady?.({
      reconnect: () => void native.retries++,
      ask: () => void native.asks++,
    });
    return <div class="tl-terminal-native" />;
  },
}));

import {
  SessionView,
  nativeFromSearch,
  wantsNativeTerminal,
} from "../src/components/SessionView";
import {
  TERMINAL_RENDERER_KEY,
  setTerminalRenderer,
  type TerminalRenderer,
} from "../src/store/device-prefs";
import { WATCH_KEY_PREFIX } from "../src/store/watchmode";

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
  native.args = null;
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
   * "the URL did not say", which is what hands the question on to the device
   * setting and then to the default.
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
 * The precedence: the URL, then the device, then the default
 * ------------------------------------------------------------------ */

describe("the order the two answers are asked in", () => {
  /**
   * Every combination that exists: the flag absent / 0 / 1, crossed with the
   * device setting unset / iframe / native.
   *
   * Three of the nine rows carry the whole design. `("", "iframe")` is the
   * installed PWA's only route back, since a home-screen launch has no query
   * to put a flag in. `("?native=1", "iframe")` is one tab overriding that
   * device without disturbing it, and `("?native=0", "native")` is the same
   * trick in the other direction, which is what makes the flag a way to TRY
   * the other terminal rather than a way to switch to it.
   */
  it.each([
    ["", null, true],
    ["", "iframe", false],
    ["", "native", true],
    ["?native=0", null, false],
    ["?native=0", "iframe", false],
    ["?native=0", "native", false],
    ["?native=1", null, true],
    ["?native=1", "iframe", true],
    ["?native=1", "native", true],
  ] as [string, TerminalRenderer | null, boolean][])(
    "%j with the device set to %o wants native: %o",
    (search, stored, want) => {
      expect(wantsNativeTerminal(search, stored)).toBe(want);
    },
  );

  /** A typo is not a vote, so the setting under it still gets its say. */
  it("hands an unrecognised flag on to the device rather than eating it", () => {
    expect(wantsNativeTerminal("?native=banana", "iframe")).toBe(false);
    expect(wantsNativeTerminal("?native=banana", null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * What that selects, in the DOM
 * ------------------------------------------------------------------ */

describe("which terminal <SessionView> mounts", () => {
  const iframe = (root: HTMLElement): Element | null =>
    root.querySelector("iframe.tl-ttyd");
  const host = (root: HTMLElement): Element | null =>
    root.querySelector(".tl-terminal-native");

  /**
   * The same nine rows again, through the component this time. The pure
   * function above proves the ORDER; this proves SessionView asks both
   * sources at all. A component reading only `location` would pass the table
   * above and still leave an installed PWA with no way out.
   */
  it.each([
    ["", null, "native"],
    ["", "iframe", "iframe"],
    ["", "native", "native"],
    ["?native=0", null, "iframe"],
    ["?native=0", "iframe", "iframe"],
    ["?native=0", "native", "iframe"],
    ["?native=1", null, "native"],
    ["?native=1", "iframe", "native"],
    ["?native=1", "native", "native"],
  ] as [string, TerminalRenderer | null, "native" | "iframe"][])(
    "%j with the device on %o mounts the %s terminal",
    (search, stored, want) => {
      at(search);
      if (stored) setTerminalRenderer(stored);
      // A fresh name per row: the view mode is remembered per session
      // (store/viewmode.ts), so a reused one would carry the last row's state.
      const session = `qa-prec-${search.replace(/\W/g, "") || "bare"}-${stored ?? "unset"}`;
      const { container } = render(() => <SessionView session={session} />);
      if (want === "native") {
        expect(host(container)).toBeTruthy();
        expect(iframe(container)).toBeNull();
      } else {
        expect(iframe(container)).toBeTruthy();
        expect(host(container)).toBeNull();
        expect(native.mounted, "the native terminal must not even mount").toBe(0);
      }
    },
  );

  /** The default, stated on its own because it is the flip. */
  it("mounts the app's own terminal when nothing says otherwise", () => {
    const { container } = render(() => <SessionView session="qa-native-default" />);
    expect(host(container)).toBeTruthy();
    expect(iframe(container)).toBeNull();
  });

  /**
   * `?native=0` was the bug pass 1 fixed: `.has("native")` read it as a
   * request FOR native, so the one URL a person would try did the opposite.
   * It matters more now that it is the way back rather than the way in.
   */
  it("mounts the iframe for ?native=0", () => {
    at("?native=0");
    const { container } = render(() => <SessionView session="qa-native-0" />);
    expect(iframe(container)).toBeTruthy();
    expect(host(container)).toBeNull();
    expect(native.mounted).toBe(0);
  });

  /** An unrecognised value is not a vote, so the default stands. */
  it("mounts the app's own terminal for a value it does not understand", () => {
    at("?native=maybe");
    const { container } = render(() => <SessionView session="qa-native-junk" />);
    expect(host(container)).toBeTruthy();
    expect(iframe(container)).toBeNull();
  });

  /**
   * The setting is stored where the settings panel writes it, not somewhere
   * only this test knows about. A key name that drifted would leave the panel
   * writing a preference nothing reads, which is the failure mode the flip
   * cannot afford, since that control is the way back on an installed app.
   */
  it("reads the same key the settings control writes", () => {
    setTerminalRenderer("iframe");
    expect(localStorage.getItem(TERMINAL_RENDERER_KEY)).toBe("iframe");
    const { container } = render(() => <SessionView session="qa-native-key" />);
    expect(iframe(container)).toBeTruthy();
  });

  /**
   * READ ONCE. The setting changing under a mounted session must not swap the
   * terminal, because that would tear down a pty somebody is typing at. So it
   * applies to the next session opened, which is what the control's own note
   * tells the reader.
   */
  it("keeps the terminal it mounted when the setting changes under it", () => {
    const { container } = render(() => <SessionView session="qa-native-live" />);
    expect(host(container)).toBeTruthy();

    setTerminalRenderer("iframe");
    // No re-render is triggered, and none is wanted: nothing here is reactive.
    expect(host(container), "still the terminal this session booted with").toBeTruthy();
    expect(iframe(container)).toBeNull();

    // A session opened AFTER the change gets the other one, which is the whole
    // of what "takes effect next time" means.
    const next = render(() => <SessionView session="qa-native-live-2" />);
    expect(next.container.querySelector("iframe.tl-ttyd")).toBeTruthy();
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
    at("?native=0");
    const probe = statusProbe();
    render(() => <SessionView session="qa-native-iframe" status={probe.props} />);
    expect(() => probe.held.ask()).not.toThrow();
    expect(native.asks).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The attach args, on the branch a person now gets
 * ------------------------------------------------------------------ */

/**
 * Watch mode has to survive the flip.
 *
 * `arg5` is red-line-class: a client that asked to watch and attached
 * read-WRITE takes the grid from whoever is driving, which is the failure the
 * whole feature exists to prevent. SessionView.watch.test.tsx catches the same
 * chain at the iframe's URL builder; this catches it in the prop the app's own
 * terminal is handed, because that is the branch a bare URL now takes.
 */
describe("the attach args <SessionView> gives a native terminal", () => {
  it("carries the watch request into the args", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "qa-native-ro", "ro");
    render(() => <SessionView session="qa-native-ro" />);
    // arg5, the deepest positional slot (lib/terminal-url.ts).
    expect(native.args?.()).toContain("arg=ro");
    expect(native.args?.()).toContain("arg=qa-native-ro");
  });

  it("asks for no such thing when the session is not watched", () => {
    render(() => <SessionView session="qa-native-rw" />);
    expect(native.args?.()).toContain("arg=qa-native-rw");
    expect(native.args?.()).not.toContain("arg=ro");
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
