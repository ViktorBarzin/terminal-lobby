/**
 * The agent panel, rendered (design: "Chosen: Marginalia").
 *
 * What these pin beyond the logic tests: the only things that move while the
 * panel sits there are the elapsed digits and the fade, and they move by a
 * direct write into nodes that stay put. A row is never rebuilt by a tick or
 * by a new frame, so hover and focus survive both.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { AgentPanel } from "../src/components/AgentPanel";
import type { AgentSnapshot } from "../src/components/agents.logic";
import type { AgentInfo, AgentSet, WorkflowInfo } from "../src/types/events";

const T0 = 1_790_000_000_000;
const S = 1000;

function agent(id: string, over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    description: `agent ${id}`,
    name: "",
    agentType: "general-purpose",
    model: "claude-opus-5-5",
    color: "yellow",
    depth: 1,
    parentId: "",
    toolUseId: "",
    workflowId: "",
    phaseIndex: 0,
    label: "",
    state: "running",
    startedAt: T0,
    lastActivityAt: T0 + 60 * S,
    endedAt: 0,
    tool: "Read",
    toolDetail: "src/app.css",
    toolCalls: 3,
    outputTokens: 1500,
    result: "",
    ...over,
  };
}

const wf = (over: Partial<WorkflowInfo> = {}): WorkflowInfo => ({
  id: "wf_1",
  name: "cut-dead-paths",
  summary: "Cut the dead frontend paths",
  state: "running",
  startedAt: T0,
  endedAt: 0,
  phases: [{ index: 1, title: "Survey", detail: "" }],
  currentPhase: 1,
  agentCount: 2,
  tokens: 0,
  toolCalls: 0,
  ...over,
});

const snap = (agents: AgentInfo[], workflows: WorkflowInfo[] = []): AgentSnapshot => ({
  set: { at: T0 + 60 * S, agents, workflows } satisfies AgentSet,
  skew: 0,
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"],
  });
  vi.setSystemTime(T0 + 60 * S);
});
afterEach(() => {
  vi.useRealTimers();
});

function mount(initial: AgentSnapshot, form: "rail" | "strip" = "rail") {
  const [s, setS] = createSignal(initial);
  const r = render(() => <AgentPanel snapshot={s()} form={form} />);
  const q = <T extends Element = HTMLElement>(sel: string) =>
    r.container.querySelector<T & HTMLElement>(sel);
  const all = (sel: string) => [...r.container.querySelectorAll<HTMLElement>(sel)];
  return { ...r, setS, q, all };
}

describe("the margin rail", () => {
  it("names each running agent with what it is doing now", () => {
    const v = mount(
      snap([agent("a1"), agent("a2", { startedAt: T0 + S, tool: "Bash", toolDetail: "npm test" })]),
    );
    const entries = v.all(".tl-agent");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.querySelector(".tl-agent-title")?.textContent).toBe("agent a1");
    expect(entries[0]!.querySelector(".tl-agent-act")?.textContent).toBe("▸ Read app.css");
    expect(entries[1]!.querySelector(".tl-agent-act")?.textContent).toBe("▸ Bash npm test");
    expect(entries[0]!.querySelector(".tl-agent-num")?.textContent).toBe("3 · 1.5k");
  });

  it("puts the ticking elapsed beside the title and gives the activity the line below", () => {
    // Measured at 260px with all three figures on the activity's line, the
    // activity had 96px, about 13 characters: "▸ Bash sleep…".
    const v = mount(snap([agent("a1")]));
    const head = v.q(".tl-agent-head")!;
    expect(head.querySelector(".tl-agent-title")?.textContent).toBe("agent a1");
    expect(head.querySelector(".tl-agents-elapsed")?.textContent).toBe("1m 00");
    expect(v.q(".tl-agent-line .tl-agents-elapsed")).toBeNull();
  });

  it("keeps a finished parent above its running child, drawn as ended", () => {
    const v = mount(
      snap([
        agent("p", { state: "done", endedAt: T0 + 5 * S, result: "Waiting for the child" }),
        agent("c", { parentId: "p", startedAt: T0 + S }),
      ]),
    );
    const [p, c] = v.all(".tl-agent");
    expect(p!.dataset.ended).toBe("true");
    expect(p!.querySelector(".tl-agent-act")?.textContent).toBe("✓ Waiting for the child");
    expect(c!.dataset.ended).toBe("false");
    expect(c!.style.getPropertyValue("--indent")).toBe("1");
    expect(v.q(".tl-agents-count")?.textContent).toBe("1 running");
    expect(v.q(".tl-agents-donebar")).toBeNull();
  });

  it("draws the spine in the agent's own colour", () => {
    const v = mount(snap([agent("a1", { color: "cyan" })]));
    expect(v.q(".tl-agent")?.style.getPropertyValue("--spine")).toBe("var(--tl-agent-cyan)");
  });

  it("indents the spine to show nesting", () => {
    const v = mount(snap([agent("p"), agent("c", { parentId: "p", startedAt: T0 + S })]));
    const [p, c] = v.all(".tl-agent");
    expect(p!.style.getPropertyValue("--indent")).toBe("0");
    expect(c!.style.getPropertyValue("--indent")).toBe("1");
  });

  it("puts one tick per agent in the tally, with the running count and tokens", () => {
    const v = mount(
      snap([
        agent("a1"),
        agent("a2", { startedAt: T0 + S, outputTokens: 500 }),
        agent("d", { state: "done", endedAt: T0 + 30 * S, outputTokens: 1000 }),
      ]),
    );
    expect(v.all(".tl-agents-tick").map((t) => t.dataset.kind)).toEqual(["live", "live", "done"]);
    expect(v.q(".tl-agents-count")?.textContent).toBe("2 running");
    expect(v.q(".tl-agents-tokens")?.textContent).toBe("3.0k");
  });

  it("marks a failed agent and keeps it out of the done line", () => {
    const v = mount(
      snap([agent("a1"), agent("f", { state: "failed", endedAt: T0 + 9 * S, result: "exit 127" })]),
    );
    const failed = v.all(".tl-agent")[1]!;
    expect(failed.dataset.failed).toBe("true");
    expect(failed.querySelector(".tl-agent-act")?.textContent).toBe("× exit 127");
    expect(v.q(".tl-agents-donebar")).toBeNull();
  });
});

describe("ticking", () => {
  it("moves the elapsed digits by writing into the node that is already there", () => {
    const v = mount(snap([agent("a1")]));
    const row = v.q(".tl-agent")!;
    const title = row.querySelector(".tl-agent-title")!.firstChild;
    const elapsed = row.querySelector(".tl-agents-elapsed")!;
    expect(elapsed.textContent).toBe("1m 00");

    vi.advanceTimersByTime(5 * S);
    expect(elapsed.textContent).toBe("1m 05");
    // Nothing else was touched: the same row, the same text node.
    expect(v.q(".tl-agent")).toBe(row);
    expect(row.querySelector(".tl-agent-title")!.firstChild).toBe(title);
  });

  it("stops a finished agent's clock at its end", () => {
    const v = mount(snap([agent("a1"), agent("d", { state: "done", endedAt: T0 + 20 * S })]));
    fireEvent.click(v.q(".tl-agents-donebar")!);
    const doneRow = v.all(".tl-agent").find((r) => r.dataset.ended === "true")!;
    vi.advanceTimersByTime(30 * S);
    expect(doneRow.querySelector(".tl-agents-elapsed")?.textContent).toBe("20s");
  });

  it("reads the server's clock, not this device's", () => {
    // The phone is 30 s behind the server: without the skew every agent would
    // read 30 s younger than it is.
    vi.setSystemTime(T0 + 30 * S);
    const v = mount({ ...snap([agent("a1")]), skew: 30 * S });
    expect(v.q(".tl-agents-elapsed")?.textContent).toBe("1m 00");
  });

  it("fades a quiet agent's activity line and dims its tick, without a word about it", () => {
    const v = mount(
      snap([agent("fresh"), agent("quiet", { startedAt: T0 + 1, lastActivityAt: T0 })]),
    );
    const [fresh, quiet] = v.all(".tl-agent");
    expect(fresh!.querySelector<HTMLElement>(".tl-agent-act")!.style.opacity).toBe("");
    expect(Number(quiet!.querySelector<HTMLElement>(".tl-agent-act")!.style.opacity)).toBeCloseTo(
      0.87,
      2,
    );
    const ticks = v.all(".tl-agents-tick");
    expect(ticks.map((t) => t.dataset.quiet)).toEqual(["false", "true"]);

    vi.advanceTimersByTime(60 * S);
    expect(v.all(".tl-agents-tick").map((t) => t.dataset.quiet)).toEqual(["true", "true"]);
    expect(v.container.textContent).not.toMatch(/stuck|hung|stalled/i);
  });
});

describe("a new frame", () => {
  it("updates rows in place and never reorders them", () => {
    const v = mount(snap([agent("a1"), agent("a2", { startedAt: T0 + S })]));
    const [first, second] = v.all(".tl-agent");
    v.setS(
      snap([
        agent("a1", { tool: "Grep", toolDetail: "pattern x" }),
        agent("a2", { startedAt: T0 + S }),
        agent("a3", { startedAt: T0 + 2 * S }),
      ]),
    );
    const rows = v.all(".tl-agent");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(first);
    expect(rows[1]).toBe(second);
    expect(first!.querySelector(".tl-agent-act")?.textContent).toBe("▸ Grep pattern x");
  });
});

describe("finished agents", () => {
  it("collapse into one line that opens", () => {
    const v = mount(
      snap([agent("a1"), agent("d", { state: "done", endedAt: T0 + 9 * S, result: "found it" })]),
    );
    const bar = v.q<HTMLButtonElement>(".tl-agents-donebar")!;
    expect(bar.textContent).toContain("1 done");
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(v.all(".tl-agent")).toHaveLength(1);

    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(v.all(".tl-agent")).toHaveLength(2);
    expect(v.all(".tl-agent")[1]!.querySelector(".tl-agent-act")?.textContent).toBe("✓ found it");
  });
});

describe("a workflow", () => {
  it("gets a header, its phases and one muted line per live member", () => {
    const member = (id: string, over: Partial<AgentInfo> = {}) =>
      agent(id, {
        workflowId: "wf_1",
        phaseIndex: 1,
        label: `label ${id}`,
        description: "",
        ...over,
      });
    const v = mount(
      snap(
        [
          member("m1", { tool: "Edit", toolDetail: "a.ts" }),
          member("m2", { state: "done", endedAt: T0 + 9 * S }),
        ],
        [wf()],
      ),
    );
    // The kind line carries the figures and nothing that has to fit beside
    // them; the run's title gets the whole width of the line under it.
    expect(v.q(".tl-agents-run-k .tl-agents-run-num")?.textContent).toBe("1m 00 · 3.0k");
    expect(v.q(".tl-agents-run-k")?.textContent).not.toContain("cut-dead-paths");
    const title = v.q(".tl-agents-run-title");
    expect(title?.textContent).toBe("Cut the dead frontend paths");
    expect(title?.getAttribute("title")).toBe("cut-dead-paths: Cut the dead frontend paths");
    expect(title?.dataset.id).toBe("false");
    expect(v.q(".tl-agents-phase-name")?.textContent).toBe("1 · Survey");
    // A running phase says how many and for how long. Its tokens wait for the
    // phase to finish: at 260px they pushed the phase's own name off the line,
    // and the run header above already carries the run's.
    expect(v.q(".tl-agents-phase-status")?.textContent).toBe("1 running · 1m 00");
    const rows = v.all(".tl-agents-member");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector(".tl-agents-member-title")?.textContent).toBe("label m1");
    // Description plus current tool only: the file path stays off a member's line.
    expect(rows[0]!.querySelector(".tl-agents-member-act")?.textContent).toBe("▸ Edit");
    expect(rows[0]!.style.getPropertyValue("--spine")).toContain("color-mix");
    expect(v.q(".tl-agents-fold")?.textContent).toBe("✓ 1 done");
  });
});

describe("what a cut-off line keeps", () => {
  it("offers the whole of a truncated line on hover", () => {
    const v = mount(snap([agent("a1", { toolDetail: "frontend-v2/src/components/TextView.tsx" })]));
    expect(v.q(".tl-agent-act")?.textContent).toBe("▸ Read TextView.tsx");
    expect(v.q(".tl-agent-act")?.getAttribute("title")).toBe(
      "▸ Read frontend-v2/src/components/TextView.tsx",
    );
    expect(v.q(".tl-agent-title")?.getAttribute("title")).toBe("agent a1");
  });

  it("titles a run nothing has described yet by its id, set apart from a description", () => {
    const v = mount(
      snap(
        [agent("m1", { workflowId: "wf_1", phaseIndex: 1, label: "m1", description: "" })],
        [wf({ name: "", summary: "" })],
      ),
    );
    expect(v.all(".tl-agents-run-title")).toHaveLength(1);
    expect(v.q(".tl-agents-run-title")?.textContent).toBe("wf_1");
    expect(v.q(".tl-agents-run-title")?.dataset.id).toBe("true");
  });

  it("gives a finished phase its tokens", () => {
    const member = (id: string, over: Partial<AgentInfo> = {}) =>
      agent(id, { workflowId: "wf_1", phaseIndex: 1, label: id, description: "", ...over });
    const v = mount(
      snap(
        [
          member("m1", { state: "done", endedAt: T0 + 9 * S }),
          member("m2", { state: "done", endedAt: T0 + 9 * S }),
          member("m3", { phaseIndex: 2 }),
        ],
        [
          wf({
            phases: [
              { index: 1, title: "Survey", detail: "" },
              { index: 2, title: "Delete", detail: "" },
            ],
          }),
        ],
      ),
    );
    expect(v.all(".tl-agents-phase-status").map((e) => e.textContent)).toEqual([
      "✓ 2 done · 3.0k",
      "1 running · 1m 00",
    ]);
  });
});

describe("the narrow form", () => {
  it("is one line with the tally that opens into the list", () => {
    const v = mount(snap([agent("a1"), agent("a2", { startedAt: T0 + S, tool: "Bash" })]), "strip");
    const bar = v.q<HTMLButtonElement>(".tl-agents-bar")!;
    expect(v.q(".tl-agents-label")?.textContent).toBe("2 running · Read, Bash");
    expect(v.all(".tl-agents-tick")).toHaveLength(2);
    expect(v.q(".tl-agents-list")).toBeNull();

    fireEvent.click(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
    expect(v.all(".tl-agent")).toHaveLength(2);
  });
});

/**
 * Tapping an agent opens its own transcript (design step 6). The whole entry
 * is one button, so the tap target is the row the reader is looking at, and
 * the entry that is open says so. The prototype marks it with the hover tint
 * and a faint chevron that brightens under the pointer.
 */
