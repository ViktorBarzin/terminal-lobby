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
import { createSignal } from "solid-js";
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
  /** Fire a grid claim, standing in for a landed fit, a focus or a keystroke.
   *  The reason defaults to "fit", the highest-volume one, so a case only
   *  names it when the reason is what it is about. */
  claim: null as null | ((cols: number, rows: number, reason?: GridClaimReason) => void),
  /**
   * Was the terminal handed a SIZE TO DRAW AT, as opposed to fitting its host?
   * The prop is read by presence rather than by value, because the answer must
   * be that no such prop reaches the component at all.
   */
  toldASize: false,
  /** FALSE stands in for the window before the real component's two dynamic
   *  imports resolve, when it has handed no lever back yet. */
  readyOnMount: true,
}));

vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: (props: {
    args?: string;
    active?: boolean;
    onAttention?: (kind: "bell" | "output") => void;
    onGrid?: (cols: number, rows: number, reason: GridClaimReason) => void;
    onReady?: (control: {
      reconnect: () => void;
      ask: () => void;
      copy: () => void;
    }) => void;
  }) => {
    native.mounted++;
    native.toldASize = "grid" in props;
    native.active = () => props.active;
    native.args = () => props.args;
    native.signal = (kind) => props.onAttention?.(kind);
    native.claim = (cols, rows, reason) => props.onGrid?.(cols, rows, reason ?? "fit");
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

/**
 * Every grid claim that reached the wire, as "SESSION COLSxROWS".
 *
 * Only this one export is replaced: SessionView's neighbours import the same
 * module, and a whole-module mock would take the session list and the layout
 * with it.
 */
const grids = vi.hoisted(() => [] as string[]);
/** The whole POST body of every claim, for the cases that are about the two
 *  fields the size does not carry: which client asked, and what made it ask. */
const claims = vi.hoisted(
  () => [] as { name: string; cols: number; rows: number; reason: string; client: string }[],
);
vi.mock("../src/lib/lobby-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/lobby-api")>()),
  setSessionGrid: async (
    name: string,
    cols: number,
    rows: number,
    reason: string,
    client: string,
  ) => {
    grids.push(`${name} ${cols}x${rows}`);
    claims.push({ name, cols, rows, reason, client });
  },
}));

import { SessionView } from "../src/components/SessionView";
import { WATCH_KEY_PREFIX } from "../src/store/watchmode";
import type { GridClaimReason } from "../src/terminal/claim";
import { CLIENT_ID_RE } from "../src/lib/client-id";

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
  native.claim = null;
  native.toldASize = false;
  native.readyOnMount = true;
  grids.length = 0;
  claims.length = 0;
  vi.useRealTimers();
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
      ?.querySelector<HTMLButtonElement>('button[aria-label="Copy the visible screen"]');
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
      ?.querySelector<HTMLButtonElement>('button[aria-label="Copy the visible screen"]');
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
 * Claiming the grid
 * ------------------------------------------------------------------ */

/**
 * The terminal says what size it is; this view decides whether that becomes
 * "size this session's tmux window to me".
 *
 * Both refusals below have to live here. The terminal is handed `args`, not a
 * session, so it cannot name the session; and the SERVER cannot make either
 * call — two devices of one person arrive with one identity header, and no HTTP
 * request carries the tmux client it belongs to. So Watch mode's promise, that a
 * phone opening a session never reflows the desktop driving it, is kept by the
 * phone declining to speak.
 */
