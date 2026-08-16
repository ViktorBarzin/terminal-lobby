/**
 * SessionView's two phone-layout seams: the bar slots the shell folds its own
 * controls into, and the `visible` flag that keeps a hidden pane from resizing
 * the real tmux window.
 */
import { describe, it, expect } from "vitest";
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

describe("<SessionView> — the merged phone bar", () => {
  it("renders the shell's controls in its own bar, leading and trailing", () => {
    const { container } = render(() => (
      <SessionView
        session="qa-mobile"
        leading={<button class="tl-back-btn">back</button>}
        trailing={<button class="tl-settings-btn">gear</button>}
      />
    ));
    const bar = container.querySelector(".tl-session-bar")!;
    const back = bar.querySelector(".tl-back-btn");
    const gear = bar.querySelector(".tl-settings-btn");
    expect(back).not.toBeNull();
    expect(gear).not.toBeNull();
    // Order matters as much as presence: back reads first (it is the way out),
    // the gear last, with the session's own controls between them.
    const kids = [...bar.children];
    expect(kids.indexOf(back!)).toBe(0);
    expect(kids.indexOf(gear!)).toBe(kids.length - 1);
  });

  it("renders nothing extra when the shell keeps its own bar", () => {
    const { container } = render(() => <SessionView session="qa-mobile" />);
    const bar = container.querySelector(".tl-session-bar")!;
    expect(bar.querySelector(".tl-back-btn")).toBeNull();
    expect(bar.querySelector(".tl-settings-btn")).toBeNull();
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
