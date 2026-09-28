/**
 * A session with no transcript here: a plain shell, or Codex, which
 * session-events does not register. Deployed review round 1 (2026-09-28): a
 * command sent from a shell's Text view ran in the shell, and the view drew
 * the bubble under a "Working…" row that counted for as long as the view was
 * open, saying "Claude is working" to a screen reader. Nothing can end that
 * row, because no transcript will ever record the prompt.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { PendingPrompt } from "../src/logic/compose.logic";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

const SENT: PendingPrompt[] = [
  { id: -1, text: "echo rv-hello-from-text", at: Date.now(), command: false, afterId: 0 },
];

function mount(noTranscript: boolean) {
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
    const { container } = mount(true);
    expect(container.textContent).toContain("echo rv-hello-from-text");
    expect(container.querySelector(".tl-row-live")).toBeNull();
    expect(container.textContent).not.toContain("Working");
    expect(container.textContent).not.toContain("Claude is working");
  });

  it("keeps the live row where a transcript will answer", () => {
    const { container } = mount(false);
    expect(container.textContent).toContain("Working");
  });
});
