/**
 * SessionView's two phone-layout seams: the bar slots the shell folds its own
 * controls into, and the `visible` flag that keeps a hidden pane from resizing
 * the real tmux window.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "@solidjs/testing-library";
import { SessionView } from "../src/components/SessionView";

type Posted = { type?: string; hidden?: boolean };

/**
 * Mount a session whose `visible` can be moved afterwards, and capture what its
 * terminal iframe is told. The stub can only be installed once the iframe has a
 * contentWindow (after mount), so every assertion here is about a TRANSITION —
 * which is the case that matters: navigating between the list and the terminal
 * is exactly when the frame has to be re-told.
 */
function mountVisible(initial: boolean | undefined): {
  posted: Posted[];
  setVisible: (v: boolean | undefined) => void;
} {
  const [visible, setVisible] = createSignal<boolean | undefined>(initial);
  const posted: Posted[] = [];
  const { container } = render(() => (
    <SessionView session="qa-mobile" visible={visible()} />
  ));
  const frame = container.querySelector<HTMLIFrameElement>("iframe.tl-ttyd");
  expect(frame, "the mounted terminal iframe").toBeTruthy();
  const win = frame!.contentWindow as unknown as {
    postMessage: (m: unknown) => void;
  };
  win.postMessage = (m: unknown) => void posted.push(m as Posted);
  return { posted, setVisible: (v) => setVisible(() => v) };
}

const lastView = (posted: Posted[]): Posted | undefined =>
  [...posted].reverse().find((p) => p.type === "tl-view");

