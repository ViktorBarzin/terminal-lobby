/**
 * The drill-in: one agent's own transcript, read in the session's place
 * (design step 6, "an agent's inner conversation reads correctly, including
 * its thinking and tool payloads"). It is the session timeline's own
 * rendering, with nothing folded: an agent is one long turn, and its work is
 * what the reader opened it for. The header names the agent in the words its
 * panel entry used, and carries the way back.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { AgentTranscript } from "../src/components/AgentTranscript";
import type { AgentInfo, WorkflowInfo } from "../src/types/events";

interface Fake {
  url: string;
  closed: boolean;
  onopen: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  emit: (type: string, data: unknown) => void;
}

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;
const sources: Fake[] = [];

function installEventSource(): void {
  sources.length = 0;
  g.EventSource = class {
    closed = false;
    onopen: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    private readonly listeners: Record<string, ((ev: { data: string }) => void)[]> = {};
    constructor(public url: string) {
      sources.push(this as unknown as Fake);
    }
    close(): void {
      this.closed = true;
    }
    addEventListener(type: string, fn: (ev: { data: string }) => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type: string, data: unknown): void {
      for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) });
    }
    removeEventListener(): void {}
  };
}

/** Frames run when the test says so, after the handler that asked for one. */
const frames = new Map<number, () => void>();
let nextFrame = 0;
function stubFrames(): void {
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (h: number) => frames.delete(h));
}
function frame(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb();
}

const T0 = 1_790_000_000_000;
const S = 1000;

function info(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "a1",
    description: "Read the notes",
    name: "reader",
    agentType: "general-purpose",
    model: "claude-opus-5-5",
    color: "green",
    depth: 1,
    parentId: "",
    toolUseId: "tu-spawn",
    workflowId: "",
    phaseIndex: 0,
    label: "",
    state: "running",
    startedAt: T0,
    lastActivityAt: T0 + 20 * S,
    endedAt: 0,
    tool: "Read",
    toolDetail: "/tmp/notes.txt",
    toolCalls: 3,
    outputTokens: 4200,
    result: "",
    ...over,
  };
}

const ev = (id: number, kind: string, over: Record<string, unknown> = {}) => ({
  id,
  kind,
  session: "demo",
  turnId: "t1",
  ...over,
});

/** The agent's own transcript as the server streams it: the prompt it was
 *  given, a thought, a tool call and its result, and its answer. */
const WORK = [
  ev(1, "user", { body: "Read /tmp/notes.txt and report what it says." }),
  ev(2, "thinking", { body: "The notes are short.\nOne read will do." }),
  ev(3, "tool_use", {
    tool: "Bash",
    toolId: "tu1",
    body: JSON.stringify({ command: "cat /tmp/notes.txt" }),
  }),
  ev(4, "tool_result", { toolId: "tu1", body: "first line\nsecond line" }),
  ev(5, "text", { body: "The notes hold two lines." }),
  ev(6, "turn_end"),
];

function mount(
  over: {
    info?: AgentInfo;
    /** The panel's newest word on the agent, as it changes. */
    live?: () => AgentInfo;
    run?: WorkflowInfo;
    parked?: () => boolean;
  } = {},
) {
  installEventSource();
  stubFrames();
  const onBack = vi.fn();
  const r = render(() => (
    <AgentTranscript
      session="demo"
      agent="a1"
      info={over.live ? over.live() : (over.info ?? info())}
      run={over.run}
      skew={0}
      parked={over.parked?.() ?? false}
      onBack={onBack}
    />
  ));
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => r.container.querySelector<T>(sel);
  const all = (sel: string) => [...r.container.querySelectorAll<HTMLElement>(sel)];
  return { ...r, onBack, q, all, src: () => sources[sources.length - 1]! };
}

