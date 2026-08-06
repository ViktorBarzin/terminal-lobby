import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@solidjs/testing-library";
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
