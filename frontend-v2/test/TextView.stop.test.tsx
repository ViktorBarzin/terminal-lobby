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
import type { StopResult } from "../src/store/session";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

/** A turn with a command still running: the transcript says working. */
const RUNNING_TURN: Event[] = [
  {
    id: 1,
    kind: "user",
    session: "demo",
    turnId: "t1",
    body: "list the files",
    at: 1_000,
  },
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

type StopFn = (
  restoreQueue?: readonly string[],
  returnPrompt?: string,
) => Promise<StopResult> | void;

const RESTORED: StopResult = { restored: true, returned: false };
const NOTHING: StopResult = { restored: false, returned: false };

function mount(
  state: () => ClaudeState | undefined,
  onStop: ReturnType<typeof vi.fn<StopFn>> = vi.fn<StopFn>(),
  opts: {
    events?: Event[];
    inertReason?: string;
    onSend?: (t: string) => Promise<boolean>;
    pendingPrompts?: PendingPrompt[];
    notify?: (message: string, kind: "info" | "error" | "warning" | "success") => void;
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
      notify={opts.notify}
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
    const onStop = vi.fn<StopFn>(async () => RESTORED);
    const onSend = vi.fn(async (_t: string) => true);
    const { button, field } = mount(() => "running", onStop, {
      events: WITH_GHOSTS,
      onSend,
    });
    expect(button().dataset.kind).toBe("stop");

    fireEvent.click(button());

    expect(onStop).toHaveBeenCalledWith(["first", "second\nline two"]);
    await waitFor(() => expect(field().value).toBe("first\n\nsecond\nline two"));
    expect(onSend).not.toHaveBeenCalled();
  });

  // Round 7 (2026-09-28): what came back was glued in front of words typed
  // while the Stop was in flight, and a quick Enter sent both as one prompt.
  // The typed words stay alone; the handed-back text waits for them to go.
  it("keeps words typed while the Stop was in flight alone, and hands back after they are sent", async () => {
    let answer!: (v: StopResult) => void;
    const onStop = vi.fn<StopFn>(() => new Promise<StopResult>((r) => (answer = r)));
    const onSend = vi.fn(async (_t: string) => true);
    const { button, field } = mount(() => "running", onStop, {
      events: WITH_GHOSTS,
      onSend,
    });
    fireEvent.click(button());
    fireEvent.input(field(), { target: { value: "and one more" } });
    answer(RESTORED);
    await Promise.resolve();
    await Promise.resolve();
    expect(field().value).toBe("and one more");
    fireEvent.click(button());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("and one more"));
    await waitFor(() => expect(field().value).toBe("first\n\nsecond\nline two"));
  });

  it("leaves the field alone when the server says the queue stayed", async () => {
    const onStop = vi.fn<StopFn>(async () => NOTHING);
    const { button, field } = mount(() => "running", onStop, {
      events: WITH_GHOSTS,
    });
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
    const onStop = vi.fn<StopFn>(async () => RESTORED);
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
    const onStop = vi.fn<StopFn>(async () => RESTORED);
    const pasted = '<pasted_content id="bae7">\nline 1\nline 2\n</pasted_content id="bae7">';
    const { button, field } = mount(() => "running", onStop, {
      events: [...RUNNING_TURN, queued(3, pasted)],
    });
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledWith(["line 1\nline 2"]);
    await waitFor(() => expect(field().value).toBe("line 1\nline 2"));
  });

  it("does nothing on a watching device", async () => {
    const onStop = vi.fn<StopFn>(async () => RESTORED);
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

// Found live on 2026-09-27: a message sent while a command ran stood in as a
// turn of its own at the end, so the running turn read as settled. Its work
// group said "stopped" with the command still running, the live group moved to
// the stand-in ("Working… 0s"), and the turn never folded. A message sent into
// an open turn waits behind it, which the prototype draws as a ghost.
describe("<TextView>: a message sent mid-turn waits as a ghost", () => {
  const held = (id: number, text: string, command = false): PendingPrompt => ({
    id,
    text,
    at: 2_500,
    command,
    afterId: 2,
  });

  it("draws it as a ghost and keeps the running group live", () => {
    const { container } = mount(() => "running", undefined, {
      pendingPrompts: [held(-1, "and then this")],
    });
    const ghosts = [...container.querySelectorAll(".tl-row-ghost .tl-ghost-text")].map(
      (g) => g.textContent,
    );
    expect(ghosts).toEqual(["and then this"]);
    expect(container.querySelector(".tl-group-box")?.getAttribute("data-live")).toBeTruthy();
    expect(container.querySelector(".tl-group-meta")?.textContent ?? "").not.toContain("stopped");
    const bubbles = [...container.querySelectorAll(".tl-row-user:not(.tl-row-ghost)")];
    expect(bubbles).toHaveLength(1);
  });

  it("draws it once when the queue has recorded it too", () => {
    const { container } = mount(() => "running", undefined, {
      events: [
        ...RUNNING_TURN,
        {
          id: 3,
          kind: "meta",
          meta: "queued",
          session: "demo",
          turnId: "t1",
          body: "and then this",
        },
      ],
      pendingPrompts: [held(-1, "and then this")],
    });
    expect(container.querySelectorAll(".tl-row-ghost")).toHaveLength(1);
  });

  it("draws a message sent between turns as the next turn", () => {
    const settled: Event[] = [
      ...RUNNING_TURN,
      {
        id: 3,
        kind: "tool_result",
        session: "demo",
        turnId: "t1",
        toolId: "b1",
        body: "a",
        at: 2_100,
      },
      {
        id: 4,
        kind: "text",
        session: "demo",
        turnId: "t1",
        body: "Done.",
        at: 2_200,
      },
      { id: 5, kind: "turn_end", session: "demo", turnId: "t1", at: 2_300 },
    ];
    const { container } = mount(() => "done", undefined, {
      events: settled,
      pendingPrompts: [{ ...held(-1, "next thing"), afterId: 5 }],
    });
    expect(container.querySelectorAll(".tl-row-ghost")).toHaveLength(0);
    const bubbles = [...container.querySelectorAll(".tl-row-user .tl-user-text")].map(
      (b) => b.textContent,
    );
    expect(bubbles.at(-1)).toBe("next thing");
  });
});

// Found in the T3 pass's live check on 2026-09-28: a Stop pressed in the first
// seconds after Send, before Claude had written anything, put the prompt back
// on the pane's own input line (CLI 2.1.283). The Text view showed it as a sent
// bubble with an empty field, and the next send erased the pane's copy. The
// view now names that prompt to the server (`onStop(queue, prompt)`), which
// takes it off the pane's line, and puts it back in the field when it came
// back. The bubble goes when the stream says the prompt was taken back.
describe("<TextView>: Stop before Claude answers hands the prompt back", () => {
  const OPENED: Event[] = [
    {
      id: 1,
      kind: "user",
      session: "demo",
      turnId: "t1",
      body: "Write a long story",
      at: 1_000,
    },
  ];
  const BOTH: StopResult = { restored: true, returned: true };

  it("names the prompt and puts it back in the field when it came back", async () => {
    const onStop = vi.fn<StopFn>(async () => ({
      restored: false,
      returned: true,
    }));
    const { button, field } = mount(() => "running", onStop, {
      events: OPENED,
    });
    expect(button().dataset.kind).toBe("stop");
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledWith(undefined, "Write a long story");
    await waitFor(() => expect(field().value).toBe("Write a long story"));
  });

  // Round 7 (2026-09-28), reproduced once in 9: Enter 300 ms after an early
  // Stop sent the new prompt while the server was still taking the stopped one
  // off the input line, and the new one was lost. A send waits for the Stop,
  // goes out with only its own words, and the stopped prompt comes back to
  // the field it left empty.
  it("holds a send pressed while the Stop is in flight until the prompt is back", async () => {
    let answer!: (v: StopResult) => void;
    const onStop = vi.fn<StopFn>(() => new Promise<StopResult>((r) => (answer = r)));
    const onSend = vi.fn(async (_t: string) => true);
    const { button, field } = mount(() => "running", onStop, {
      events: OPENED,
      onSend,
    });
    fireEvent.click(button());
    fireEvent.input(field(), { target: { value: "ping and reply ok2" } });
    fireEvent.click(button());
    await Promise.resolve();
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();
    answer({ restored: false, returned: true });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("ping and reply ok2"));
    expect(onSend).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(field().value).toBe("Write a long story"));
  });

  it("puts the stopped prompt back after the words typed meanwhile are sent", async () => {
    let answer!: (v: StopResult) => void;
    const onStop = vi.fn<StopFn>(() => new Promise<StopResult>((r) => (answer = r)));
    const onSend = vi.fn(async (_t: string) => true);
    const notify = vi.fn();
    const { button, field } = mount(() => "running", onStop, {
      events: OPENED,
      onSend,
      notify,
    });
    fireEvent.click(button());
    fireEvent.input(field(), { target: { value: "something else" } });
    answer({ restored: false, returned: true });
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(field().value).toBe("something else");
    fireEvent.click(button());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("something else"));
    await waitFor(() => expect(field().value).toBe("Write a long story"));
  });

  it("does not hold a send for good when the Stop never answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onStop = vi.fn<StopFn>(() => new Promise<StopResult>(() => {}));
      const onSend = vi.fn(async (_t: string) => true);
      const { button, field } = mount(() => "running", onStop, {
        events: OPENED,
        onSend,
      });
      fireEvent.click(button());
      fireEvent.input(field(), { target: { value: "hello" } });
      fireEvent.click(button());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onSend).toHaveBeenCalledWith("hello");
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the field alone when it did not come back", async () => {
    const onStop = vi.fn<StopFn>(async () => NOTHING);
    const { button, field } = mount(() => "running", onStop, {
      events: OPENED,
    });
    fireEvent.click(button());
    await Promise.resolve();
    await Promise.resolve();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(field().value).toBe("");
  });

  it("names nothing once Claude has started on it", () => {
    const onStop = vi.fn<StopFn>();
    const { button } = mount(() => "running", onStop);
    fireEvent.click(button());
    expect(onStop.mock.calls[0]).toEqual([]);
  });

  it("names a prompt sent between turns that the transcript has not recorded yet", async () => {
    const settled: Event[] = [
      ...OPENED,
      {
        id: 2,
        kind: "text",
        session: "demo",
        turnId: "t1",
        body: "Once upon a time.",
        at: 1_500,
      },
      { id: 3, kind: "turn_end", session: "demo", turnId: "t1", at: 1_600 },
    ];
    const onStop = vi.fn<StopFn>(async () => ({
      restored: false,
      returned: true,
    }));
    const { button, field } = mount(() => "running", onStop, {
      events: settled,
      pendingPrompts: [{ id: -1, text: "next thing", at: 2_000, command: false, afterId: 3 }],
    });
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledWith(undefined, "next thing");
    await waitFor(() => expect(field().value).toBe("next thing"));
  });

  // The queue race from the same check: the CLI had just taken the first
  // ghost as the next turn when Stop landed, so that one is the stopped turn's
  // prompt and the rest are still queued. Both come back, oldest first.
  it("hands back the stopped prompt before the ghosts", async () => {
    const onStop = vi.fn<StopFn>(async () => BOTH);
    const { button, field } = mount(() => "running", onStop, {
      events: [...OPENED, queued(2, "say PLUM")],
    });
    fireEvent.click(button());
    expect(onStop).toHaveBeenCalledWith(["say PLUM"], "Write a long story");
    await waitFor(() => expect(field().value).toBe("Write a long story\n\nsay PLUM"));
  });
});