/** The opening exchange: the history, then ready. */
function open(src: Fake, events = WORK): void {
  src.onopen?.({});
  src.emit("state", {});
  for (const e of [...events].reverse()) src.emit("back", e);
  src.emit("ready", { head: events.length, cursor: 0, epoch: "e1" });
  frame();
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the drill-in reads the agent's own transcript", () => {
  it("opens the agent's stream under the session's own events route", () => {
    const v = mount();
    expect(v.src().url).toBe("/events/demo/agents/a1?rev=1");
  });

  it("draws the agent's work unfolded: prompt, thought, tool call, answer", () => {
    const v = mount();
    open(v.src());
    expect(v.q(".tl-row-user")?.textContent).toContain("Read /tmp/notes.txt");
    expect(v.all(".tl-row-thinking")).toHaveLength(1);
    expect(v.all(".tl-row-tool")).toHaveLength(1);
    expect(v.q(".tl-row-message")?.textContent).toContain("The notes hold two lines.");
    // A settled session turn folds behind "Worked for …"; an agent's does not.
    expect(v.all(".tl-row-fold")).toHaveLength(0);
    expect(v.q(".tl-row-earlier")?.textContent).toBe("Start of this agent's transcript");
  });

  it("opens its thinking and its tool payload the way a session's rows open", () => {
    const v = mount();
    open(v.src());
    fireEvent.click(v.q("button.tl-thinking-head")!);
    expect(v.q(".tl-thinking-body")?.textContent).toContain("One read will do.");
    fireEvent.click(v.q("button.tl-tool-toggle")!);
    const tool = v.q(".tl-row-tool")!;
    expect(tool.textContent).toContain("cat /tmp/notes.txt");
    expect(tool.textContent).toContain("second line");
  });

  it("keeps what arrives live after the opening, in order", () => {
    const v = mount({ info: info() });
    open(v.src(), WORK.slice(0, 2));
    v.src().onmessage?.({
      data: JSON.stringify(
        ev(3, "tool_use", {
          tool: "Bash",
          toolId: "tu1",
          body: JSON.stringify({ command: "sleep 20" }),
        }),
      ),
    });
    frame();
    expect(v.q(".tl-row-tool")?.textContent).toContain("sleep 20");
    // Still running: the timeline says so rather than folding it away.
    expect(v.all(".tl-row-working")).toHaveLength(1);
  });

  it("says so when the agent has nothing on disk to read yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no such agent in this session", { status: 404 })),
    );
    const v = mount();
    v.src().onerror?.({});
    await vi.waitFor(() => expect(v.q(".tl-drill-missing")).not.toBeNull());
    expect(v.q(".tl-drill-missing")?.getAttribute("role")).toBe("status");
    expect(v.q(".tl-timeline")).toBeNull();
  });

  it("parks with the session's stream and comes back when it does", () => {
    const [parked, setParked] = createSignal(false);
    const v = mount({ parked });
    open(v.src());
    const first = v.src();
    setParked(true);
    expect(first.closed).toBe(true);
    setParked(false);
    expect(sources).toHaveLength(2);
    expect(v.src().url).toContain("lastEventId=6");
  });
});

describe("the drill-in's header", () => {
  it("names the agent in the words its panel entry used", () => {
    vi.spyOn(Date, "now").mockReturnValue(T0 + 75 * S);
    const v = mount();
    expect(v.q(".tl-drill-kind-name")?.textContent).toBe("Agent");
    expect(v.all(".tl-drill-tag").map((t) => t.textContent)).toEqual(["reader", "general-purpose"]);
    expect(v.q(".tl-drill-title")?.textContent).toBe("Read the notes");
    expect(v.q(".tl-drill-meta")?.textContent).toBe(
      "claude-opus-5-5 · 3 tool calls · 4.2k tokens · 1m 15",
    );
    expect(v.q<HTMLElement>(".tl-drill-id")?.style.getPropertyValue("--spine")).toBe(
      "var(--tl-agent-green)",
    );
  });

  it("stops the clock where the agent ended, and says how it ended", () => {
    vi.spyOn(Date, "now").mockReturnValue(T0 + 300 * S);
    const v = mount({ info: info({ state: "failed", endedAt: T0 + 90 * S }) });
    expect(v.q(".tl-drill-meta")?.textContent).toBe(
      "claude-opus-5-5 · 3 tool calls · 4.2k tokens · 1m 30 · failed",
    );
  });

  it("keeps the header's figures current while the agent works", () => {
    vi.spyOn(Date, "now").mockReturnValue(T0 + 30 * S);
    const [now, setNow] = createSignal(info({ model: "", toolCalls: 0, outputTokens: 0 }));
    const v = mount({ live: now });
    expect(v.q(".tl-drill-meta")?.textContent).toBe("0 tool calls · 0 tokens · 30s");
    setNow(info({ toolCalls: 5, outputTokens: 702 }));
    expect(v.q(".tl-drill-meta")?.textContent).toBe(
      "claude-opus-5-5 · 5 tool calls · 702 tokens · 30s",
    );
    setNow(info({ toolCalls: 5, outputTokens: 702, state: "failed", endedAt: T0 + 20 * S }));
    expect(v.q(".tl-drill-meta")?.textContent).toBe(
      "claude-opus-5-5 · 5 tool calls · 702 tokens · 20s · failed",
    );
  });

  it("calls a workflow member by its label, under the run's kind", () => {
    const v = mount({
      info: info({ workflowId: "wf_1", label: "frontend source", name: "", color: "" }),
    });
    expect(v.q(".tl-drill-kind-name")?.textContent).toBe("Workflow agent");
    expect(v.q(".tl-drill-title")?.textContent).toBe("frontend source");
  });

  it("puts the way back first, with the focus on it", () => {
    const v = mount();
    const back = v.q<HTMLButtonElement>("button.tl-drill-back")!;
    expect(back.textContent).toContain("Back to session");
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(v.onBack).toHaveBeenCalledTimes(1);
  });
});