/** Answer media queries from a viewport, not from a substring of the query. */
function stubViewport(vp: { width: number; height: number; coarse: boolean }): void {
  window.matchMedia = ((q: string) => {
    const ok = () => {
      if (q.includes("pointer: coarse") && !vp.coarse) return false;
      if (q === "(pointer: coarse)") return vp.coarse;
      const w = q.match(/max-width:\s*(\d+)px/);
      const h = q.match(/max-height:\s*(\d+)px/);
      return (w ? vp.width <= Number(w[1]) : false) || (h ? vp.height <= Number(h[1]) : false);
    };
    return {
      media: q,
      get matches() {
        return ok();
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

const PHONE = { width: 390, height: 844, coarse: true };
const TABLET = { width: 768, height: 1024, coarse: true };
const realMatchMedia = window.matchMedia;

describe("<SessionView> — the merged phone bar", () => {
  it("renders the shell's back control first in its own bar", () => {
    const { container } = render(() => (
      <SessionView
        session="qa-mobile"
        leading={<button class="tl-back-btn">back</button>}
      />
    ));
    const bar = container.querySelector(".tl-session-bar")!;
    const back = bar.querySelector(".tl-back-btn");
    expect(back).not.toBeNull();
    // Position matters as much as presence: it is the way out of the terminal.
    expect([...bar.children].indexOf(back!)).toBe(0);
  });

  it("renders nothing extra when the shell keeps its own bar", () => {
    const { container } = render(() => <SessionView session="qa-mobile" />);
    const bar = container.querySelector(".tl-session-bar")!;
    expect(bar.querySelector(".tl-back-btn")).toBeNull();
    expect(bar.querySelector(".tl-bar-menu-btn")).toBeNull();
  });
});

describe("<SessionView> — visible: a hidden pane must not resize tmux", () => {
  it("tells the frame it is hidden when the pane goes off screen", () => {
    // The phone hides the whole session pane (display:none) to give the list
    // the screen. An iframe in a display:none ancestor measures 0x0, and a fit
    // against that resizes the REAL tmux window — tmux sizes a window to its
    // SMALLEST attached client, so every other device on the session shrinks
    // with it. The frame has to be told, not merely hidden.
    const { posted, setVisible } = mountVisible(true);
    setVisible(false);
    expect(lastView(posted)?.hidden).toBe(true);
  });

  it("tells the frame it is showing when the pane comes back", () => {
    const { posted, setVisible } = mountVisible(false);
    setVisible(true);
    expect(lastView(posted)?.hidden).toBe(false);
  });

  it("treats an absent flag as visible, so the desktop never passes it", () => {
    const { posted, setVisible } = mountVisible(false);
    setVisible(undefined);
    expect(lastView(posted)?.hidden).toBe(false);
  });
});

describe("<SessionView> — the phone bar's overflow menu", () => {
  afterEach(() => {
    window.matchMedia = realMatchMedia;
    vi.restoreAllMocks();
  });

  it("moves Files and Watch behind a ⋯ on a phone", () => {
    stubViewport(PHONE);
    const { container } = render(() => <SessionView session="qa-mobile" />);
    const bar = container.querySelector(".tl-session-bar")!;
    // Measured at 390px, the bar's own controls left the session name 29px.
    expect(bar.querySelector('[aria-label="File preview"]')).toBeNull();
    expect(bar.querySelector(".tl-watch-btn")).toBeNull();
    const dots = bar.querySelector<HTMLButtonElement>(".tl-bar-menu-btn");
    expect(dots).not.toBeNull();
    expect(dots!.getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * Every mounted session used to render a soft-key toolbar, and each one
   * publishes `--sk-h` from its own height — so once the lobby started keeping
   * sessions mounted (2026-08-19), a hidden toolbar measuring 0 inside
   * display:none took the reservation away from the visible one. There is one
   * toolbar again: the one on screen.
   */
  it("gives the toolbar only to the session on screen", () => {
    stubViewport(PHONE);
    const shown = render(() => <SessionView session="qa-mobile" visible={true} />);
    expect(shown.container.querySelector("#soft-keys")).not.toBeNull();

    const hidden = render(() => <SessionView session="qa-kept" visible={false} />);
    expect(hidden.container.querySelector("#soft-keys")).toBeNull();
  });

  it("keeps them as buttons on a tablet, which has the room", () => {
    stubViewport(TABLET);
    const { container } = render(() => <SessionView session="qa-mobile" />);
    const bar = container.querySelector(".tl-session-bar")!;
    expect(bar.querySelector(".tl-bar-menu-btn")).toBeNull();
    expect(bar.querySelector('[aria-label="File preview"]')).not.toBeNull();
  });

  it("opens on tap and offers Files, Watch and the shell's own items", () => {
    stubViewport(PHONE);
    // Find searches the transcript, so it is a TEXT-view item. Since 2026-08-19
    // a phone opens in the terminal like everything else, so this session has to
    // say it is being read in text — which is what a reader who tapped Text has.
    localStorage.setItem("tl:viewmode:v1:qa-mobile", "text");
    const { container } = render(() => (
      <SessionView
        session="qa-mobile"
        menuExtra={<button class="tl-menu-item">Settings</button>}
      />
    ));
    const dots = container.querySelector<HTMLButtonElement>(".tl-bar-menu-btn")!;
    expect(container.querySelector(".tl-menu")).toBeNull();
    dots.click();
    const items = [...container.querySelectorAll(".tl-menu-item")].map((e) =>
      (e.textContent || "").trim(),
    );
    // Find is here rather than in the header, which measured 25px past its own
    // edge at 390px — and there is no chord to press on a phone.
    expect(items).toEqual(["Files", "Find in session", "Watch only", "Settings"]);
    expect(dots.getAttribute("aria-expanded")).toBe("true");
    localStorage.removeItem("tl:viewmode:v1:qa-mobile");
  });

  it("closes when one of the shell's items is picked", () => {
    // The shell has no handle on this menu, so its rows would otherwise leave
    // it open behind whatever they just opened.
    stubViewport(PHONE);
    const onPick = vi.fn();
    const { container } = render(() => (
      <SessionView
        session="qa-mobile"
        menuExtra={
          <button class="tl-menu-item" onClick={onPick}>
            Settings
          </button>
        }
      />
    ));
    container.querySelector<HTMLButtonElement>(".tl-bar-menu-btn")!.click();
    const settings = [...container.querySelectorAll<HTMLButtonElement>(".tl-menu-item")].find(
      (e) => (e.textContent || "").trim() === "Settings",
    )!;
    settings.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".tl-menu")).toBeNull();
  });

  it("closes on Escape, like every other overlay", () => {
    stubViewport(PHONE);
    const { container } = render(() => <SessionView session="qa-mobile" />);
    container.querySelector<HTMLButtonElement>(".tl-bar-menu-btn")!.click();
    expect(container.querySelector(".tl-menu")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(container.querySelector(".tl-menu")).toBeNull();
  });
});
