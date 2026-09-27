/**
 * The Text view hands the composer the session's hook state, and Stop needs it.
 *
 * The transcript's live row lags the pane (a `done` session showed Stop in 98
 * of 100 samples), and Stop sends a C-c that exits an idle Claude when it
 * lands twice. So the round button offers Stop only when the hook-stamped
 * state from the session list agrees that the session is running
 * (Composer.queue.test.tsx has the button's own rules).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";
import type { ClaudeState } from "../src/types/lobby";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

/** A turn with a command still running: the transcript says working. */
const RUNNING_TURN: Event[] = [
  { id: 1, kind: "user", session: "demo", turnId: "t1", body: "list the files", at: 1_000 },
  {
    id: 2,
    kind: "tool_use",
    session: "demo",
    turnId: "t1",
    tool: "Bash",
    toolId: "b1",
    body: JSON.stringify({ command: "ls" }),
    at: 2_000,
  },
];

function mount(state: () => ClaudeState | undefined, onStop = vi.fn()) {
  g.EventSource = class {
    onopen = null;
    onerror = null;
    onmessage = null;
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  };
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const r = render(() => (
    <TextView
      session="demo"
      events={RUNNING_TURN}
      pending={[]}
      onSend={async () => true}
      onStop={onStop}
      onResolve={() => {}}
      claudeState={state}
    />
  ));
  const button = () => r.container.querySelector<HTMLButtonElement>(".tl-composer .tl-send")!;
  return { ...r, button, onStop };
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
});

describe("<TextView>: Stop follows the session's hook state", () => {
  it("offers Stop while the session is running and the turn is open", () => {
    const { button, onStop } = mount(() => "running");
    expect(button().dataset.kind).toBe("stop");
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("offers no Stop once the session says done, though the transcript still runs", () => {
    const [state, setState] = createSignal<ClaudeState | undefined>("running");
    const { button } = mount(state);
    expect(button().dataset.kind).toBe("stop");
    setState("done");
    expect(button().dataset.kind).toBe("send");
    expect(button().disabled).toBe(true);
  });

  it("offers no Stop where nothing reports the hook state", () => {
    const { button } = mount(() => undefined);
    expect(button().dataset.kind).toBe("send");
  });
});
