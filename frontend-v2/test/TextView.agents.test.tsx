/**
 * The text view puts the agent panel in the right margin of the reading
 * column, and only while the session actually owes work (the presence rule in
 * agents.logic): something in the set is running AND either the turn is open
 * or the session list still counts background work.
 *
 * The strip under the timeline, "Still working in the background: 2 agents",
 * says what the panel already shows, so it is not drawn while the panel is,
 * and is drawn exactly as before whenever the panel is absent.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AgentSnapshot } from "../src/components/agents.logic";
import type { AgentInfo, WorkflowInfo } from "../src/types/events";
import type { BackgroundWork } from "../src/types/lobby";

const T0 = 1_790_000_000_000;

const agent = (id: string, over: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  description: `agent ${id}`,
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
  tool: "Read",
  toolDetail: "",
  toolCalls: 1,
  outputTokens: 10,
  result: "",
  ...over,
});

const workflow = (id: string, over: Partial<WorkflowInfo> = {}): WorkflowInfo => ({
  id,
  name: "review",
  summary: "Review the change",
  state: "running",
  startedAt: T0,
  endedAt: 0,
  phases: [{ index: 1, title: "Read", detail: "" }],
  currentPhase: 1,
  agentCount: 0,
  tokens: 0,
  toolCalls: 0,
  ...over,
});

const snap = (agents: AgentInfo[], workflows: WorkflowInfo[] = []): AgentSnapshot => ({
  set: { at: T0, agents, workflows },
  skew: 0,
});

function mount(opts: { agents?: AgentSnapshot | null; working?: boolean; bg?: BackgroundWork }) {
  const [agents, setAgents] = createSignal<AgentSnapshot | null>(opts.agents ?? null);
  const [working, setWorking] = createSignal(opts.working ?? false);
  const [bg, setBg] = createSignal<BackgroundWork | undefined>(opts.bg);
  const r = render(() => (
    <TextView
      events={[]}
      working={working()}
      background={bg}
      agents={agents}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));
  return {
    ...r,
    setAgents,
    setWorking,
    setBg,
    panel: () => r.container.querySelector(".tl-agents"),
    strip: () => r.container.querySelector(".tl-bg-strip"),
  };
}

describe("the agent panel in the text view", () => {
  it("sits beside the transcript while an agent runs in an open turn", () => {
    const v = mount({ agents: snap([agent("a1")]), working: true });
    const panel = v.panel();
    expect(panel).not.toBeNull();
    // The margin of the reading column: a sibling of the timeline, not a row
    // inside it and not something laid over it.
    const timeline = v.container.querySelector(".tl-timeline");
    expect(panel?.parentElement).toBe(timeline?.parentElement);
    expect(panel?.getAttribute("data-form")).toBe("rail");
  });

  it("stays while the session list still counts the agent after the turn closed", () => {
    const v = mount({ agents: snap([agent("a1")]), working: false, bg: { agents: 1 } });
    expect(v.panel()).not.toBeNull();
  });

  it("is absent when nothing says the session still owes work", () => {
    const v = mount({ agents: snap([agent("a1")]), working: false });
    expect(v.panel()).toBeNull();
  });

  it("disappears entirely once nothing is running", () => {
    const v = mount({ agents: snap([agent("a1")]), working: true });
    expect(v.panel()).not.toBeNull();
    v.setAgents(snap([agent("a1", { state: "done", endedAt: T0 + 5000 })]));
    expect(v.panel()).toBeNull();
  });

  it("is absent against a server that never sends the set", () => {
    const v = mount({ agents: null, working: true, bg: { agents: 2 } });
    expect(v.panel()).toBeNull();
  });
});

/** The strip as it has been drawn since 2026-09-04, markup and all. */
const STRIP = (what: string): string =>
  '<div class="tl-bg-strip" role="status">' +
  '<span class="tl-state-dot tl-state-running" aria-hidden="true"></span>' +
  `Still working in the background: ${what}</div>`;

describe("the background strip, folded into the panel", () => {
  it.each<[string, AgentSnapshot, BackgroundWork]>([
    ["an agent running", snap([agent("a1")]), { agents: 1 }],
    ["a workflow before its first member", snap([], [workflow("wf_1")]), { workflows: 1 }],
    [
      "an agent and a workflow running",
      snap([agent("a1"), agent("m1", { workflowId: "wf_1" })], [workflow("wf_1")]),
      { agents: 1, workflows: 1 },
    ],
  ])("is not drawn while the panel shows %s after the turn closed", (_what, agents, bg) => {
    const v = mount({ agents, working: false, bg });
    expect(v.panel()).not.toBeNull();
    expect(v.strip()).toBeNull();
  });

  const done = agent("a1", { state: "done", endedAt: T0 + 5000 });
  const killed = snap(
    [agent("m1", { workflowId: "wf_1" })],
    [workflow("wf_1", { state: "killed", endedAt: T0 + 5000 })],
  );
  it.each<[string, AgentSnapshot | null, boolean, BackgroundWork | undefined, string | null]>([
    ["against a server that never sends the set", null, false, { agents: 2 }, STRIP("2 agents")],
    [
      "when no agent transcript could be read",
      snap([]),
      false,
      { agents: 1, workflows: 1 },
      STRIP("1 agent, 1 workflow"),
    ],
    ["when everything in the set has ended", snap([done]), false, { agents: 1 }, STRIP("1 agent")],
    [
      "when the only run in the set was killed",
      killed,
      false,
      { workflows: 1 },
      STRIP("1 workflow"),
    ],
    ["while a turn is open", null, true, { agents: 1 }, null],
    [
      "when the session owes nothing",
      snap([agent("a1")]),
      false,
      { agents: 0, workflows: 0 },
      null,
    ],
    ["when the session list says nothing", null, false, undefined, null],
  ])("is unchanged %s", (_what, agents, working, bg, want) => {
    const v = mount({ agents, working, bg });
    expect(v.panel()).toBeNull();
    expect(v.strip()?.outerHTML ?? null).toBe(want);
  });

  it("gives way to the panel and comes back when the panel goes", () => {
    // Before the first `agents` frame, the strip as it always was.
    const v = mount({ agents: null, working: false, bg: { agents: 1 } });
    expect(v.strip()?.outerHTML).toBe(STRIP("1 agent"));
    // The set arrives with the agent running, and the panel says it instead.
    v.setAgents(snap([agent("a1")]));
    expect(v.panel()).not.toBeNull();
    expect(v.strip()).toBeNull();
    // The agent's transcript ends a few seconds before the session list
    // retires it: the panel goes, and the list still counts the agent.
    v.setAgents(snap([done]));
    expect(v.panel()).toBeNull();
    expect(v.strip()?.outerHTML).toBe(STRIP("1 agent"));
    v.setBg(undefined);
    expect(v.strip()).toBeNull();
  });

  describe("when the view is too narrow for the margin", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("is not drawn under the panel's strip above the transcript either", () => {
      const seen: { target: Element; fire: () => void }[] = [];
      class FakeRO {
        private cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
        }
        observe(target: Element) {
          seen.push({ target, fire: () => this.cb() });
        }
        unobserve() {}
        disconnect() {}
      }
      vi.stubGlobal("ResizeObserver", FakeRO);
      const v = mount({ agents: snap([agent("a1")]), working: false, bg: { agents: 1 } });
      // jsdom lays nothing out, so the view's clientWidth is 0: narrow, once
      // its observer reports.
      for (const o of seen) if (o.target.classList.contains("tl-textview-body")) o.fire();
      expect(v.panel()?.getAttribute("data-form")).toBe("strip");
      expect(v.strip()).toBeNull();
    });
  });
});
