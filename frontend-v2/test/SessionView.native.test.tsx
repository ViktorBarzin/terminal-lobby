/**
 * WHAT THE SHELL HANDS THE TERMINAL IT MOUNTS.
 *
 * There is one terminal, and this file is about the handover rather than
 * anything either side does with it. Three describes went from here on
 * 2026-09-05, with the escape hatch they tested: `nativeFromSearch`, the
 * nine-row precedence table over `?native` crossed with the stored device
 * setting, and the DOM half of that table. All three answered "which terminal
 * does this tab get", and a question with one answer is not a test.
 *
 * What is checked here, all of it SessionView's own wiring:
 *
 *   - the levers `onReady` hands back — the ADR-0016 connection ask and
 *     Reconnect, plus the soft-key row's Copy, which has no keyboard to press
 *     the copy chord with. What the terminal DOES when a lever is pulled is
 *     TerminalNative.wiring.test.tsx and terminal.attach.test.ts.
 *   - the attach args, and Watch mode surviving in them. arg5 is
 *     red-line-class: a client that asked to watch and attached read-WRITE
 *     takes the grid from whoever is driving.
 *   - `active` and `onAttention`, which terminal/attention.ts needs both of:
 *     its `view` event is the negation of `active`, and its `signal` action is
 *     the hand-up. A terminal handed neither cannot tell that nobody is
 *     looking, and has nowhere to say so. What the module DECIDES from them is
 *     terminal.attention.test.ts; these props are only how they reach it.
 *
 * `TerminalNative` is stubbed for exactly that reason: this file is about the
 * handover, and a real one would boot xterm, a socket and a ResizeObserver to
 * answer a question about neither.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import type { TerminalReport } from "../src/diagnostics/status";

/** The control object the stub hands up, and how often each lever was pulled. */
const native = vi.hoisted(() => ({
  asks: 0,
  retries: 0,
  copies: 0,
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
  /** FALSE stands in for the window before the real component's two dynamic
   *  imports resolve, when it has handed no lever back yet. */
  readyOnMount: true,
}));

vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: (props: {
    args?: string;
    active?: boolean;
    onAttention?: (kind: "bell" | "output") => void;
    onReady?: (control: {
      reconnect: () => void;
      ask: () => void;
      copy: () => void;
    }) => void;
  }) => {
    native.mounted++;
    native.active = () => props.active;
    native.args = () => props.args;
    native.signal = (kind) => props.onAttention?.(kind);
    if (native.readyOnMount) {
      props.onReady?.({
        reconnect: () => void native.retries++,
        ask: () => void native.asks++,
        copy: () => void native.copies++,
      });
    }
    return <div class="tl-terminal-native" />;
  },
}));

import { SessionView } from "../src/components/SessionView";
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
      onTerminalConn: (_r: TerminalReport | null) => {},
      askConn: (ask: () => void) => void (held.ask = ask),
      retryConn: (retry: () => void) => void (held.retry = retry),
    },
  };
}

/** The [Text | Terminal] switch, and its two activity dots, in that order. */
const segments = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"));

const dots = (root: HTMLElement): boolean[] =>
  segments(root).map((b) => !!b.querySelector(".tl-activity-dot"));

const mode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;

afterEach(() => {
  native.asks = 0;
  native.retries = 0;
  native.copies = 0;
  native.mounted = 0;
  native.active = null;
  native.args = null;
  native.signal = null;
  native.readyOnMount = true;
  // The view mode persists per session (store/viewmode.ts), and these tests
  // switch views, so a name reused across files would inherit the deviation.
  localStorage.clear();
});

/* ------------------------------------------------------------------ *
 * There is one terminal
 * ------------------------------------------------------------------ */

