/**
 * Steering: with an agent open in the drill-in, the composer messages that
 * agent, not the main thread (Viktor, 2026-10-03). A finished agent is read
 * only, and a message waits as a dimmed bubble until the agent reads it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AgentSnapshot } from "../src/components/agents.logic";
import type { AgentInfo, Event } from "../src/types/events";

const g = globalThis as unknown as { EventSource: unknown };
const realES = g.EventSource;

function installEventSource(): void {
  g.EventSource = class {
    onopen = null;
    onerror = null;
    onmessage = null;
    constructor(public url: string) {}
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  };
}

const T0 = 1_790_000_000_000;
const agent = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "a1",
  description: "count to five",
  name: "",
  agentType: "",
  model: "",
  color: "blue",
  depth: 1,
  parentId: "",
  toolUseId: "",
  workflowId: "",
  phaseIndex: 0,
  label: "",
  state: "running",
  startedAt: T0,
  lastActivityAt: T0,
  endedAt: 0,
  tool: "Bash",
  toolDetail: "",
  toolCalls: 1,
  outputTokens: 10,
  result: "",
  steerable: true,
  ...over,
});

const SESSION: Event[] = [
  { id: 1, kind: "user", session: "demo", turnId: "t1", body: "spawn an agent" },
  { id: 2, kind: "text", session: "demo", turnId: "t1", body: "On it." },
];

function mount(a: AgentInfo, status = 204, body = "") {
  let setAgents!: (v: AgentSnapshot | null) => void;
  installEventSource();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const posts: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push({ url, body: String(init.body) });
      return new Response(status === 204 ? null : body, { status });
    }),
  );
  const onSend = vi.fn(async () => true);
  const [agents, set] = createSignal<AgentSnapshot | null>({
    set: { at: T0, agents: [a], workflows: [] },
    skew: 0,
  });
  setAgents = set;
  const update = (next: AgentInfo) =>
    setAgents({ set: { at: T0, agents: [next], workflows: [] }, skew: 0 });
  const r = render(() => (
    <TextView
      session="demo"
      events={SESSION}
      agents={agents}
      pending={[]}
      onSend={onSend}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));
  const open = () =>
    fireEvent.click(r.container.querySelector("[data-agent] button.tl-agent-open")!);
  const field = () => r.getByLabelText("Message to send to the agent") as HTMLTextAreaElement;
  const send = (text: string) => {
    const ta = field();
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const buttons = r.container.querySelectorAll<HTMLButtonElement>(".tl-send");
    buttons[buttons.length - 1]!.click();
  };
  return { ...r, open, field, send, posts, onSend, update };
}

afterEach(() => {
  g.EventSource = realES;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the composer while an agent is open", () => {
  it("sends to the agent, not the main thread", async () => {
    const v = mount(agent());
    v.open();
    expect(v.field().placeholder).toBe("Message count to five…");
    v.send("stop and report");
    await waitFor(() => expect(v.posts).toHaveLength(1));
    expect(v.posts[0]!.url).toContain("/events/demo/agents/a1/message");
    expect(JSON.parse(v.posts[0]!.body)).toEqual({ text: "stop and report" });
    expect(v.onSend).not.toHaveBeenCalled();
    // It waits on screen until the agent's transcript shows it.
    await waitFor(() =>
      expect(v.container.querySelector(".tl-steer-wait")?.textContent).toBe(
        "Waiting for the agent to read it",
      ),
    );
  });

  it("goes back to the main thread on Back", () => {
    const v = mount(agent());
    v.open();
    fireEvent.click(v.container.querySelector(".tl-drill-back")!);
    expect(v.queryByLabelText("Message to send to the agent")).toBeNull();
    expect(v.getByLabelText("Message to send to the session")).toBeTruthy();
  });

  it("turns read-only once the agent finishes, after the set has held for 2 s", async () => {
    const v = mount(agent());
    v.open();
    v.update(agent({ state: "done", steerable: false, steerNote: "finished" }));
    // Not at once: a set that wavers for a frame must not grey out the field.
    expect(v.container.querySelector(".tl-watch-word")).toBeNull();
    await waitFor(
      () => expect(v.container.querySelector(".tl-watch-word")?.textContent).toBe("Finished"),
      { timeout: 3500 },
    );
  });

  it("stays usable when the set wavers for less than 2 s", async () => {
    const v = mount(agent());
    v.open();
    v.update(agent({ steerable: false, steerNote: "finished" }));
    v.update(agent());
    await new Promise((r) => setTimeout(r, 2300));
    expect(v.container.querySelector(".tl-watch-word")).toBeNull();
  });

  it("puts the words back and turns read-only when the agent has finished meanwhile", async () => {
    const v = mount(agent(), 409, "this agent has finished");
    v.open();
    v.send("too late");
    await waitFor(() => expect(v.posts).toHaveLength(1));
    await waitFor(() =>
      expect(v.container.querySelector(".tl-watch-word")?.textContent).toBe("Read-only"),
    );
    expect(v.container.querySelector(".tl-steer-wait")).toBeNull();
  });
});
