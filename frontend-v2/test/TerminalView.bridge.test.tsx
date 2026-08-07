import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TerminalView } from "../src/components/TerminalView";
import { refocusTerminal } from "../src/keybindings/refocus";

/**
 * The SPA half of the frontend/term.html postMessage bridge.
 *
 * The v2 rewrite carried the THEME half over from the vanilla lobby and dropped
 * two others: nothing ever posted a prefs/font-size change into the frame (so
 * "Terminal font size" changed a readout and nothing else), and nothing could
 * ask the frame for the keyboard back (so every lobby overlay that closed left
 * the pty deaf). Both receivers already exist inside term.html — these tests
 * pin the senders, and check the message names against the shipped page so the
 * two ends cannot drift apart again.
 */

const TERM_HTML = resolve(__dirname, "../..", "frontend/term.html");
const termHtml = (): string => readFileSync(TERM_HTML, "utf8");

interface Posted {
  type?: string;
  [k: string]: unknown;
}

/**
 * Mount a TerminalView and capture everything it posts INTO the frame. jsdom
 * gives the iframe a real contentWindow; stubbing postMessage on it is the
 * cheapest faithful stand-in for term.html.
 */
function mountTerminal(active: boolean): {
  posted: Posted[];
  focused: () => number;
  unmount: () => void;
} {
  const posted: Posted[] = [];
  let focused = 0;
  const { container, unmount } = render(() => (
    <TerminalView session="qa-bridge" active={active} />
  ));
  const frame = container.querySelector<HTMLIFrameElement>("iframe.tl-ttyd");
  expect(frame, "the mounted terminal iframe").toBeTruthy();
  const win = frame?.contentWindow as unknown as {
    postMessage: (m: unknown) => void;
    focus: () => void;
  };
  win.postMessage = (m: unknown) => void posted.push(m as Posted);
  win.focus = () => void focused++;
  return { posted, focused: () => focused, unmount };
}

const typesOf = (posted: Posted[]): string[] =>
  posted.map((p) => p.type).filter((t): t is string => typeof t === "string");

describe("<TerminalView> — window.__tlFocusTerminal (hand the keyboard back)", () => {
  afterEach(() => {
    delete window.__tlFocusTerminal;
  });

  it("registers the hook while mounted and restores it on unmount", () => {
    expect(window.__tlFocusTerminal).toBeUndefined();
    const { unmount } = mountTerminal(true);
    expect(typeof window.__tlFocusTerminal).toBe("function");
    unmount();
    expect(window.__tlFocusTerminal).toBeUndefined();
  });

  it("focuses the frame and posts tl-focus when the terminal is the live view", async () => {
    const { posted, focused, unmount } = mountTerminal(true);
    // The mount-time active effect focuses on a rAF; drain it so this test
    // observes only the explicit call.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const before = focused();
    const beforePosts = posted.length;

    expect(window.__tlFocusTerminal?.()).toBe(true);
    expect(focused()).toBe(before + 1);
    expect(typesOf(posted.slice(beforePosts))).toContain("tl-focus");
    unmount();
  });

  it("declines while the TEXT view owns the keyboard (never steals the composer)", () => {
    const { posted, focused, unmount } = mountTerminal(false);
    expect(window.__tlFocusTerminal?.()).toBe(false);
    expect(focused()).toBe(0);
    expect(typesOf(posted)).not.toContain("tl-focus");
    unmount();
  });

  it("term.html handles the tl-focus this sends", () => {
    expect(termHtml()).toContain("e.data.type === 'tl-focus'");
  });
});

