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
 * signal rides the terminal iframe's `tl-attention` postMessage, so these tests
 * drive that message rather than the latch directly.
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
  root.querySelector<HTMLElement>(".tl-conn");

const segments = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>(".tl-viewswitch .tl-seg"));

const dots = (root: HTMLElement): boolean[] =>
  segments(root).map((b) => !!b.querySelector(".tl-activity-dot"));

const mode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;

/** Post a message UP from the mounted terminal iframe, as term.html does. */
function fromFrame(root: HTMLElement, data: unknown): void {
  const frame = root.querySelector<HTMLIFrameElement>("iframe.tl-ttyd");
  expect(frame, "the mounted terminal iframe").toBeTruthy();
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: location.origin,
      source: frame?.contentWindow,
    }),
  );
}

describe("<SessionView> — view toggle bridge + terminal activity dot", () => {
  let origES: unknown;
  beforeEach(() => {
    origES = g.EventSource;
    eventSources.length = 0;
    g.EventSource = class {
      onopen: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      constructor(public url: string) {
        eventSources.push(this);
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

    fromFrame(container, { type: "tl-attention", kind: "output", session: "qa-vs" });
    // [Text (selected), Terminal (hidden — has unseen output)]
    expect(dots(container)).toEqual([false, true]);
  });

  it("clears the [Terminal] dot when you switch to the terminal", () => {
    const { container } = render(() => <SessionView session="qa-vs" />);
    fireEvent.click(segments(container)[0]!); // [Text] — so the bell lands while the terminal is hidden
    fromFrame(container, { type: "tl-attention", kind: "bell", session: "qa-vs" });
    expect(dots(container)).toEqual([false, true]);

    fireEvent.click(segments(container)[1]!); // [Terminal]
    expect(mode(container)).toBe("terminal");
    expect(dots(container)).toEqual([false, false]);
  });

  /**
   * QA #5: `.tl-conn` reports the TEXT view's SSE transcript stream, and it was
   * the session bar's only status badge in either view. On the Terminal view —
   * the v1 default, with the Text view deferred — a plain shell session
   * therefore sat under a permanent "no transcript" readout about a view the
   * user cannot use, and said nothing at all about the live terminal. The badge
   * belongs to the view it describes.
   */
  it("shows the transcript badge on the Text view only", () => {
    const { container } = render(() => <SessionView session="qa-vs" />);
    expect(mode(container)).toBe("terminal");
    expect(conn(container)).toBeNull();

    fireEvent.click(segments(container)[0]!); // [Text]
    expect(conn(container)).not.toBeNull();

    fireEvent.click(segments(container)[1]!); // [Terminal]
    expect(conn(container)).toBeNull();
  });

  // A plain shell session (no Claude, hence no transcript registered with
  // session-events) reads as such in the Text view's badge. It used to sit on
  // RECONNECTING forever while the client hammered a permanent 404.
  it("badges a session with no transcript as such, not as a failing connection", async () => {
    const origFetch = g.fetch;
    g.fetch = async () => new Response(null, { status: 404 });
    try {
      const { container } = render(() => <SessionView session="qa-vs" />);
      fireEvent.click(segments(container)[0]!); // [Text] — the badge's own view
      expect(conn(container)?.textContent).toBe("connecting");

      eventSources[0]!.onerror?.(null); // the 404 the browser reports opaquely
      await flush();

      expect(conn(container)?.getAttribute("data-status")).toBe("no-transcript");
      expect(conn(container)?.textContent).toBe("no transcript");
      expect(conn(container)?.getAttribute("title")).toContain("no Claude transcript");
    } finally {
      g.fetch = origFetch;
    }
  });

  it("still says reconnecting when the stream is merely unreachable", async () => {
    const origFetch = g.fetch;
    g.fetch = async () => new Response(null, { status: 502 });
    try {
      const { container } = render(() => <SessionView session="qa-vs" />);
      fireEvent.click(segments(container)[0]!); // [Text] — the badge's own view
      eventSources[0]!.onerror?.(null);
      await flush();
      expect(conn(container)?.getAttribute("data-status")).toBe("reconnecting");
      expect(conn(container)?.textContent).toBe("reconnecting");
    } finally {
      g.fetch = origFetch;
    }
  });

  // Attaching a live session resizes ITS tmux window to whatever the iframe
  // measures, so a HIDDEN terminal must not attach: a passive selection used to
  // squeeze a real 200x50 client to 80x24. Terminal-first means the DEFAULT view
  // attaches on mount (correctly, at full size); to exercise the laziness we
  // start this session in Text so the terminal is the hidden one.
  it("does not attach the terminal while it is the hidden view, only when opened", () => {
    localStorage.setItem("tl:viewmode:v1:qa-vs", "text"); // start with the terminal hidden
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
    try {
      const { container } = render(() => <SessionView session="qa-vs" />);
      expect(mode(container)).toBe("text");
      expect(nav).toEqual([]);

      fireEvent.click(segments(container)[1]!); // [Terminal]
      expect(nav).toEqual(["/term.html?arg=qa-vs"]);
    } finally {
      if (desc) Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", desc);
    }
  });

  it("still forwards the attention signal to the lobby (tab badge)", () => {
    const seen: string[] = [];
    const { container } = render(() => (
      <SessionView session="qa-vs" onFrameAttention={(kind) => seen.push(kind)} />
    ));
    fromFrame(container, { type: "tl-attention", kind: "output", session: "qa-vs" });
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

  it("reads the clipboard HERE and sends the text down, never asking the frame to read", async () => {
    // The frame cannot read the clipboard: clicking this button focuses the
    // LOBBY, and the async clipboard is gated on document focus, so a read
    // inside the frame throws "Document is not focused" — reported to the user
    // as denied access for a permission never requested.
    const pasted: string[] = [];
    const forwarded: string[] = [];
    const orig = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: async () => "from-the-lobby" },
    });
    // AFTER render: the mounted TerminalView installs these hooks in its
    // onMount, so stubs set beforehand are the ones that lose.
    const { container } = render(() => <SessionView session="qa-tools" />);
    window.__tlPasteToTerminal = (t: string) => {
      pasted.push(t);
      return true;
    };
    window.__tlForwardToTerminal = (cmd: string) => {
      forwarded.push(cmd);
      return true;
    };
    try {
      fireEvent.click(container.querySelector('[aria-label="Paste from clipboard"]')!);
      await waitFor(() => expect(pasted).toEqual(["from-the-lobby"]));
      expect(forwarded).not.toContain("terminal.paste");
    } finally {
      delete window.__tlForwardToTerminal;
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
        addEventListener: () => {},
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
