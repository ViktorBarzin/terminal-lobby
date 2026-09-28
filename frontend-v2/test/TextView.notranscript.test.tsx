/**
 * A session with no transcript here: a plain shell, or Codex, which
 * session-events does not register. Deployed review round 1 (2026-09-28): a
 * command sent from a shell's Text view ran in the shell, and the view drew
 * the bubble under a "Working…" row that counted for as long as the view was
 * open, saying "Claude is working" to a screen reader. Nothing can end that
 * row, because no transcript will ever record the prompt.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { PendingPrompt } from "../src/logic/compose.logic";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

const SENT: PendingPrompt[] = [
  { id: -1, text: "echo rv-hello-from-text", at: Date.now(), command: false, afterId: 0 },
];

function mount(noTranscript: "codex" | "shell" | undefined, onOpenTerminal = vi.fn()) {
  g.EventSource = class {
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  };
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return render(() => (
    <TextView
      session="demo"
      events={[]}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
      pendingPrompts={() => SENT}
      noTranscript={noTranscript}
      onOpenTerminal={onOpenTerminal}
      opening
    />
  ));
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("<TextView> for a session with no transcript", () => {
  it("shows what was sent with no live row under it", () => {
    const { container } = mount("shell");
    expect(container.textContent).toContain("echo rv-hello-from-text");
    expect(container.querySelector(".tl-row-live")).toBeNull();
    expect(container.textContent).not.toContain("Working");
    expect(container.textContent).not.toContain("Claude is working");
  });

  it("keeps the live row where a transcript will answer", () => {
    const { container } = mount(undefined);
    expect(container.textContent).toContain("Working");
  });

  // The same review found a Codex session's Text view saying "No messages
  // yet" and "Ask Claude, or run a command…" while Codex answered in the pane.
  // It says where the replies are, and names what the field talks to.
  it("says a Codex session's replies are in the Terminal, and offers it", () => {
    const open = vi.fn();
    const { container } = mount("codex", open);
    const note = container.querySelector(".tl-terminal-note")!;
    expect(note.textContent).toContain("Codex replies in the Terminal view.");
    fireEvent.click(note.querySelector("button")!);
    expect(open).toHaveBeenCalledTimes(1);
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe(
      "Ask Codex, or run a command…",
    );
  });

  it("says a shell's output is in the Terminal, and asks for a command", () => {
    const { container } = mount("shell");
    expect(container.querySelector(".tl-terminal-note")!.textContent).toContain(
      "Output shows in the Terminal view.",
    );
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe("Run a command…");
  });

  it("adds no note where a transcript will answer", () => {
    const { container } = mount(undefined);
    expect(container.querySelector(".tl-terminal-note")).toBeNull();
    expect(container.querySelector("textarea")!.getAttribute("placeholder")).toBe(
      "Ask Claude, or run a command…",
    );
  });

  // The stream of a session with no transcript never opens (404), so the
  // empty conversation said "Loading the conversation…" for good.
  it("does not say the conversation is loading when there is none to load", () => {
    g.EventSource = class {
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    };
    const { container } = render(() => (
      <TextView
        session="demo"
        events={[]}
        pending={[]}
        onSend={async () => true}
        onStop={() => {}}
        onResolve={() => {}}
        noTranscript="codex"
        opening
      />
    ));
    expect(container.textContent).not.toContain("Loading the conversation");
    expect(container.textContent).toContain("No messages yet.");
  });
});
