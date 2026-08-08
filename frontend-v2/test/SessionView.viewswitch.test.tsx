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

  // A plain shell session (no Claude, hence no transcript registered with
  // session-events) shows this badge in the session bar regardless of the active
  // view. It used to sit on RECONNECTING forever while the client hammered a
  // permanent 404.
  it("badges a session with no transcript as such, not as a failing connection", async () => {
    const origFetch = g.fetch;
    g.fetch = async () => new Response(null, { status: 404 });
    try {
      const { container } = render(() => <SessionView session="qa-vs" />);
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