describe("the grid claim <SessionView> makes for the terminal", () => {
  it("claims the grid for the session it is showing", () => {
    render(() => <SessionView session="qa-grid-own" />);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-own 231x62"]);
  });

  /** arg5's other half. A read-only client taking the size is the whole of what
   *  the pin refuses, and this is the only place that can refuse it. */
  it("claims nothing while watching", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "qa-grid-watch", "ro");
    render(() => <SessionView session="qa-grid-watch" />);
    native.claim?.(390, 40);
    expect(grids).toEqual([]);
  });

  /** The endpoint acts on the caller's own OS user, so a foreign attach could
   *  only ever 404 against a name that account does not have. */
  it("claims nothing on somebody else's session", () => {
    render(() => <SessionView session="qa-grid-shared" owner="emo" me={() => "wizard"} />);
    native.claim?.(231, 62);
    expect(grids).toEqual([]);
  });

  /** Your own session reached through the owner arg is still yours. */
  it("claims a session of your own that names its owner", () => {
    render(() => <SessionView session="qa-grid-mine" owner="wizard" me={() => "wizard"} />);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-mine 231x62"]);
  });

  /**
   * The claim is idempotent and cheap, but the terminal fires one on every
   * landed fit and every focus. A drag-resize or a click-happy minute would
   * otherwise be a request each.
   */
  it("says the same grid once, and a changed one straight away", () => {
    vi.useFakeTimers();
    render(() => <SessionView session="qa-grid-quiet" />);
    native.claim?.(231, 62);
    native.claim?.(231, 62);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-quiet 231x62"]);

    native.claim?.(120, 40); // a real resize is news whenever it happens
    expect(grids).toEqual(["qa-grid-quiet 231x62", "qa-grid-quiet 120x40"]);

    vi.advanceTimersByTime(2000); // and the quiet period expires
    native.claim?.(120, 40);
    expect(grids).toEqual([
      "qa-grid-quiet 231x62",
      "qa-grid-quiet 120x40",
      "qa-grid-quiet 120x40",
    ]);
  });

  /* ---------------------------------------------------------------- *
   * The fourth refusal: the window is already this size
   * ---------------------------------------------------------------- */

  /**
   * LAST ACTIVE WINS MAKES THE CLAIM CHEAP AND CONSTANT, so the one worth not
   * making is the one for a window that already matches. Under the old rule a
   * claim was rare — a fit, a focus, a view switch — and the quiet window
   * above was enough. Now a keystroke and a pointer move claim too, so the
   * steady state of somebody working in a terminal they already own would be
   * a POST every 1500 ms forever, each one an idempotent `switch-client` to
   * the size the window has.
   *
   * The size it compares against is the POLLED one (`props.grid`, from the
   * session list), which is why the quiet window stays: the poll is a 5 s
   * interval, so for up to one poll after this device's own claim it is still
   * reporting the old size and the skip cannot fire.
   */
  it("says nothing when the session's window is already this size", () => {
    render(() => <SessionView session="qa-grid-match" grid={() => ({ cols: 231, rows: 62 })} />);
    native.claim?.(231, 62);
    expect(grids).toEqual([]);
  });

  it("says it when the window is a different size", () => {
    render(() => <SessionView session="qa-grid-differ" grid={() => ({ cols: 80, rows: 24 })} />);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-differ 231x62"]);
  });

  it("says it when one dimension matches and the other does not", () => {
    render(() => <SessionView session="qa-grid-half" grid={() => ({ cols: 231, rows: 24 })} />);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-half 231x62"]);
  });

  /** A window nobody could measure is not a window that matches. The server
   *  leaves `cols`/`rows` off a session it could not read, and skipping on
   *  that would be a device declining to take a window it has no idea about. */
  it("says it when nobody can say what size the window is", () => {
    render(() => <SessionView session="qa-grid-unknown" grid={() => null} />);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-unknown 231x62"]);
  });

  /** The same, for a view mounted with no grid accessor at all — every
   *  non-workspace caller. */
  it("says it when no grid accessor was passed", () => {
    render(() => <SessionView session="qa-grid-noprop" />);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-noprop 231x62"]);
  });

  /**
   * THE SKIP HOLDS ONCE THE POLL HAS CAUGHT UP, which is the steady state of
   * somebody working in a terminal they already own. The quiet window is out
   * of the way here on purpose: two seconds have gone by, so the only thing
   * left that can refuse this claim is the window already being the size.
   */
  it("goes on saying nothing once the window has settled at this size", () => {
    vi.useFakeTimers();
    const [grid, setGrid] = createSignal<{ cols: number; rows: number } | null>(null);
    render(() => <SessionView session="qa-grid-settled" grid={grid} />);

    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-settled 231x62"]);

    setGrid({ cols: 231, rows: 62 }); // the poll catches up with our own claim
    vi.advanceTimersByTime(2000); // and the quiet window is long over
    native.claim?.(231, 62);
    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-settled 231x62"]);
  });

  /**
   * ANOTHER DEVICE TAKING THE WINDOW RE-ARMS THIS ONE, which is decision 5 of
   * the pane-ownership design: the loser is not demoted and gets no banner, it
   * takes the window back the moment you touch it.
   *
   * The touch here lands 100 ms after this device's own claim, well inside the
   * 1500 ms quiet window — and the size it wants is the size it last claimed,
   * so without forgetting that claim the quiet window would swallow it. The
   * person would press a key, watch nothing move, and press it again.
   */
  it("takes the window straight back after another device moved it", () => {
    vi.useFakeTimers();
    const [grid, setGrid] = createSignal<{ cols: number; rows: number } | null>(null);
    render(() => <SessionView session="qa-grid-lost" grid={grid} />);

    native.claim?.(231, 62);
    expect(grids).toEqual(["qa-grid-lost 231x62"]);

    // A phone joins and takes it.
    setGrid({ cols: 60, rows: 20 });
    vi.advanceTimersByTime(100);
    native.claim?.(231, 62, "input");

    expect(grids).toEqual(["qa-grid-lost 231x62", "qa-grid-lost 231x62"]);
    expect(claims[1]?.reason).toBe("input");
  });

  /** ...and the poll merely catching up with this device's OWN claim is not a
   *  loss. Clearing on that would undo the dedupe for everybody. */
  it("does not re-arm when the poll reports the size this device claimed", () => {
    vi.useFakeTimers();
    const [grid, setGrid] = createSignal<{ cols: number; rows: number } | null>(null);
    render(() => <SessionView session="qa-grid-echo" grid={grid} />);

    native.claim?.(120, 40);
    setGrid({ cols: 120, rows: 40 });
    vi.advanceTimersByTime(100);
    native.claim?.(120, 40);

    expect(grids).toEqual(["qa-grid-echo 120x40"]);
  });

  /* ---------------------------------------------------------------- *
   * What the claim carries besides the size
   * ---------------------------------------------------------------- */

  /** The reason is what tmux-api records on `session.grid_claimed`, so it is
   *  the difference between knowing the window moves and knowing why. */
  it("passes the terminal's reason through to the wire", () => {
    render(() => <SessionView session="qa-grid-reason" />);
    native.claim?.(231, 62, "input");
    native.claim?.(120, 40, "focus");
    expect(claims.map((c) => c.reason)).toEqual(["input", "focus"]);
  });

  /** Its own reason, because nothing in the terminal caused it: the tiles
   *  around this one moved and every visible tile says its size again. */
  it("calls the visible-set re-claim what it is", () => {
    vi.useFakeTimers();
    const [stamp, setStamp] = createSignal("a");
    render(() => <SessionView session="qa-grid-vs" visible visibleSet={stamp} />);
    native.claim?.(60, 40, "fit");
    vi.advanceTimersByTime(2000);
    setStamp("b");
    vi.advanceTimersByTime(250);
    expect(claims.map((c) => c.reason)).toEqual(["fit", "visible-set"]);
  });

  /**
   * WHICH TMUX CLIENT IS ASKING, and the round trip that is the only cheap
   * guard on it. The id is minted here and consumed by a shell script the
   * browser never sees, so if arg8 ever shifts position the record lands under
   * the wrong key, tmux-api resolves nothing, and the fallback hides it —
   * claims go on working through the preload-promotion path and nothing says
   * per-client resolution has stopped. Holding the id in the args equal to the
   * id in the POST catches the browser half of that.
   */
  it("claims under the same client id it attached with", () => {
    render(() => <SessionView session="qa-grid-client" />);
    native.claim?.(231, 62);
    const sent = claims[0]?.client ?? "";
    expect(sent).toMatch(CLIENT_ID_RE);
    expect(new URLSearchParams(native.args?.() ?? "").getAll("arg")[7]).toBe(sent);
  });

  /** One id per mount, held for its life: the attach script rewrites the
   *  record against the pty of every reconnect, so a second id would only
   *  orphan the first. */
  it("keeps one id across every claim it makes", () => {
    render(() => <SessionView session="qa-grid-oneid" />);
    native.claim?.(231, 62);
    native.claim?.(120, 40);
    expect(claims).toHaveLength(2);
    expect(claims[0]?.client).toBe(claims[1]?.client);
  });

  /** Two views are two ttyd connections and two tmux clients, so they must
   *  never claim under one name — which is the whole of per-tile ownership in
   *  a workspace. */
  it("gives two mounted views two different ids", () => {
    render(() => <SessionView session="qa-grid-id-a" />);
    const a = native.args?.() ?? "";
    native.claim?.(231, 62);
    render(() => <SessionView session="qa-grid-id-b" />);
    const b = native.args?.() ?? "";
    native.claim?.(231, 62);
    const idOf = (u: string): string => new URLSearchParams(u).getAll("arg")[7] ?? "";
    expect(idOf(a)).not.toBe("");
    expect(idOf(a)).not.toBe(idOf(b));
    expect(claims[0]?.client).toBe(idOf(a));
    expect(claims[1]?.client).toBe(idOf(b));
  });
});

