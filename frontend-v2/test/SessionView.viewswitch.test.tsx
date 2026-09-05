import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { SessionView } from "../src/components/SessionView";

/** The lazily-imported CodeMirror host, faked so a draft edit is drivable. */
let cmChange: ((text: string) => void) | null = null;
vi.mock("../src/components/codemirror-view", () => ({
  createEditorView: (o: { onChange: (t: string) => void }) => {
    cmChange = o.onChange;
    return { destroy: () => {} };
  },
}));

/**
 * The terminal, stubbed. A real one boots xterm, and xterm's
 * `CoreBrowserService` calls `matchMedia`, which jsdom does not ship — so
 * `term.open()` rejects and Vitest fails the FILE on the unhandled rejection
 * while every assertion in it passes. What the real component does is
 * TerminalNative.wiring.test.tsx, which brings its own `matchMedia`.
 */
const terminal = vi.hoisted(() => ({
  signal: null as null | ((kind: "bell" | "output") => void),
}));
vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: (props: { onAttention?: (kind: "bell" | "output") => void }) => {
    terminal.signal = (kind) => props.onAttention?.(kind);
    return <div class="tl-terminal-native" />;
  },
}));

/** file-api reads: serve one small text file, no network. */
vi.mock("../src/lib/file-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/file-api")>();
  return {
    ...actual,
    readFile: async () => ({ kind: "code", language: "typescript", text: "baseline\n" }),
  };
});

/**
 * The per-session view surface: the Ctrl/Cmd-J bridge the lobby dispatcher needs
 * to reach this component, and the [Terminal] segment's activity dot.
 *
 * The dot is the mirror of the [Text] one: output that arrives in the pty while
 * the text view is showing has to mark the segment you are NOT looking at. The
 * signal used to ride the terminal iframe's `tl-attention` postMessage; the
 * terminal is a sibling component now and hands it over through `onAttention`,
 * so `fromTerminal` below fires the prop instead of dispatching a message.
 *
 * ONE GUARD LOST ITS SUBJECT HERE ON 2026-09-05, and it is worth naming rather
 * than quietly dropping. "does not attach the terminal while it is the hidden
 * view, only when opened" held the LAZY ATTACH property: attaching a live
 * session resizes its tmux window to whatever this client measures, so a
 * passive selection could squeeze a real 200x50 client to 80x24. TerminalView
 * implemented it with a one-way `attachAllowed` latch. TerminalNative has no
 * such latch — it attaches inside `onMount` — so the property has not held
 * since the flip (2026-09-04), and the test was passing because the flag sent
 * it to the iframe. Deleting it does not cause that; it removes a test that can
 * no longer be true. terminal/fit.ts still stops a 0x0 host from RESIZING the
 * window, which is the other half of the same damage, but nothing stops the
 * attach itself.
 */

const g = globalThis as unknown as { EventSource?: unknown; fetch?: unknown };

interface FakeSource {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
}
const eventSources: FakeSource[] = [];

/** Let the SSE client's async failure classification settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const conn = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>(".tl-conn-badge");

/**
 * The status wiring a mounted view is handed, with the transcript statuses it
 * publishes recorded. That publication IS the contract now: the bar's badge
 * shows the worst of every channel rather than this one stream, so what this
 * view says about its stream is what the rest of the app reacts to.
 */
function statusProbe() {
  const transcript: (string | null)[] = [];
  return {
    transcript,
    last: () => transcript[transcript.length - 1] ?? null,
    props: {
      channels: () => [],
      onOpen: () => {},
      onTranscript: (s: string | null) => void transcript.push(s),
      onTerminalConn: () => {},
      askConn: () => {},
      retryConn: () => {},
    },
  };
}

const segments = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"));

const dots = (root: HTMLElement): boolean[] =>
  segments(root).map((b) => !!b.querySelector(".tl-activity-dot"));

const mode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;

/** Fire the terminal's attention hand-up, as terminal/attention.ts does. */
function fromTerminal(kind: "bell" | "output"): void {
  expect(terminal.signal, "the mounted terminal").toBeTruthy();
  terminal.signal?.(kind);
}