describe("the terminal <SessionView> mounts", () => {
  const host = (root: HTMLElement): Element | null =>
    root.querySelector(".tl-terminal-native");

  it("mounts the terminal the lobby draws itself", () => {
    const { container } = render(() => <SessionView session="qa-native-default" />);
    expect(host(container)).toBeTruthy();
    expect(native.mounted).toBe(1);
  });

  /**
   * There is no renderer switch left, so a URL cannot ask for another
   * terminal. `?native=0` was the escape hatch and it went with the page it
   * selected: a flag that silently does nothing is worse than no flag, so this
   * pins that it is now simply query text.
   */
  it.each(["?native=0", "?native=1", "?native=banana", "?terminal=/term2.html"])(
    "ignores %s — no flag selects a different terminal any more",
    (search) => {
      window.history.replaceState({}, "", "/" + search);
      const session = `qa-native-flag-${search.replace(/\W/g, "")}`;
      const { container } = render(() => <SessionView session={session} />);
      expect(host(container)).toBeTruthy();
      expect(container.querySelector("iframe")).toBeNull();
      window.history.replaceState({}, "", "/");
    },
  );

  /**
   * The stored key outlives the code that wrote it. Anyone who had picked
   * "Classic" on a device has `tl-terminal-renderer` in localStorage, and it
   * must not be read as anything: no branch, and no crash on a value whose
   * type no longer exists.
   */
  it("ignores a leftover tl-terminal-renderer from before the deletion", () => {
    localStorage.setItem("tl-terminal-renderer", "iframe");
    const { container } = render(() => <SessionView session="qa-native-leftover" />);
    expect(host(container)).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The levers onReady hands back
 * ------------------------------------------------------------------ */

describe("the connection levers <SessionView> gives the terminal", () => {
  it("routes the status model's ask to the terminal", () => {
    const probe = statusProbe();
    render(() => <SessionView session="qa-native-ask" status={probe.props} />);
    // The effect asks once on becoming visible, because a terminal that was
    // already open volunteers nothing on return.
    const onMount = native.asks;
    expect(onMount).toBeGreaterThan(0);
    probe.held.ask();
    expect(native.asks).toBe(onMount + 1);
  });

  it("routes Reconnect to the terminal", () => {
    const probe = statusProbe();
    render(() => <SessionView session="qa-native-retry" status={probe.props} />);
    probe.held.retry();
    expect(native.retries).toBe(1);
  });
});

/**
 * THE SOFT-KEY ROW'S Copy BUTTON.
 *
 * It was `window.__tlForwardToTerminal?.("terminal.copy")` until 2026-09-05,
 * a global that TerminalView installed and TerminalNative never did — so on a
 * phone with the native terminal the tap called `undefined?.()` and did
 * nothing, silently, because of the optional call. It is a typed lever now, so
 * a terminal that does not supply one is a compile error rather than a dead
 * button.
 */
describe("the Copy lever the soft keys use", () => {
  const realMatchMedia = window.matchMedia;
  /** A coarse-pointer phone, the only place the toolbar renders at all. */
  const stubPhone = (): void => {
    window.matchMedia = ((q: string) =>
      ({
        media: q,
        matches:
          q.includes("pointer: coarse") || /max-width:\s*(3|4|5|6|7)\d\dpx/.test(q),
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it("reaches the terminal when Copy is tapped", () => {
    stubPhone();
    const { container } = render(() => <SessionView session="qa-native-copy" />);
    // Text is the default view on a phone, and the row is the terminal view's.
    fireEvent.click(segments(container)[1]!); // [Terminal]
    const copy = document
      .getElementById("soft-keys")
      ?.querySelector<HTMLButtonElement>('button[aria-label="Copy"]');
    expect(copy, "the soft-key row's Copy button").toBeTruthy();
    fireEvent.click(copy!);
    expect(native.copies).toBe(1);
  });

  /**
   * The tap that lands before xterm has finished its two dynamic imports. It
   * must not throw: the lever is a local no-op until `onReady` replaces it,
   * which is the honest answer for "there is no terminal to copy from yet".
   */
  it("does nothing, quietly, before the terminal has handed its lever over", () => {
    stubPhone();
    native.readyOnMount = false;
    const { container } = render(() => <SessionView session="qa-native-copy-early" />);
    fireEvent.click(segments(container)[1]!); // [Terminal]
    const copy = document
      .getElementById("soft-keys")
      ?.querySelector<HTMLButtonElement>('button[aria-label="Copy"]');
    expect(copy).toBeTruthy();
    expect(() => fireEvent.click(copy!)).not.toThrow();
    expect(native.copies).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The attach args
 * ------------------------------------------------------------------ */

/**
 * Watch mode has to survive the deletion.
 *
 * `arg5` is red-line-class: a client that asked to watch and attached
 * read-WRITE takes the grid from whoever is driving, which is the failure the
 * whole feature exists to prevent.
 */
describe("the attach args <SessionView> gives the terminal", () => {
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
 * What attention.ts needs
 * ------------------------------------------------------------------ */

describe("the attention props <SessionView> gives the terminal", () => {
  /**
   * `ownsBridges` cannot stand in for this one. It is `onScreen()` alone, so it
   * stays TRUE while the text view shows over a terminal that is still mounted
   * and still attached. That period is precisely the one attention.ts exists to
   * report, since output arriving then is what dots the [Terminal] segment.
   */
  it("hands over `active`, and takes it away when the text view shows", () => {
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
    render(() => <SessionView session="qa-native-behind" visible={false} />);
    expect(native.active?.()).toBe(false);
  });

  it("routes an attention signal up, naming this session", () => {
    const seen: [string, string | null][] = [];
    render(() => (
      <SessionView
        session="qa-native-bell"
        onTerminalAttention={(kind, from) => void seen.push([kind, from])}
      />
    ));
    native.signal?.("bell");
    // The name is SessionView's to supply: the component is handed `args`, not
    // a session, and there is no document boundary to distrust here.
    expect(seen).toEqual([["bell", "qa-native-bell"]]);
  });

  it("dots the [Terminal] segment for output behind the text view", () => {
    const { container } = render(() => <SessionView session="qa-native-dot" />);
    fireEvent.click(segments(container)[0]!); // [Text]
    expect(dots(container)).toEqual([false, false]);

    native.signal?.("output");
    // [Text (selected), Terminal (hidden, and something happened in it)]
    expect(dots(container)).toEqual([false, true]);
  });
});