describe("tapping an agent", () => {
  function mountOpenable(
    initial: AgentSnapshot,
    form: "rail" | "strip" = "rail",
    openId: () => string | null = () => null,
  ) {
    const opened: string[] = [];
    const r = render(() => (
      <AgentPanel
        snapshot={initial}
        form={form}
        onOpen={(id) => opened.push(id)}
        openId={openId()}
      />
    ));
    const all = (sel: string) => [...r.container.querySelectorAll<HTMLElement>(sel)];
    return { ...r, opened, all };
  }

  it("opens an agent from anywhere on its entry", () => {
    const v = mountOpenable(snap([agent("a1"), agent("a2", { startedAt: T0 + S })]));
    const buttons = v.all(".tl-agent > button.tl-agent-open");
    expect(buttons).toHaveLength(2);
    // The title, the activity line and the figures are all inside the button.
    expect(buttons[1]!.querySelector(".tl-agent-title")?.textContent).toBe("agent a2");
    expect(buttons[1]!.querySelector(".tl-agent-num")).not.toBeNull();
    expect(buttons[1]!.querySelector(".tl-agent-go")?.textContent).toBe("›");
    fireEvent.click(buttons[1]!.querySelector(".tl-agent-act")!);
    expect(v.opened).toEqual(["a2"]);
  });

  it("opens a workflow member from its line", () => {
    const v = mountOpenable(
      snap([agent("m1", { workflowId: "wf_1", phaseIndex: 1, label: "survey" })], [wf()]),
    );
    fireEvent.click(v.all(".tl-agents-member > button.tl-agent-open")[0]!);
    expect(v.opened).toEqual(["m1"]);
  });

  it("opens a finished agent from the done list", () => {
    const v = mountOpenable(
      snap([agent("a1"), agent("d", { state: "done", endedAt: T0 + 9 * S, result: "found" })]),
    );
    fireEvent.click(v.all(".tl-agents-donebar")[0]!);
    const done = v.all(".tl-agent").find((e) => e.dataset.ended === "true")!;
    fireEvent.click(done.querySelector("button.tl-agent-open")!);
    expect(v.opened).toEqual(["d"]);
  });

  it("marks the entry whose transcript is open", () => {
    const v = mountOpenable(
      snap([agent("a1"), agent("a2", { startedAt: T0 + S })]),
      "rail",
      () => "a2",
    );
    const [first, second] = v.all(".tl-agent");
    expect(first!.dataset.open).toBe("false");
    expect(second!.dataset.open).toBe("true");
    expect(second!.querySelector("button")?.getAttribute("aria-current")).toBe("true");
    expect(first!.querySelector("button")?.hasAttribute("aria-current")).toBe(false);
  });

  it("offers nothing to open for a member that never started", () => {
    // Queued when its run was killed: no transcript was ever written.
    const v = mountOpenable(
      snap(
        [agent("wf_1#2", { workflowId: "wf_1", phaseIndex: 1, state: "queued", startedAt: 0 })],
        [wf({ state: "killed", endedAt: T0 + 30 * S })],
      ),
    );
    fireEvent.click(v.all(".tl-agents-donebar")[0]!);
    const button = v.all(".tl-agent button.tl-agent-open")[0]!;
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(v.opened).toEqual([]);
  });

  it("closes the strip's list on a tap, so what the tap opened is what shows", () => {
    const v = mountOpenable(snap([agent("a1")]), "strip");
    fireEvent.click(v.all(".tl-agents-bar")[0]!);
    fireEvent.click(v.all(".tl-agent button.tl-agent-open")[0]!);
    expect(v.opened).toEqual(["a1"]);
    expect(v.all(".tl-agents-list")).toHaveLength(0);
    expect(v.all(".tl-agents-bar")[0]!.getAttribute("aria-expanded")).toBe("false");
  });
});