describe("refocusTerminal — the shared 'give the pty the keyboard back' call", () => {
  afterEach(() => {
    delete window.__tlFocusTerminal;
  });

  it("is a no-op when no terminal is mounted", () => {
    expect(refocusTerminal()).toBe(false);
  });

  it("calls the mounted terminal's hook and reports whether it took", () => {
    const hook = vi.fn(() => true);
    window.__tlFocusTerminal = hook;
    expect(refocusTerminal()).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe("<TerminalView> — window.__tlPrefsLive (live font size / prefs)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    delete window.__tlPrefsLive;
    localStorage.clear();
  });

  it("registers the hook while mounted and restores it on unmount", () => {
    expect(window.__tlPrefsLive).toBeUndefined();
    const { unmount } = mountTerminal(true);
    expect(typeof window.__tlPrefsLive).toBe("function");
    unmount();
    expect(window.__tlPrefsLive).toBeUndefined();
  });

  it("posts tl-prefs AND tl-font-size into the frame — no navigation", () => {
    const { posted, unmount } = mountTerminal(true);
    const framesBefore = posted.length;
    expect(window.__tlPrefsLive?.({ fontSize: 6 })).toBe(true);
    const sent = posted.slice(framesBefore);
    expect(typesOf(sent)).toEqual(expect.arrayContaining(["tl-prefs", "tl-font-size"]));
    const font = sent.find((p) => p.type === "tl-font-size");
    expect(font?.size).toBe(6);
    const prefs = sent.find((p) => p.type === "tl-prefs");
    expect((prefs?.prefs as { fontSize?: number } | undefined)?.fontSize).toBe(6);
    unmount();
  });

  it("applies to the HIDDEN frame too — a size change must survive the view swap", () => {
    // The iframe stays mounted while the Text view shows; a font step made there
    // has to be in effect the moment [Terminal] comes back, without a reload.
    const { posted, unmount } = mountTerminal(false);
    expect(window.__tlPrefsLive?.({ fontSize: 20 })).toBe(true);
    expect(typesOf(posted)).toEqual(expect.arrayContaining(["tl-prefs", "tl-font-size"]));
    unmount();
  });

  it("term.html handles both messages this sends", () => {
    const src = termHtml();
    expect(src).toContain("e.data.type === 'tl-font-size'");
    expect(src).toContain("e.data.type === 'tl-prefs'");
  });
});

/**
 * ATTACH TIMING — attaching a live tmux session resizes ITS window to whatever
 * this iframe measures. The eager attach therefore squeezed a real 200x50
 * client down to the iframe's construction-default 80x24 the moment a card was
 * clicked, without the user ever opening the Terminal view: ttyd's INIT
 * handshake serialises `columns: term.cols, rows: term.rows` and that sizes the
 * pty at spawn, before any sendResize() could correct it. So the attach itself
 * has to wait for the Terminal view — except for a session the app is CREATING,
 * which has no tmux session until this iframe reaches ttyd.
 */

/** Route every iframe's contentWindow to a fake so navigations are observable
 *  (jsdom refuses real frame navigation) and record the URLs each one gets. */
function withFakeFrames(): {
  nav: string[];
  restore: () => void;
} {
  const nav: string[] = [];
  const desc = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentWindow",
  );
  const fakes = new WeakMap<HTMLIFrameElement, unknown>();
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      let f = fakes.get(this);
      if (!f) {
        f = {
          location: { replace: (u: string) => void nav.push(u) },
          postMessage: () => {},
          focus: () => {},
        };
        fakes.set(this, f);
      }
      return f;
    },
  });
  return {
    nav,
    restore: () => {
      if (desc) Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", desc);
    },
  };
}

describe("<TerminalView> — lazy attach (never resize a pty nobody asked to see)", () => {
  let frames: ReturnType<typeof withFakeFrames>;
  beforeEach(() => {
    frames = withFakeFrames();
  });
  afterEach(() => frames.restore());

  it("does NOT attach an existing session while the Text view is showing", () => {
    render(() => <TerminalView session="qa-lazy" active={false} />);
    expect(frames.nav).toEqual([]);
  });

  it("attaches the moment the Terminal view is first shown", () => {
    const [active, setActive] = createSignal(false);
    render(() => <TerminalView session="qa-lazy" active={active()} />);
    expect(frames.nav).toEqual([]);
    setActive(true);
    expect(frames.nav).toEqual(["/term.html?arg=qa-lazy"]);
  });

  it("stays attached when you go back to Text (the WebSocket must survive)", () => {
    const [active, setActive] = createSignal(false);
    render(() => <TerminalView session="qa-lazy" active={active()} />);
    setActive(true);
    setActive(false);
    setActive(true);
    expect(frames.nav).toEqual(["/term.html?arg=qa-lazy"]);
  });

  it("attaches EAGERLY for a session the app is creating (nothing else births it)", () => {
    render(() => <TerminalView session="qa-new" active={false} creating />);
    expect(frames.nav).toEqual(["/term.html?arg=qa-new"]);
  });

  it("re-attaches on a session change once it has been shown", () => {
    const [session, setSession] = createSignal("qa-a");
    render(() => <TerminalView session={session()} active={true} />);
    setSession("qa-b");
    expect(frames.nav).toEqual(["/term.html?arg=qa-a", "/term.html?arg=qa-b"]);
  });
});

describe("<TerminalView> — the project directory reaches the attach URL", () => {
  let frames: ReturnType<typeof withFakeFrames>;
  beforeEach(() => {
    frames = withFakeFrames();
  });
  afterEach(() => frames.restore());

  it("puts a project dir at arg3 (with the inert arg2 placeholder ahead of it)", () => {
    render(() => (
      <TerminalView session="qa-vdirs" active={true} dir="/tmp/qa-harness-scratch" />
    ));
    expect(frames.nav).toEqual([
      "/term.html?arg=qa-vdirs&arg=default&arg=%2Ftmp%2Fqa-harness-scratch",
    ]);
  });

  it("keeps the chosen new-session command alongside the dir", () => {
    render(() => (
      <TerminalView
        session="qa-vdirs"
        active={true}
        dir="/tmp/qa-harness-scratch"
        newCommand={() => "claude"}
      />
    ));
    expect(frames.nav).toEqual([
      "/term.html?arg=qa-vdirs&arg=claude&arg=%2Ftmp%2Fqa-harness-scratch",
    ]);
  });

  it("sends no arg3 for a session that belongs to no project", () => {
    render(() => <TerminalView session="qa-loose" active={true} />);
    expect(frames.nav).toEqual(["/term.html?arg=qa-loose"]);
  });
});