/* ------------------------------------------------------------------ *
 * The size the terminal is NOT told
 * ------------------------------------------------------------------ */

/**
 * A TERMINAL FITS ITS OWN BOX, and the shell hands it nothing that could say
 * otherwise (decision 1 of the pane-ownership design, 2026-09-13).
 *
 * The view knows the session's window size — it polls it, and `claimGrid` needs
 * it to tell a redundant claim from a real one — so "the terminal decides its
 * own size" is a property of this handover rather than of the terminal alone.
 * Between 8e92832 and this change the size WAS handed down, and a watching tile
 * drew the session's window centred in its own dead space. Now tmux draws its
 * own presentation in the leftover, which is what the grilling asked for.
 */
describe("the size <SessionView> does not hand the terminal", () => {
  it("gives a driving terminal no size to draw at", () => {
    render(() => <SessionView session="qa-size-drive" grid={() => ({ cols: 231, rows: 62 })} />);
    expect(native.toldASize).toBe(false);
  });

  /** The case that letterboxed, and the only one that ever could. */
  it("gives a WATCHING terminal no size to draw at either", () => {
    localStorage.setItem(WATCH_KEY_PREFIX + "qa-size-watch", "ro");
    render(() => <SessionView session="qa-size-watch" grid={() => ({ cols: 50, rows: 14 })} />);
    expect(native.toldASize).toBe(false);
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
