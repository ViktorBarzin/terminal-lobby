/**
 * The preload's own attach, and what a click does to it.
 *
 * A preloaded session is mounted by the shell like any other kept session, with
 * two differences and no others: its ttyd args carry `pre` at position 5, and it
 * holds back the transcript stream a remembered Text view would otherwise open
 * (ADR-0026 — a preload costs one socket, one tmux client and one xterm buffer,
 * and nothing on the server beyond the attach).
 *
 * PROMOTION IS THE ABSENCE OF WORK. Clicking the card reveals this same mount:
 * no second attach, and no second grid call either — `claimGrid` already fires
 * on the `shown` that reveals a terminal (TerminalNative's safeFit, the arm at
 * its `if (type === "shown") claimGrid()`), and `POST /sessions/{name}/grid` is
 * what clears the client's ignore-size flag server-side (tmux-api/grid_size.go).
 * So the assertions here are mostly about what does NOT happen.
 *
 * The terminal is stubbed: a real xterm needs `matchMedia`, which jsdom does not
 * ship, and what is under test is the wiring around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { batch, createSignal } from "solid-js";
import type { TerminalReport } from "../src/diagnostics/status";

/** The props the last (and only) mounted terminal was handed. */
interface TerminalProps {
  args?: string;
  onGrid?: (cols: number, rows: number) => void;
  onConn?: (report: TerminalReport) => void;
}
const terminals: TerminalProps[] = [];

vi.mock("../src/components/TerminalNative", () => ({
  // `props.args` is READ into the DOM on purpose: Solid compiles the call site
  // into a getter, so a stub that ignores it never builds the args at all.
  TerminalNative: (props: TerminalProps) => {
    terminals.push(props);
    return <div class="tl-terminal-native" data-tl-args={props.args} />;
  },
}));

vi.mock("../src/lib/lobby-api", async (orig) => {
  const real = await orig<typeof import("../src/lib/lobby-api")>();
  return { ...real, setSessionGrid: vi.fn(async () => {}) };
});

import { SessionView } from "../src/components/SessionView";
import { setSessionGrid } from "../src/lib/lobby-api";
import { resolvedWatchFor } from "../src/store/watchmode";

/** Every EventSource the transcript store opened. */
const streams: string[] = [];

class CountingEventSource {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    streams.push(url);
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void): void {
    if (type === "ready") fn({ data: "0" });
  }
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  terminals.length = 0;
  streams.length = 0;
  localStorage.clear();
  vi.mocked(setSessionGrid).mockClear();
  vi.stubGlobal("EventSource", CountingEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("[]"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  delete (window as { __tlFocusTerminal?: unknown }).__tlFocusTerminal;
});

const argsOf = (c: HTMLElement): string =>
  c.querySelector(".tl-terminal-native")?.getAttribute("data-tl-args") ?? "";

