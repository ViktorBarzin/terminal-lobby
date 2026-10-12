/**
 * The switcher's third option (docs/plans/2026-10-12-t3-view-design.md,
 * decisions 11, 12, 16 and 17): T3 Code's web client in a frame, offered to an
 * admin acting as themselves on their own Claude session, and to nobody else.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createSignal } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";

vi.mock("../src/components/TerminalNative", () => ({
  TerminalNative: () => <div class="tl-terminal-native" />,
}));

import { SessionView } from "../src/components/SessionView";
import type { T3Wiring } from "../src/components/T3Host";
import type { SessionTool } from "../src/types/lobby";

const ORIGIN = "http://127.0.0.1:17691";

const wiring = (admin: () => boolean = () => true): T3Wiring => ({
  admin,
  origin: ORIGIN,
  chords: () => [],
});

const mode = (root: HTMLElement): string | null =>
  root.querySelector(".tl-session-view")?.getAttribute("data-mode") ?? null;
const t3Button = (root: HTMLElement): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(".tl-bar-group .tl-t3-toggle");
const viewToggle = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(".tl-bar-group .tl-view-toggle")!;

function mount(opts: { t3?: T3Wiring; tool?: SessionTool; owner?: string; session?: string }) {
  return render(() => (
    <SessionView
      session={opts.session ?? "qa-t3"}
      owner={opts.owner}
      me={() => "wizard"}
      tool={() => opts.tool ?? "claude"}
      t3={opts.t3}
    />
  ));
}

afterEach(() => localStorage.clear());

describe("<SessionView> — the T3 option", () => {
  it("is absent without the T3 wiring", () => {
    const { container } = mount({});
    expect(t3Button(container)).toBeNull();
  });

  it("is offered to an admin on their own Claude session", () => {
    const { container } = mount({ t3: wiring() });
    expect(t3Button(container)).toBeTruthy();
    expect(t3Button(container)!.getAttribute("aria-pressed")).toBe("false");
  });

  it("is not offered to a non-admin", () => {
    const { container } = mount({ t3: wiring(() => false) });
    expect(t3Button(container)).toBeNull();
  });

  it("is not offered on somebody else's session", () => {
    const { container } = mount({ t3: wiring(), owner: "emo" });
    expect(t3Button(container)).toBeNull();
  });

  it("is not offered on a pi, codex or shell session", () => {
    for (const tool of ["pi", "codex", "shell"] as const) {
      const { container, unmount } = mount({ t3: wiring(), tool });
      expect(t3Button(container), tool).toBeNull();
      unmount();
    }
  });

  it("appears when /whoami lands and says admin", () => {
    const [admin, setAdmin] = createSignal(false);
    const { container } = mount({ t3: wiring(admin) });
    expect(t3Button(container)).toBeNull();
    setAdmin(true);
    expect(t3Button(container)).toBeTruthy();
  });

  it("switches the session to the T3 view and frames it, and the text toggle leaves it", () => {
    const { container } = mount({ t3: wiring() });
    expect(mode(container)).toBe("text");
    expect(container.querySelector("iframe")).toBeNull();

    fireEvent.click(t3Button(container)!);
    expect(mode(container)).toBe("t3");
    expect(t3Button(container)!.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("tl:viewmode:v1:qa-t3")).toBe("t3");
    const frame = container.querySelector<HTMLIFrameElement>(".tl-t3-view iframe");
    expect(frame).toBeTruthy();
    expect(frame!.getAttribute("src")).toBe(`${ORIGIN}/?embed`);

    // The one view icon names the view it switches to: Text, from here.
    expect(viewToggle(container).getAttribute("aria-label")).toBe("Text view");
    fireEvent.click(viewToggle(container));
    expect(mode(container)).toBe("text");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("pressing T3 again goes back to text", () => {
    const { container } = mount({ t3: wiring() });
    fireEvent.click(t3Button(container)!);
    fireEvent.click(t3Button(container)!);
    expect(mode(container)).toBe("text");
  });

  it("a stored T3 choice reads as text on a device that is not offered it", () => {
    localStorage.setItem("tl:viewmode:v1:qa-t3", "t3");
    const { container } = mount({ t3: wiring(() => false) });
    expect(mode(container)).toBe("text");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("opens straight into T3 when that is the stored view", () => {
    localStorage.setItem("tl:viewmode:v1:qa-t3", "t3");
    const { container } = mount({ t3: wiring() });
    expect(mode(container)).toBe("t3");
    expect(container.querySelector(".tl-t3-view iframe")).toBeTruthy();
  });

  it("a paste routed from the lobby does not type into the hidden terminal", () => {
    const sent = vi.fn(() => true);
    window.__tlPasteToTerminal = sent;
    localStorage.setItem("tl:viewmode:v1:qa-t3", "t3");
    mount({ t3: wiring() });
    expect(window.__tlDoPaste?.()).toBe(true);
    expect(sent).not.toHaveBeenCalled();
    delete window.__tlPasteToTerminal;
  });
});