describe("<SessionView> — view toggle bridge + terminal activity dot", () => {
  let origES: unknown;
  beforeEach(() => {
    terminal.signal = null;
    origES = g.EventSource;
    eventSources.length = 0;
    g.EventSource = class {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      constructor(public url: string) {
        eventSources.push(this);
      }
      // The store holds its first paint until the opening window is complete;
      // this fake has no replay, so it is complete at once.
      addEventListener(type: string, fn: (ev: { data: string }) => void): void {
        if (type === "ready") fn({ data: "0" });
      }
      close(): void {}
    };
    localStorage.clear();
  });
  afterEach(() => {
    g.EventSource = origES;
    localStorage.clear();
  });

  it("registers window.__tlToggleView while mounted and clears it on unmount", () => {
    const { container, unmount } = render(() => <SessionView session="qa-vs" />);
    const toggle = window.__tlToggleView;
    expect(typeof toggle).toBe("function");
    expect(mode(container)).toBe("terminal");

    expect(toggle?.()).toBe(true);
    expect(mode(container)).toBe("text");
    expect(toggle?.()).toBe(true);
    expect(mode(container)).toBe("terminal");

    unmount();
    expect(window.__tlToggleView).toBeUndefined();
  });

  /**
   * QA #11: the Ctrl/Cmd+J listener is an unconditional capture-phase window
   * keydown — it fired with the command palette up and focus in its input,
   * flipping the view behind the overlay and leaving the palette itself
   * standing. The shell publishes which overlay owns the keyboard; the
   * always-on toggle has to stand down while one does.
   */
  it("does not toggle the view on Ctrl+J while an overlay owns the keyboard", () => {
    const { container } = render(() => (
      <SessionView session="qa-vs" overlayOpen={() => true} />
    ));
    expect(mode(container)).toBe("terminal");

    const e = new KeyboardEvent("keydown", {
      key: "j",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(e);

    expect(mode(container)).toBe("terminal");
    // ...and the key is left alone, so the focused field still gets it.
    expect(e.defaultPrevented).toBe(false);
  });

  it("leaves Ctrl+J to the scratch-shell dock, as on the vanilla page", () => {
    // Ctrl/Cmd+J opens a shell — that is what it has always done here, and the
    // rewrite had quietly repurposed it for the view toggle. The toggle keeps
    // the [Text|Terminal] control and window.__tlToggleView; only the chord
    // moved.
    const { container } = render(() => (
      <SessionView session="qa-vs" overlayOpen={() => false} />
    ));
    const before = mode(container);
    const e = new KeyboardEvent("keydown", {
      key: "j",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(e);

    expect(mode(container)).toBe(before);
    expect(e.defaultPrevented).toBe(false);
    // the toggle itself is still reachable
    expect(typeof window.__tlToggleView).toBe("function");
    expect(window.__tlToggleView?.()).toBe(true);
    expect(mode(container)).not.toBe(before);
  });

  it("dots the [Terminal] segment when output arrives while you're in text mode", () => {
    const { container } = render(() => <SessionView session="qa-vs" />);
    // Terminal is the default view now, so switch to Text first — the [Terminal]
    // dot only latches for output that lands while the terminal is HIDDEN.
    fireEvent.click(segments(container)[0]!); // [Text]
    expect(mode(container)).toBe("text");
    expect(dots(container)).toEqual([false, false]);

    fromTerminal("output");
    // [Text (selected), Terminal (hidden — has unseen output)]
    expect(dots(container)).toEqual([false, true]);
  });

  it("clears the [Terminal] dot when you switch to the terminal", () => {
    const { container } = render(() => <SessionView session="qa-vs" />);
    fireEvent.click(segments(container)[0]!); // [Text] — so the bell lands while the terminal is hidden
    fromTerminal("bell");
    expect(dots(container)).toEqual([false, true]);

    fireEvent.click(segments(container)[1]!); // [Terminal]
    expect(mode(container)).toBe("terminal");
    expect(dots(container)).toEqual([false, false]);
  });

  /**
   * QA #5 REVERSED, deliberately. The old `.tl-conn` badge reported the TEXT
   * view's SSE stream and only that, so it was hidden on the Terminal view —
   * where it would have read as the terminal's status — which left the terminal
   * itself reporting nothing at all. The badge now shows the worst of every
   * channel the surface can honestly report (ADR-0016), so it belongs on BOTH
   * views. The old badge's markup is gone with the behaviour.
   */
  it("shows one badge, on both views", () => {
    const probe = statusProbe();
    const { container } = render(() => <SessionView session="qa-vs" status={probe.props} />);
    expect(mode(container)).toBe("terminal");
    expect(container.querySelectorAll(".tl-conn-badge")).toHaveLength(1);

    fireEvent.click(segments(container)[0]!); // [Text]
    expect(container.querySelectorAll(".tl-conn-badge")).toHaveLength(1);

    fireEvent.click(segments(container)[1]!); // [Terminal]
    expect(container.querySelectorAll(".tl-conn-badge")).toHaveLength(1);
  });

  it("draws no badge at all where the shell supplies no status", () => {
    const { container } = render(() => <SessionView session="qa-vs" />);
    expect(conn(container)).toBeNull();
  });

  /**
   * A plain shell session — no Claude, so no transcript registered with
   * session-events — must not read as a broken connection. It used to sit on
   * RECONNECTING forever while the client hammered a permanent 404; what the
   * view publishes is now what decides that, and `no-transcript` maps to
   * working (status.ts).
   */
  it("publishes a missing transcript as such, not as a failing connection", async () => {
    const origFetch = g.fetch;
    g.fetch = async () => new Response(null, { status: 404 });
    try {
      const probe = statusProbe();
      const { container } = render(() => <SessionView session="qa-vs" status={probe.props} />);
      fireEvent.click(segments(container)[0]!); // [Text] opens the stream
      expect(probe.last()).toBe("connecting");

      eventSources[0]!.onerror?.(null); // the 404 the browser reports opaquely
      await flush();

      expect(probe.last()).toBe("no-transcript");
    } finally {
      g.fetch = origFetch;
    }
  });

  it("still publishes reconnecting when the stream is merely unreachable", async () => {
    const origFetch = g.fetch;
    g.fetch = async () => new Response(null, { status: 502 });
    try {
      const probe = statusProbe();
      const { container } = render(() => <SessionView session="qa-vs" status={probe.props} />);
      fireEvent.click(segments(container)[0]!); // [Text] opens the stream
      eventSources[0]!.onerror?.(null);
      await flush();
      expect(probe.last()).toBe("reconnecting");
    } finally {
      g.fetch = origFetch;
    }
  });

  /**
   * The lazy-connect half of the same contract: before Text is shown nothing
   * has asked the stream to open, and publishing its `connecting` initial value
   * made a terminal-only session report a transcript in trouble (c494629).
   */
  it("publishes nothing about a stream it has not opened", () => {
    const probe = statusProbe();
    render(() => <SessionView session="qa-vs" status={probe.props} />);
    expect(probe.transcript.every((s) => s === null)).toBe(true);
  });

  it("still forwards the attention signal to the lobby (tab badge)", () => {
    const seen: string[] = [];
    render(() => (
      <SessionView session="qa-vs" onTerminalAttention={(kind) => seen.push(kind)} />
    ));
    fromTerminal("output");
    expect(seen).toEqual(["output"]);
  });

  /**
   * The file-preview store is created HERE, per session, so a session switch
   * disposes it and any unsaved draft inside it. The shell owns the chords that
   * switch session, and it cannot see this store — so the overlay's open+dirty
   * state has to travel up, and it has to be reset when this view goes away or a
   * stale "dirty" would jam every later chord.
   */
  it("publishes the file-preview's open + dirty state to the shell", async () => {
    const seen: { open: boolean; dirty: boolean }[] = [];
    const { container, unmount } = render(() => (
      <SessionView session="qa-vs" onPreviewState={(s) => void seen.push(s)} />
    ));
    expect(seen.at(-1)).toEqual({ open: false, dirty: false });

    // Open the Text view: that is what opens the transcript stream (it is no
    // longer opened by mounting — see SessionView.lazysse.test.tsx), and the
    // recent-files list below is derived from that stream's events.
    fireEvent.click(segments(container)[0]!); // [Text]

    // A Read in the transcript puts a file in the preview's recent list.
    eventSources[0]!.onmessage?.({
      data: JSON.stringify({
        id: 1,
        kind: "tool_use",
        session: "qa-vs",
        tool: "Read",
        body: JSON.stringify({ file_path: "/tmp/qa-harness-scratch/notes.txt" }),
      }),
    });

    fireEvent.click(container.querySelector('[aria-label="File preview"]')!);
    await waitFor(() => expect(seen.at(-1)?.open).toBe(true));
    expect(seen.at(-1)).toEqual({ open: true, dirty: false });

    // One store write per frame: the recent-files list is derived from the
    // stream, so it lands on the next frame rather than in this tick.
    await new Promise((r) => setTimeout(r, 40));

    // Open it, edit it, leave it unsaved.
    fireEvent.click(container.querySelector(".tl-preview-recents button")!);
    const editBtn = (): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent?.trim() === "Edit",
      );
    await waitFor(() => expect(editBtn()).toBeTruthy());
    fireEvent.click(editBtn()!);
    await waitFor(() => expect(cmChange).toBeTruthy());
    cmChange!("SWITCH-LOSS\n");
    await waitFor(() => expect(seen.at(-1)?.dirty).toBe(true));

    // Unmounting IS the session switch — the shell must not be left holding a
    // dirty flag for a view that no longer exists.
    unmount();
    expect(seen.at(-1)).toEqual({ open: false, dirty: false });
  });
});

/**
 * The terminal controls in the session bar. The vanilla page carries these in a
 * floating cluster (A− A+ / images / upload / paste); v2 shipped only two of
 * them, as emoji. These pin both halves of the fix: the set is complete, and the
 * buttons draw SVG rather than an emoji codepoint.
 */
describe("<SessionView> — terminal controls in the session bar", () => {
  it("offers font size, images, upload and paste — not just two of them", () => {
    const { container } = render(() => <SessionView session="qa-tools" />);
    const labels = [...container.querySelectorAll(".tl-session-bar button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        "Smaller terminal font",
        "Larger terminal font",
        "Session images",
        "Upload image",
        "Paste from clipboard",
        "File preview",
      ]),
    );
  });

  it("draws icons, not emoji", () => {
    // The vanilla page moved off emoji because they render in colour at an
    // OS-dependent size; a regression here is invisible to every other test.
    // The buttons DO carry a text label — what must never come back is a
    // pictographic glyph standing in for the icon.
    const { container } = render(() => <SessionView session="qa-tools" />);
    for (const label of ["Session images", "Upload image", "Paste from clipboard", "File preview"]) {
      const btn = container.querySelector(`.tl-session-bar [aria-label="${label}"]`)!;
      expect(btn.querySelector("svg"), `${label} should draw an svg`).toBeTruthy();
      expect(btn.textContent ?? "", `${label} should carry no emoji`).not.toMatch(
        /\p{Extended_Pictographic}/u,
      );
    }
  });

  it("labels each control, so six icons are not a guessing game", () => {
    const { container } = render(() => <SessionView session="qa-tools" />);
    const labelled = (aria: string): string =>
      container
        .querySelector(`.tl-session-bar [aria-label="${aria}"] .tl-btn-label`)
        ?.textContent?.trim() ?? "";
    expect(labelled("Session images")).toBe("Images");
    expect(labelled("Upload image")).toBe("Upload");
    expect(labelled("Paste from clipboard")).toBe("Paste");
    expect(labelled("File preview")).toBe("Files");
  });

  it("steps the roamed font size, clamped at the ends", () => {
    const sizes: number[] = [];
    let current = 15;
    const prefs = {
      prefs: () => ({ fontSize: current }),
      setFontSize: (n: number) => {
        current = n;
        sizes.push(n);
      },
    } as unknown as Parameters<typeof SessionView>[0]["prefs"];
    const { container } = render(() => <SessionView session="qa-tools" prefs={prefs} />);
    const click = (label: string) =>
      fireEvent.click(container.querySelector(`[aria-label="${label}"]`)!);

    click("Larger terminal font");
    expect(sizes.at(-1)).toBe(16);
    click("Smaller terminal font");
    expect(sizes.at(-1)).toBe(15);

    // ...and the clamp holds at the ceiling rather than walking past it.
    current = 22;
    click("Larger terminal font");
    expect(sizes.at(-1)).toBe(22);
  });

  it("reads the clipboard HERE and hands the text over as a paste", async () => {
    // The read belongs out here. The async clipboard is gated on document
    // focus, and this is the routine the soft-key button and the palette share,
    // so there is one place that asks for the permission and one that fails.
    const pasted: string[] = [];
    const sent: string[] = [];
    const orig = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "from-the-lobby" },
    });
    // AFTER render: the mounted terminal installs these hooks itself, so stubs
    // set beforehand are the ones that lose.
    const { container } = render(() => <SessionView session="qa-tools" />);
    window.__tlPasteToTerminal = (t: string) => {
      pasted.push(t);
      return true;
    };
    window.__tlSendToTerminal = (b: string) => {
      sent.push(b);
      return true;
    };
    try {
      fireEvent.click(container.querySelector('[aria-label="Paste from clipboard"]')!);
      await waitFor(() => expect(pasted).toEqual(["from-the-lobby"]));
      // Through `term.paste`, not as raw bytes: paste brackets the text and
      // normalizes \r\n, so a multiline paste cannot execute line by line.
      expect(sent).toEqual([]);
    } finally {
      delete window.__tlSendToTerminal;
      delete window.__tlPasteToTerminal;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: orig });
    }
  });

  it("hides the terminal controls on a coarse pointer, where the soft keys carry them", () => {
    const orig = window.matchMedia;
    // A TABLET: coarse, but not the phone flip. The distinction matters here —
    // the phone moves Files and Watch into the bar's ⋯ (there is no room for
    // them beside a back control at 390px), so answering every query that
    // mentions "coarse" with true would test a different layout than the one
    // this case is about.
    window.matchMedia = ((q: string) =>
      ({
        matches: q.includes("coarse") && !q.includes("max-width"),
        media: q,
        // The store holds its first paint until the opening window is
        // complete; this fake has no replay, so it is complete at once.
        addEventListener: (type: string, fn: (ev: { data: string }) => void) => {
          if (type === "ready") fn({ data: "0" });
        },
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    try {
      const { container } = render(() => <SessionView session="qa-tools" />);
      expect(container.querySelector('[aria-label="Paste from clipboard"]')).toBeNull();
      expect(container.querySelector('[aria-label="Smaller terminal font"]')).toBeNull();
      // the file preview is session chrome, not a terminal control — it stays
      expect(container.querySelector('[aria-label="File preview"]')).not.toBeNull();
    } finally {
      window.matchMedia = orig;
    }
  });
});

/**
 * The text view is the newer of the two and still in testing, so the switch
 * says so (Viktor, 2026-08-18).
 *
 * In one glyph, because the control is already 131px of a 390px header at its
 * labelled size — and because below 380px the labels are hidden entirely, so a
 * word would have nothing to attach to. The word itself lives in the title and
 * the aria-label.
 */
describe("<ViewSwitch> — the text view is marked as alpha", () => {
  const switchOf = (root: HTMLElement) =>
    Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"));

  it("marks the text segment, and only that one", () => {
    const { container } = render(() => <SessionView session="qa-alpha" />);
    const [text, terminal] = switchOf(container as HTMLElement);
    expect(text!.querySelector(".tl-seg-alpha")?.textContent?.trim()).toBe("α");
    expect(terminal!.querySelector(".tl-seg-alpha")).toBeNull();
  });

  it("says the word where there is room for it", () => {
    // The glyph is aria-hidden, so this is the only thing that announces it.
    const { container } = render(() => <SessionView session="qa-alpha" />);
    const [text] = switchOf(container as HTMLElement);
    expect(text!.getAttribute("aria-label")).toMatch(/alpha/i);
    expect(text!.getAttribute("title")).toMatch(/alpha/i);
  });

  it("does not announce it twice", () => {
    const { container } = render(() => <SessionView session="qa-alpha" />);
    const mark = container.querySelector(".tl-seg-alpha")!;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
  });
});