describe("<SessionView> — a preloading mount", () => {
  it("attaches with the preload mode at arg5", () => {
    const { container } = render(() => (
      <SessionView session="main" preloading={() => true} visible={false} />
    ));
    // Position 5 is the attach mode, and the empty arg4 in front of it is the
    // owner slot: tmux-attach.sh reads a blank owner as "mine".
    expect(argsOf(container)).toBe("arg=main&arg=default&arg=default&arg=&arg=pre");
  });

  it("leaves an ordinary attach exactly as it was", () => {
    const { container } = render(() => <SessionView session="main" />);
    expect(argsOf(container)).toBe("arg=main");
  });

  // A watch attaches read-only, which calls PinGrid, and tmux-api/grid.go never
  // reverts a pin: one hover would fix the session's window size for life. So a
  // preload whose join comes out read-only attaches NOTHING, and gives the slot
  // back. The card declines this case at the gate; this is what catches the
  // 250 ms in between, where the lobby poll can land `driven: true` mid-dwell.
  it("attaches nothing at all when its join resolves to a watch", () => {
    localStorage.setItem("tl:watch:v1:main", "ro");
    const states: string[] = [];
    const { container } = render(() => (
      <SessionView
        session="main"
        preloading={() => true}
        visible={false}
        onPreload={(s) => states.push(s)}
      />
    ));

    expect(terminals).toEqual([]);
    expect(container.querySelector(".tl-terminal-native")).toBeNull();
    // `failed` is the store's word for "this attach will not happen"; it drops
    // the slot instead of holding a dead mount for the 60 s TTL.
    expect(states).toEqual(["failed"]);
  });

  // The click still works — it is simply the open it would have been with no
  // hover at all, one mount later and read-only.
  it("opens read-only when a click follows an abandoned preload", () => {
    localStorage.setItem("tl:watch:v1:main", "ro");
    const [pre, setPre] = createSignal(true);
    const { container } = render(() => (
      <SessionView session="main" preloading={pre} visible={!pre()} />
    ));
    expect(terminals).toEqual([]);

    setPre(false);

    expect(argsOf(container)).toContain("arg=ro");
    expect(argsOf(container)).not.toContain("arg=pre");
  });

  // The sidebar prefers a live view's resolved decision over its own answer
  // (store/watchmode.ts `resolvedWatchFor`), because `driven` counts our own
  // client. A hidden speculative mount publishing into that map froze the
  // hovered card's eye marker on whatever was true 250 ms after the pointer
  // arrived — and the card then claimed it would drive a session it would not.
  it("tells the sidebar nothing while it is only a preload", () => {
    const [pre, setPre] = createSignal(true);
    render(() => <SessionView session="main" preloading={pre} visible={!pre()} />);
    expect(resolvedWatchFor("main")).toBeUndefined();

    setPre(false);

    expect(resolvedWatchFor("main")).toBe(false);
  });

  // THE REGRESSION THIS EXISTS TO STOP. Promotion used to re-take the join
  // decision, so it read `driven` at click time instead of at dwell time.
  // `driven` is true for any session holding an attached client, and the lobby
  // keeps every session you visit mounted for a day, so once the lobby has been
  // open a while that is most of them. Clicking a preloaded card therefore
  // resolved to WATCH as a matter of course, and sessions drifted into watch
  // mode on their own (Viktor, 2026-09-12: "i want sessions to not switch modes
  // when inactive"). store/watchmode.ts's header says why this reading must be
  // sampled once and never tracked; an earlier version of the same mistake cost
  // a revert.
  it("does not change its mode when something else attaches before the click", () => {
    const [pre, setPre] = createSignal(true);
    const [vis, setVis] = createSignal(false);
    const [driven, setDriven] = createSignal(false);
    render(() => <SessionView session="main" preloading={pre} visible={vis()} driven={driven} />);
    expect(terminals).toHaveLength(1);

    // Something attaches while the slot sits there — another tab, the phone, or
    // simply this session having been visited before and still being kept.
    setDriven(true);
    setPre(false);
    setVis(true);

    // The decision was taken at dwell time, when nothing was driving, and a
    // click is not a reason to re-take it.
    expect(resolvedWatchFor("main")).toBe(false);
    // ...and the promotion still costs no second attach.
    expect(terminals).toHaveLength(1);
  });

  // The other direction, so this is pinned from both sides: a session that WAS
  // already driven when the pointer arrived stays a watch, and the click does
  // not quietly promote it to driving either.
  it("keeps a watch decision taken at dwell time", () => {
    const [pre, setPre] = createSignal(true);
    const [vis, setVis] = createSignal(false);
    const [driven, setDriven] = createSignal(true);
    render(() => <SessionView session="main" preloading={pre} visible={vis()} driven={driven} />);

    setDriven(false);
    setPre(false);
    setVis(true);

    expect(resolvedWatchFor("main")).toBe(true);
  });

  // A hidden view WITHDRAWS its terminal from the shared model, which is right
  // for a session leaving the screen and wrong for one nobody asked for: the
  // amber badge over a dropped socket cleared, the Reconnect button beside it
  // went, and an in-flight `Run check` answered "not reporting" — all from a
  // pointer resting on an unrelated card.
  it("says nothing about the terminal channel while it is a preload", () => {
    const reports: (TerminalReport | null)[] = [];
    const [pre, setPre] = createSignal(true);
    const [vis, setVis] = createSignal(false);
    render(() => (
      <SessionView
        session="main"
        preloading={pre}
        visible={vis()}
        status={{
          channels: () => [],
          onOpen: () => {},
          onTranscript: () => {},
          onTerminalConn: (r) => void reports.push(r),
          askConn: () => {},
          retryConn: () => {},
        }}
      />
    ));

    expect(reports).toEqual([]);

    // Promoted and on screen, it speaks again like any other view: the effect
    // re-runs, so a terminal that was already open is asked to re-report.
    // One batch, the way App promotes: `preloading` and `visible` come from
    // two signals it writes together, and a view that went off-screen in
    // between would withdraw its terminal on the way past.
    batch(() => {
      setPre(false);
      setVis(true);
    });
    terminals[0]?.onConn?.({ state: "open", attempt: 0 });

    expect(reports).toEqual([{ state: "open", attempt: 0 }]);
  });

  it("opens no transcript stream, even for a session left in Text mode", () => {
    localStorage.setItem("tl:viewmode:v1:main", "text");
    render(() => <SessionView session="main" preloading={() => true} visible={false} />);
    expect(streams).toEqual([]);
  });

  it("opens that stream once the click promotes it", () => {
    localStorage.setItem("tl:viewmode:v1:main", "text");
    const [pre, setPre] = createSignal(true);
    render(() => <SessionView session="main" preloading={pre} visible={!pre()} />);
    expect(streams).toEqual([]);

    setPre(false);

    expect(streams).toHaveLength(1);
    expect(streams[0]).toContain("main");
  });

  it("does not claim the grid while it is only a preload", () => {
    render(() => <SessionView session="main" preloading={() => true} visible={false} />);
    terminals[0]?.onGrid?.(200, 50);
    expect(setSessionGrid).not.toHaveBeenCalled();
  });

  // SEAM THREE, and the reason it needs no new client call: revealing the
  // terminal fires `shown` -> claimGrid -> POST /sessions/{name}/grid, which is
  // where the server clears the preload client's ignore-size flag.
  it("claims the grid on the reveal, which is what promotes the tmux client", () => {
    const [pre, setPre] = createSignal(true);
    const [vis, setVis] = createSignal(false);
    render(() => <SessionView session="main" preloading={pre} visible={vis()} />);

    setPre(false);
    setVis(true);
    terminals[0]?.onGrid?.(200, 50);

    expect(setSessionGrid).toHaveBeenCalledTimes(1);
    expect(setSessionGrid).toHaveBeenCalledWith("main", 200, 50);
  });

  it("keeps the same terminal across the promotion, and stops calling itself a preload", () => {
    const [pre, setPre] = createSignal(true);
    const [vis, setVis] = createSignal(false);
    const { container } = render(() => (
      <SessionView session="main" preloading={pre} visible={vis()} />
    ));
    const node = container.querySelector(".tl-terminal-native");
    expect(argsOf(container)).toContain("arg=pre");

    setPre(false);
    setVis(true);

    expect(terminals).toHaveLength(1); // never mounted a second time
    expect(container.querySelector(".tl-terminal-native")).toBe(node);
    // The socket in flight keeps the args it was opened with — nothing here
    // reconnects it, and the grid call is what promotes its tmux client. What
    // changes is the NEXT connect, which the battery saver makes routine: a
    // session parked off screen for 30 s used to come back as a preload client,
    // and tmux never sizes a window to one of those. The window then kept
    // whatever the last device to attach had left it at.
    expect(argsOf(container)).toBe("arg=main");
  });

  it("reports the attach landing and failing", () => {
    const states: string[] = [];
    render(() => (
      <SessionView
        session="main"
        preloading={() => true}
        visible={false}
        onPreload={(s) => states.push(s)}
      />
    ));

    terminals[0]?.onConn?.({ state: "connecting", attempt: 1 });
    expect(states).toEqual([]);

    terminals[0]?.onConn?.({ state: "open", attempt: 0 });
    terminals[0]?.onConn?.({ state: "closed", attempt: 0 });
    expect(states).toEqual(["landed", "failed"]);
  });

  it("says nothing about a preload from an ordinary mount", () => {
    const states: string[] = [];
    render(() => <SessionView session="main" onPreload={(s) => states.push(s)} />);
    terminals[0]?.onConn?.({ state: "open", attempt: 0 });
    expect(states).toEqual([]);
  });

  // A preload boots inside `display: none`, so TerminalNative's boot focus —
  // gated on the boot fit finding a box — does not run. Without this, clicking
  // a preloaded card would leave a terminal nobody can type into, where an
  // ordinary first open focuses itself.
  it("takes the keyboard when the click reveals it", async () => {
    const focus = vi.fn(() => true);
    (window as { __tlFocusTerminal?: () => boolean }).__tlFocusTerminal = focus;
    const [pre, setPre] = createSignal(true);
    const [vis, setVis] = createSignal(false);
    render(() => <SessionView session="main" preloading={pre} visible={vis()} />);
    expect(focus).not.toHaveBeenCalled();

    setPre(false);
    setVis(true);
    await Promise.resolve();

    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not take the keyboard while it is still hidden", async () => {
    const focus = vi.fn(() => true);
    (window as { __tlFocusTerminal?: () => boolean }).__tlFocusTerminal = focus;
    render(() => <SessionView session="main" preloading={() => true} visible={false} />);
    await Promise.resolve();
    expect(focus).not.toHaveBeenCalled();
  });
});
