/**
 * ↑ in the Text view takes the queued messages back into the field to edit,
 * as Claude Code's own box does. session-events holds them behind the turn
 * (session-events/held.go) and hands back every one it held, oldest first,
 * which may include one another device sent. They land as one draft, blank
 * lines between them, and nothing is sent until the reader presses Enter.
 * When nothing comes back (the turn just ended and sent them), ↑ recalls
 * history as it always did.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { TextView } from "../src/components/TextView";
import type { Event } from "../src/types/events";
import type { StopResult } from "../src/store/session";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

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
const queued = (id: number, body: string): Event => ({
  id,
  kind: "meta",
  meta: "queued",
  session: "demo",
  body,
  at: 3_000 + id,
});
const WITH_GHOSTS: Event[] = [...RUNNING_TURN, queued(3, "first"), queued(4, "second\nline two")];

type StopFn = (
  restoreQueue?: readonly string[],
  returnPrompt?: string,
) => Promise<StopResult> | void;

function mount(opts: {
  events?: Event[];
  onUnqueue?: () => Promise<string[]>;
  onStop?: StopFn;
  onSend?: (t: string) => Promise<boolean>;
  inertReason?: string;
}) {
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
      events={opts.events ?? WITH_GHOSTS}
      pending={[]}
      onSend={opts.onSend ?? (async () => true)}
      onStop={opts.onStop ?? (() => {})}
      onUnqueue={opts.onUnqueue}
      onResolve={() => {}}
      claudeState={() => "running"}
      inertReason={opts.inertReason}
      pendingPrompts={() => []}
    />
  ));
  const field = () => r.container.querySelector<HTMLTextAreaElement>(".tl-composer textarea")!;
  const button = () => r.container.querySelector<HTMLButtonElement>(".tl-composer .tl-send")!;
  return { ...r, field, button };
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("<TextView>: ↑ edits the queued messages", () => {
  it("takes them back into the field as one draft and sends nothing", async () => {
    const onUnqueue = vi.fn(async () => ["first", "second\nline two"]);
    const onSend = vi.fn(async (_t: string) => true);
    const { field } = mount({ onUnqueue, onSend });
    expect(field().placeholder).toBe("Press ↑ to edit queued messages");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    await waitFor(() => expect(field().value).toBe("first\n\nsecond\nline two"));
    expect(onUnqueue).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("puts in what the server held, which can be more than this view showed", async () => {
    const { field } = mount({
      onUnqueue: async () => ["from the phone", "first", "second\nline two"],
    });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    await waitFor(() => expect(field().value).toBe("from the phone\n\nfirst\n\nsecond\nline two"));
  });

  // The reader asked for them and is looking at the field, so an edit and a
  // quick Enter send the field as it reads (unlike a Stop's hand-back).
  it("sends the edited draft whole, however quickly Enter follows", async () => {
    const onSend = vi.fn(async (_t: string) => true);
    const { field } = mount({
      onUnqueue: async () => ["first"],
      onSend,
      events: [...RUNNING_TURN, queued(3, "first")],
    });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    await waitFor(() => expect(field().value).toBe("first"));
    fireEvent.input(field(), { target: { value: "first, but better" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("first, but better"));
  });

  it("recalls history when nothing came back", async () => {
    const { field } = mount({ onUnqueue: async () => [] });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    await waitFor(() => expect(field().value).toBe("list the files"));
  });

  it("leaves ↑ to history with nothing queued", async () => {
    const onUnqueue = vi.fn(async () => ["x"]);
    const { field } = mount({ onUnqueue, events: RUNNING_TURN });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(field().value).toBe("list the files");
    expect(onUnqueue).not.toHaveBeenCalled();
  });

  it("does nothing on a watching device", async () => {
    const onUnqueue = vi.fn(async () => ["first"]);
    const { field } = mount({
      onUnqueue,
      inertReason: "Watching: this device does not type into the session",
    });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    await Promise.resolve();
    expect(onUnqueue).not.toHaveBeenCalled();
  });
});

describe("<TextView>: Stop hands back what the server took", () => {
  it("fills the field from the server's queue when the reply names it", async () => {
    const onStop = vi.fn<StopFn>(async () => ({
      restored: true,
      returned: false,
      queue: ["from the phone", "first"],
    }));
    const { button, field } = mount({ onStop, events: [...RUNNING_TURN, queued(3, "first")] });
    fireEvent.click(button());
    await waitFor(() => expect(field().value).toBe("from the phone\n\nfirst"));
  });
});
