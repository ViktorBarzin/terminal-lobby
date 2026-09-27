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
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";
import type { ClaudeState } from "../src/types/lobby";
import type { PendingPrompt } from "../src/logic/compose.logic";

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

type StopFn = (restoreQueue?: readonly string[]) => Promise<boolean> | void;

function mount(
  state: () => ClaudeState | undefined,
  onStop: ReturnType<typeof vi.fn<StopFn>> = vi.fn<StopFn>(),
  opts: {
    events?: Event[];
    inertReason?: string;
    onSend?: (t: string) => Promise<boolean>;
    pendingPrompts?: PendingPrompt[];
  } = {},
) {
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
      events={opts.events ?? RUNNING_TURN}
      pending={[]}
      onSend={opts.onSend ?? (async () => true)}
      onStop={onStop}
      onResolve={() => {}}
      claudeState={state}
      inertReason={opts.inertReason}
      pendingPrompts={() => opts.pendingPrompts ?? []}
    />
  ));
  const button = () => r.container.querySelector<HTMLButtonElement>(".tl-composer .tl-send")!;
  const field = () => r.container.querySelector<HTMLTextAreaElement>(".tl-composer textarea")!;
  return { ...r, button, field, onStop };
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  // The field saves its draft per session, and every test here is "demo".
  localStorage.clear();
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

/** Two prompts sent mid-turn that Claude queued: the ghosts at the end. */
const queued = (id: number, body: string): Event => ({
  id,
  kind: "meta",
  meta: "queued",
  session: "demo",
  body,
  at: 3_000 + id,
});
const WITH_GHOSTS: Event[] = [...RUNNING_TURN, queued(3, "first"), queued(4, "second\nline two")];

/**
 * Stop with queued messages puts them back into the field (the T3 pass, item
 * 8). The ghosts' texts go back as a draft, oldest first, separated by blank
 * lines, and nothing is sent. CLI 2.1.283 would otherwise run them as the next
 * turn on the interrupt, so the view names them to the server
 * (`onStop(texts)`), which takes them off Claude's queue first, and fills the
 * field only once the server says they came off.
 */
describe("<TextView>: Stop hands queued messages back to the field", () => {
  it("puts both ghosts' texts in the field and sends nothing", async () => {
    const onStop = vi.fn<StopFn>(async () => true);
    const onSend = vi.fn(async (_t: string) => true);
    const { button, field } = mount(() => "running", onStop, { events: WITH_GHOSTS, onSend });
    expect(button().dataset.kind).toBe("stop");

    fireEvent.click(button());

    expect(onStop).toHaveBeenCalledWith(["first", "second\nline two"]);
    await waitFor(() => expect(field().value).toBe("first\n\nsecond\nline two"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps what was typed while the Stop was in flight, after the handed-back text", async () => {
    let answer!: (v: boolean) => void;
    const onStop = vi.fn<StopFn>(() => new Promise<boolean>((r) => (answer = r)));
    const { button, field } = mount(() => "running", onStop, { events: WITH_GHOSTS });
    fireEvent.click(button());
    fireEvent.input(field(), { target: { value: "and one more" } });
    answer(true);
    await waitFor(() =>
      expect(field().value).toBe("first\n\nsecond\nline two\n\nand one more"),
    );
  });

  it("leaves the field alone when the server says the queue stayed", async () => {
    const onStop = vi.fn<StopFn>(async () => false);
    const { button, field } = mount(() => "running", onStop, { events: WITH_GHOSTS });
    fireEvent.click(button());
    await Promise.resolve();
    await Promise.resolve();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("");
  });

  it("with nothing queued, stops as it always did and leaves the field alone", async () => {
    const onStop = vi.fn<StopFn>();
    const { button, field } = mount(() => "running", onStop);
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]).toEqual([]);
    await Promise.resolve();
    expect(field().value).toBe("");
  });

  // Found in the live check on 2026-09-27: two sends 100ms apart, and the CLI
  // recorded only the second one's enqueue. The first was still held by the
  // store, so it came back, but after the second. Send order is the store's.
  it("keeps send order when a held prompt never reached the queue", async () => {
    const onStop = vi.fn<StopFn>(async () => true);
    const held = (id: number, text: string): PendingPrompt => ({
      id,
      text,
      at: 2_500,
      command: false,
      afterId: 2,
    });
    const { button, field } = mount(() => "running", onStop, {
      events: [...RUNNING_TURN, queued(3, "second\nline two")],
      pendingPrompts: [held(-1, "first"), held(-2, "second\nline two"), held(-3, "third")],
    });
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledWith(["first", "second\nline two", "third"]);
    await waitFor(() => expect(field().value).toBe("first\n\nsecond\nline two\n\nthird"));
  });

  it("unwraps a paste the CLI queued inside its pasted_content marker", async () => {
    const onStop = vi.fn<StopFn>(async () => true);
    const pasted = '<pasted_content id="bae7">\nline 1\nline 2\n</pasted_content id="bae7">';
    const { button, field } = mount(() => "running", onStop, {
      events: [...RUNNING_TURN, queued(3, pasted)],
    });
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledWith(["line 1\nline 2"]);
    await waitFor(() => expect(field().value).toBe("line 1\nline 2"));
  });

  it("does nothing on a watching device", async () => {
    const onStop = vi.fn<StopFn>(async () => true);
    const { button, field } = mount(() => "running", onStop, {
      events: WITH_GHOSTS,
      inertReason: "Watching: this device does not type into the session",
    });
    fireEvent.click(button());
    await Promise.resolve();
    expect(onStop).not.toHaveBeenCalled();
    expect(field().value).toBe("");
  });
});
