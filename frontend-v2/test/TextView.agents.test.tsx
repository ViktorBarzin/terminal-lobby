/**
 * The text view puts the agent panel in the right margin of the reading
 * column, and only while the session actually owes work (the presence rule in
 * agents.logic): something in the set is running AND either the turn is open
 * or the session list still counts background work.
 *
 * The background note beside the composer's model button ("2 agents") says
 * what the panel already shows, so it is left out while the panel is, and says
 * it as before whenever the panel is absent. It was a strip between the
 * timeline and the composer until the Quiet line moved it onto the status line
 * (2026-09-24), and the T3 pass (2026-09-27) moved it into the box's row.
 *
 * An open turn is a user record with nothing settling it: the text view reads
 * the turn off the transcript rather than taking a `working` flag.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { TextView } from "../src/components/TextView";
import type { AgentSnapshot } from "../src/components/agents.logic";
import type { AgentInfo, Event, WorkflowInfo } from "../src/types/events";
import type { BackgroundWork, SessionTool } from "../src/types/lobby";

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

/** A turn the transcript has opened and not settled. */
const OPEN_TURN: Event[] = [{ id: 1, kind: "user", session: "demo", turnId: "t1", body: "go" }];

const snap = (agents: AgentInfo[], workflows: WorkflowInfo[] = []): AgentSnapshot => ({
  set: { at: T0, agents, workflows },
  skew: 0,
});

function mount(opts: {
  agents?: AgentSnapshot | null;
  working?: boolean;
  bg?: BackgroundWork;
  tool?: SessionTool;
}) {
  const [agents, setAgents] = createSignal<AgentSnapshot | null>(opts.agents ?? null);
  const [bg, setBg] = createSignal<BackgroundWork | undefined>(opts.bg);
  const [tool, setTool] = createSignal<SessionTool | undefined>(opts.tool);
  const r = render(() => (
    <TextView
      events={opts.working ? OPEN_TURN : []}
      background={bg}
      agents={agents}
      tool={tool}
      pending={[]}
      onSend={async () => true}
      onStop={() => {}}
      onResolve={() => {}}
    />
  ));
  return {
    ...r,
    setAgents,
    setBg,
    setTool,
    panel: () => r.container.querySelector(".tl-agents"),
    strip: () =>
      r.container.querySelector('.tl-box-note[data-kind="background"] .tl-box-note-target'),
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

  // The composer and the cards docked in its place sit below the transcript
  // and the rail both, so they span the whole view. Without being told the
  // rail is there they centred on the whole width, 140px right of the
  // conversation's column (seen at 2000px on 2026-09-30).
  it("tells the view the rail takes the right margin, so the dock centres on the column", () => {
    const v = mount({ agents: snap([agent("a1")]), working: true });
    const view = v.container.querySelector(".tl-textview");
    expect(view?.getAttribute("data-rail")).toBe("true");
    // The margin is permanent on a wide view, so the dock stays where it is
    // when the agents go (Viktor, 2026-10-03).
    v.setAgents(null);
    expect(view?.getAttribute("data-rail")).toBe("true");
  });

  // Agents coming and going used to add and remove a 280px column, which
  // moved the whole conversation sideways on desktop (Viktor, 2026-10-03).
  // The margin now stays, empty, so nothing beside it moves.
  it("keeps an empty margin where the panel goes, so the column never shifts", () => {
    const v = mount({ agents: null });
    const timeline = v.container.querySelector(".tl-timeline");
    const empty = () => v.container.querySelector(".tl-rail-empty");
    expect(v.panel()).toBeNull();
    expect(empty()?.parentElement).toBe(timeline?.parentElement);
    v.setAgents(snap([agent("a1")]));
    v.setBg({ agents: 1 });
    expect(v.panel()).not.toBeNull();
    expect(empty()).toBeNull();
    v.setAgents(null);
    v.setBg(undefined);
    expect(v.panel()).toBeNull();
    expect(empty()).not.toBeNull();
  });

  it("stays while the session list still counts the agent after the turn closed", () => {
    const v = mount({ agents: snap([agent("a1")]), working: false, bg: { agents: 1 } });
    expect(v.panel()).not.toBeNull();
  });

  it("stays for an agent waiting on its own background work, and goes with the session's claude", () => {
    const v = mount({
      agents: snap([agent("a1", { waiting: true })]),
      working: false,
      tool: "claude",
    });
    expect(v.panel()).not.toBeNull();
    v.setTool("shell");
    expect(v.panel()).toBeNull();
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

/** What the background note names as still running. */
const STRIP = (what: string): string => what;

describe("the background line, folded into the panel", () => {
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
    expect(v.strip()?.textContent ?? null).toBe(want);
  });

  it("gives way to the panel and comes back when the panel goes", () => {
    // Before the first `agents` frame, the strip as it always was.
    const v = mount({ agents: null, working: false, bg: { agents: 1 } });
    expect(v.strip()?.textContent).toBe(STRIP("1 agent"));
    // The set arrives with the agent running, and the panel says it instead.
    v.setAgents(snap([agent("a1")]));
    expect(v.panel()).not.toBeNull();
    expect(v.strip()).toBeNull();
    // The agent's transcript ends a few seconds before the session list
    // retires it: the panel goes, and the list still counts the agent.
    v.setAgents(snap([done]));
    expect(v.panel()).toBeNull();
    expect(v.strip()?.textContent).toBe(STRIP("1 agent"));
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
      // A strip takes no margin, so the dock keeps the whole width.
      expect(v.container.querySelector(".tl-textview")?.hasAttribute("data-rail")).toBe(false);
      // And with nothing running, a narrow view keeps no empty margin either.
      v.setAgents(null);
      v.setBg(undefined);
      expect(v.container.querySelector(".tl-rail-empty")).toBeNull();
    });
  });
});
