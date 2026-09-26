/**
 * The agent panel's logic: what it shows, in what order, and how it words it.
 *
 * Nothing here reads the clock. What changes every second (elapsed digits, the
 * fade of a quiet agent's activity line, a tally tick dimming) is worked out at
 * tick time from a timestamp these rows carry, so a running panel re-derives
 * nothing between server frames (design: "timers tick by direct DOM write").
 */
import { describe, it, expect } from "vitest";
import {
  activityFade,
  agentHue,
  drillHead,
  elapsedOf,
  formatElapsed,
  formatTokens,
  isQuiet,
  panelPresent,
  panelRows,
  panelTally,
  snapshotOf,
  stripLabel,
  type PanelRow,
} from "../src/components/agents.logic";
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
    color: "",
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
    tool: "",
    toolDetail: "",
    toolCalls: 0,
    outputTokens: 0,
    result: "",
    ...over,
  };
}

function workflow(id: string, over: Partial<WorkflowInfo> = {}): WorkflowInfo {
  return {
    id,
    name: "cut-dead-paths",
    summary: "Cut the dead frontend paths",
    state: "running",
    startedAt: T0,
    endedAt: 0,
    phases: [
      { index: 1, title: "Survey", detail: "" },
      { index: 2, title: "Delete", detail: "" },
      { index: 3, title: "Refute", detail: "" },
    ],
    currentPhase: 1,
    agentCount: 0,
    tokens: 0,
    toolCalls: 0,
    ...over,
  };
}

const set = (agents: AgentInfo[], workflows: WorkflowInfo[] = []): AgentSet => ({
  at: T0,
  agents,
  workflows,
});

const done = (id: string, over: Partial<AgentInfo> = {}) =>
  agent(id, { state: "done", endedAt: T0 + 60 * S, result: "found it", ...over });

const keys = (rows: PanelRow[]) => rows.map((r) => r.key);

describe("formatElapsed", () => {
  it.each([
    [0, "0s"],
    [-5 * S, "0s"],
    [999, "0s"],
    [12 * S, "12s"],
    [59 * S, "59s"],
    [60 * S, "1m 00"],
    [184 * S, "3m 04"],
    [59 * 60 * S + 59 * S, "59m 59"],
    [3600 * S, "1h 00"],
    [3600 * S + 2 * 60 * S, "1h 02"],
    [26 * 3600 * S, "26h 00"],
  ])("%i ms reads %s", (ms, want) => {
    expect(formatElapsed(ms)).toBe(want);
  });
});

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [980, "980"],
    [1000, "1.0k"],
    [9_849, "9.8k"],
    [12_300, "12k"],
    [999_499, "999k"],
    [1_200_000, "1.2M"],
    [45_000_000, "45M"],
  ])("%i reads %s", (n, want) => {
    expect(formatTokens(n)).toBe(want);
  });
});

describe("silence is shown, never named", () => {
  it("keeps the activity line whole for the first 25 seconds", () => {
    expect(activityFade(0)).toBe(1);
    expect(activityFade(25 * S)).toBe(1);
  });

  it("fades it linearly to a floor at 195 seconds and holds it there", () => {
    expect(activityFade(110 * S)).toBeCloseTo(0.69, 2);
    expect(activityFade(195 * S)).toBeCloseTo(0.38, 2);
    expect(activityFade(3600 * S)).toBeCloseTo(0.38, 2);
  });

  it("dims a tally tick after 45 seconds without a record", () => {
    expect(isQuiet(44 * S)).toBe(false);
    expect(isQuiet(45 * S)).toBe(true);
  });
});

describe("elapsedOf", () => {
  it("counts a running agent up to now", () => {
    expect(elapsedOf(agent("a"), T0 + 30 * S)).toBe(30 * S);
  });

  it("freezes a finished one at its end", () => {
    expect(elapsedOf(done("a"), T0 + 600 * S)).toBe(60 * S);
  });
});

describe("agentHue", () => {
  it("uses the colour Claude Code assigned", () => {
    expect(agentHue(agent("a", { color: "yellow" }))).toBe("var(--tl-agent-yellow)");
    expect(agentHue(agent("a", { color: "red" }))).toBe("var(--tl-agent-red)");
  });

  it("gives an agent with no colour the same stand-in every time", () => {
    const hue = agentHue(agent("a9f3c2", { color: "" }));
    expect(hue).toMatch(/^var\(--tl-agent-[a-z]+\)$/);
    expect(agentHue(agent("a9f3c2", { color: "" }))).toBe(hue);
  });

  it("treats a colour name it does not know like none at all", () => {
    expect(agentHue(agent("a9f3c2", { color: "chartreuse" }))).toBe(
      agentHue(agent("a9f3c2", { color: "" })),
    );
  });

  it("spreads stand-ins over more than one hue", () => {
    const hues = new Set(
      Array.from({ length: 24 }, (_, i) => agentHue(agent(`agent-${i}`, { color: "" }))),
    );
    expect(hues.size).toBeGreaterThan(3);
  });
});

describe("panelPresent: only while the session actually owes work", () => {
  const running = set([agent("a")]);

  it("shows while an agent runs and the turn is open", () => {
    expect(panelPresent(running, true, undefined)).toBe(true);
  });

  it("shows while an agent runs and the session list says it owes an agent", () => {
    expect(panelPresent(running, false, { agents: 1 })).toBe(true);
    expect(panelPresent(running, false, { workflows: 1 })).toBe(true);
  });

  it("hides an agent whose session was killed mid-run", () => {
    // No turn and nothing owed: the transcript file still says running, but
    // nothing is going to finish it.
    expect(panelPresent(running, false, undefined)).toBe(false);
    expect(panelPresent(running, false, { agents: 0, workflows: 0 })).toBe(false);
  });

  it("disappears entirely when nothing is running", () => {
    expect(panelPresent(set([done("a")]), true, { agents: 1 })).toBe(false);
    expect(panelPresent(set([]), true, { agents: 1 })).toBe(false);
    expect(panelPresent(null, true, { agents: 1 })).toBe(false);
    expect(panelPresent(undefined, true, { agents: 1 })).toBe(false);
  });

  it("counts a running workflow and a queued member as work", () => {
    expect(panelPresent(set([], [workflow("wf_1")]), true, undefined)).toBe(true);
    const queued = agent("m", { workflowId: "wf_1", state: "queued" });
    expect(panelPresent(set([queued], [workflow("wf_1")]), true, undefined)).toBe(true);
  });

  it("does not count members of a run that is over, whatever they still say", () => {
    const stale = agent("m", { workflowId: "wf_1", state: "running" });
    expect(
      panelPresent(set([stale], [workflow("wf_1", { state: "killed" })]), true, undefined),
    ).toBe(false);
  });
});

describe("panelRows: running on top, finished collapsed below", () => {
  it("lists running agents in spawn order with their live activity", () => {
    const rows = panelRows(
      set([
        agent("a1", { tool: "Read", toolDetail: "src/app.css", toolCalls: 3, outputTokens: 1500 }),
        agent("a2", { startedAt: T0 + S, tool: "Bash", toolDetail: "npm test" }),
      ]),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual(["agent:a1", "agent:a2"]);
    expect(rows[0]).toMatchObject({
      kind: "agent",
      act: "▸ Read app.css",
      hint: "▸ Read src/app.css",
      counts: "3 · 1.5k",
      indent: 0,
      ended: false,
      failed: false,
    });
    expect(rows[1]).toMatchObject({ act: "▸ Bash npm test", hint: "▸ Bash npm test" });
  });

  it.each([
    ["Read", "/home/wizard/code/terminal-lobby/frontend-v2/src/app.css", "▸ Read app.css"],
    ["Edit", "…/frontend-v2/src/components/AgentPanel.tsx", "▸ Edit AgentPanel.tsx"],
    ["Write", "notes.txt", "▸ Write notes.txt"],
    ["NotebookEdit", "/srv/lab/fit.ipynb", "▸ NotebookEdit fit.ipynb"],
    ["Grep", "src/**/*.ts", "▸ Grep src/**/*.ts"],
    ["Bash", "go test ./sessionio/", "▸ Bash go test ./sessionio/"],
  ])("%s of %s reads %s", (tool, toolDetail, act) => {
    // About twenty characters fit on the line at 260px, and the start of an
    // absolute path is the part that says least. A file tool keeps its file's
    // own name there; the whole detail stays on hover.
    const [row] = panelRows(set([agent("a1", { tool, toolDetail })]), { doneOpen: false });
    expect(row).toMatchObject({ act, hint: `▸ ${tool} ${toolDetail}` });
  });

  it("says so when an agent has not called a tool yet", () => {
    const [row] = panelRows(set([agent("a1")]), { doneOpen: false });
    expect(row).toMatchObject({ act: "no tool call yet" });
  });

  it("describes an agent by its description, then its name, then its id", () => {
    const rows = panelRows(
      set([
        agent("a1", { description: "Map the data", name: "mapper" }),
        agent("a2", { description: "", name: "mapper", startedAt: T0 + 1 }),
        agent("a3", { description: "", name: "", startedAt: T0 + 2 }),
      ]),
      { doneOpen: false },
    );
    expect(rows.map((r) => (r.kind === "agent" ? r.title : ""))).toEqual([
      "Map the data",
      "mapper",
      "a3",
    ]);
  });

  it("nests a child under its parent and indents the same spine", () => {
    const rows = panelRows(
      set([
        agent("p", { startedAt: T0 }),
        agent("other", { startedAt: T0 + 5 * S }),
        agent("c", { parentId: "p", depth: 2, startedAt: T0 + 10 * S }),
        agent("g", { parentId: "c", depth: 3, startedAt: T0 + 20 * S }),
      ]),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual(["agent:p", "agent:c", "agent:g", "agent:other"]);
    expect(rows.map((r) => (r.kind === "agent" ? r.indent : -1))).toEqual([0, 1, 2, 0]);
  });

  it("keeps a finished parent in its place while a child of its own still runs", () => {
    // Every Agent call a subagent makes runs in the background (Claude Code
    // 2.1.281), so a parent ends its turn seconds after spawning and is woken
    // again when the child is done. Its row stays where it was, drawn as
    // ended, and the child keeps its indent under it. Nothing moves when the
    // parent is woken, and nothing is listed twice.
    const rows = panelRows(
      set([
        agent("a", { startedAt: T0 }),
        done("p", { startedAt: T0 + S, result: "Waiting for the child agent" }),
        agent("b", { startedAt: T0 + 2 * S }),
        agent("c", { parentId: "p", startedAt: T0 + 3 * S }),
      ]),
      { doneOpen: true },
    );
    expect(keys(rows)).toEqual(["agent:a", "agent:p", "agent:c", "agent:b"]);
    expect(rows[1]).toMatchObject({
      indent: 0,
      ended: true,
      act: "✓ Waiting for the child agent",
    });
    expect(rows[2]).toMatchObject({ indent: 1, ended: false });
  });

  it("keeps a whole chain of finished ancestors above a running agent", () => {
    const rows = panelRows(
      set([
        done("g", { startedAt: T0 }),
        agent("x", { startedAt: T0 + S }),
        done("p", { parentId: "g", startedAt: T0 + 2 * S }),
        agent("c", { parentId: "p", startedAt: T0 + 3 * S }),
        done("sib", { parentId: "g", startedAt: T0 + 4 * S }),
      ]),
      { doneOpen: false },
    );
    // The finished sibling holds nothing up, so it goes to the done line.
    expect(keys(rows)).toEqual(["agent:g", "agent:p", "agent:c", "agent:x", "done"]);
    expect(rows.map((r) => (r.kind === "agent" ? r.indent : -1))).toEqual([0, 1, 2, 0, -1]);
    expect(rows.at(-1)).toMatchObject({ kind: "done", count: 1 });
  });

  it("keeps a failed parent above its running child and not in the failures too", () => {
    const rows = panelRows(
      set([
        agent("p", { state: "failed", endedAt: T0 + 5 * S, result: "API error" }),
        agent("c", { parentId: "p", startedAt: T0 + S }),
      ]),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual(["agent:p", "agent:c"]);
    expect(rows[0]).toMatchObject({ failed: true, act: "× API error" });
    expect(rows[1]).toMatchObject({ indent: 1 });
  });

  it("lets a finished parent fold away once nothing of its own is running", () => {
    const rows = panelRows(
      set([agent("a"), done("p", { startedAt: T0 + S }), done("c", { parentId: "p" })]),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual(["agent:a", "done"]);
    expect(rows.at(-1)).toMatchObject({ count: 2 });
  });

  it("survives a parent chain that loops", () => {
    const rows = panelRows(
      set([agent("x", { parentId: "y" }), agent("y", { parentId: "x", startedAt: T0 + 1 })]),
      { doneOpen: false },
    );
    expect(keys(rows).sort()).toEqual(["agent:x", "agent:y"]);
  });

  it("never folds a failure away", () => {
    const rows = panelRows(
      set([
        agent("a1"),
        agent("f", { state: "failed", endedAt: T0 + 9 * S, result: "Bash: exit 127" }),
        done("d"),
      ]),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual(["agent:a1", "agent:f", "done"]);
    expect(rows[1]).toMatchObject({ failed: true, ended: true, act: "× Bash: exit 127" });
  });

  it("collapses finished agents into one line, newest first when opened", () => {
    const agents = [
      agent("a1"),
      done("d1", { endedAt: T0 + 10 * S }),
      done("d2", { endedAt: T0 + 20 * S, result: "" }),
    ];
    const closed = panelRows(set(agents), { doneOpen: false });
    expect(closed.at(-1)).toMatchObject({ kind: "done", count: 2, open: false });
    const open = panelRows(set(agents), { doneOpen: true });
    expect(keys(open)).toEqual(["agent:a1", "done", "agent:d2", "agent:d1"]);
    expect(open[2]).toMatchObject({ ended: true, act: "✓ done" });
    expect(open[3]).toMatchObject({ act: "✓ found it" });
  });

  it("shows no done line when nothing has finished", () => {
    expect(panelRows(set([agent("a1")]), { doneOpen: true }).map((r) => r.kind)).toEqual(["agent"]);
  });

  it("shows a member whose run is not in the set as an agent of its own", () => {
    const rows = panelRows(set([agent("m", { workflowId: "wf_gone", label: "survey" })]), {
      doneOpen: false,
    });
    expect(rows).toMatchObject([{ kind: "agent", key: "agent:m" }]);
  });
});

describe("panelRows: a workflow is a population, not sixteen individuals", () => {
  const member = (id: string, phase: number, over: Partial<AgentInfo> = {}) =>
    agent(id, {
      workflowId: "wf_1",
      phaseIndex: phase,
      label: `label ${id}`,
      description: "",
      ...over,
    });

  it("draws the run, its phases, and one line per live member", () => {
    const rows = panelRows(
      set(
        [
          member("s1", 1, { state: "done", endedAt: T0 + 50 * S, outputTokens: 400 }),
          member("s2", 1, { state: "done", endedAt: T0 + 51 * S, outputTokens: 600 }),
          member("d1", 2, { startedAt: T0 + 60 * S, tool: "Edit", outputTokens: 1000 }),
          member("d2", 2, { startedAt: T0 + 61 * S, state: "done", endedAt: T0 + 90 * S }),
          member("d3", 2, { startedAt: T0 + 62 * S, state: "queued" }),
          member("r1", 3, { state: "queued" }),
        ],
        [workflow("wf_1")],
      ),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual([
      "wf:wf_1",
      "phase:wf_1:1",
      "phase:wf_1:2",
      "member:d1",
      "fold:wf_1:2",
      "phase:wf_1:3",
    ]);
    expect(rows[0]).toMatchObject({
      kind: "workflow",
      title: "Cut the dead frontend paths",
      startedAt: T0,
      tokens: 2000,
    });
    expect(rows[1]).toMatchObject({
      kind: "phase",
      title: "1 · Survey",
      state: "done",
      status: "✓ 2 done",
    });
    expect(rows[2]).toMatchObject({
      kind: "phase",
      title: "2 · Delete",
      state: "running",
      status: "1 running",
      startedAt: T0 + 60 * S,
      tokens: 1000,
    });
    expect(rows[3]).toMatchObject({ kind: "member", title: "label d1", act: "▸ Edit" });
    expect(rows[4]).toMatchObject({ kind: "fold", text: "✓ 1 done" });
    expect(rows[5]).toMatchObject({ kind: "phase", state: "waiting", status: "" });
  });

  // The title has a line of its own. Beside the kind and the figures it had
  // about 50px, which cut a real name ("marginalia-check") and a real id
  // ("wf_99a3d61f-4e9") alike to five characters, seen live.
  it.each([
    [
      "its summary, with its name on hover",
      { name: "cut-dead-paths", summary: "Cut the dead frontend paths" },
      {
        title: "Cut the dead frontend paths",
        hint: "cut-dead-paths: Cut the dead frontend paths",
        idOnly: false,
      },
    ],
    [
      "its name when it has no summary",
      { name: "cut-dead-paths", summary: "" },
      { title: "cut-dead-paths", hint: "cut-dead-paths", idOnly: false },
    ],
    [
      "its summary alone when nothing names it",
      { name: "", summary: "Cut the dead frontend paths" },
      { title: "Cut the dead frontend paths", hint: "Cut the dead frontend paths", idOnly: false },
    ],
    // A run still going may have no run file yet, so no name and no summary.
    [
      "its id when nothing on disk describes it",
      { name: "", summary: "" },
      { title: "wf_1", hint: "wf_1", idOnly: true },
    ],
  ])("titles a run by %s", (_, over, want) => {
    const rows = panelRows(set([member("m1", 1)], [workflow("wf_1", over)]), { doneOpen: false });
    expect(rows[0]).toMatchObject({ kind: "workflow", ...want });
  });

  it("gives a member's line the tool alone, never its file path", () => {
    const rows = panelRows(
      set(
        [member("m1", 1, { tool: "Read", toolDetail: "src/components/TextView.tsx" })],
        [workflow("wf_1")],
      ),
      { doneOpen: false },
    );
    expect(rows.find((r) => r.kind === "member")).toMatchObject({ act: "▸ Read" });
  });

  it("keeps a failed member on a line of its own, in a finished phase too", () => {
    const rows = panelRows(
      set(
        [
          member("s1", 1, { state: "done", endedAt: T0 + 50 * S }),
          member("s2", 1, { state: "failed", endedAt: T0 + 51 * S, result: "retry exhausted" }),
          member("d1", 2),
        ],
        [workflow("wf_1")],
      ),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual([
      "wf:wf_1",
      "phase:wf_1:1",
      "member:s2",
      "phase:wf_1:2",
      "member:d1",
      "phase:wf_1:3",
    ]);
    expect(rows[1]).toMatchObject({ status: "✓ 1 · 1 failed" });
    expect(rows[2]).toMatchObject({ failed: true, act: "× retry exhausted" });
  });

  it("puts loose agents and their failures above the run", () => {
    const rows = panelRows(
      set(
        [
          agent("a1"),
          member("d1", 1),
          agent("f", { state: "failed", endedAt: T0 + S, startedAt: T0 + 2 }),
        ],
        [workflow("wf_1", { phases: [{ index: 1, title: "Survey", detail: "" }] })],
      ),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual(["agent:a1", "agent:f", "wf:wf_1", "phase:wf_1:1", "member:d1"]);
  });

  it("groups members by phase when the run names no phases", () => {
    const rows = panelRows(
      set(
        [member("m1", 1), member("m2", 2, { startedAt: T0 + 1 })],
        [workflow("wf_1", { phases: [] })],
      ),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual([
      "wf:wf_1",
      "phase:wf_1:1",
      "member:m1",
      "phase:wf_1:2",
      "member:m2",
    ]);
    expect(rows[1]).toMatchObject({ title: "1" });
  });

  it("folds a finished run into the done line, keeping its failures out", () => {
    const rows = panelRows(
      set(
        [
          agent("a1"),
          member("m1", 1, { state: "done", endedAt: T0 + 9 * S }),
          member("m2", 1, { state: "failed", endedAt: T0 + 9 * S, result: "boom" }),
          member("m3", 1, { state: "running" }),
        ],
        [workflow("wf_1", { state: "killed", endedAt: T0 + 10 * S })],
      ),
      { doneOpen: false },
    );
    expect(keys(rows)).toEqual(["agent:a1", "agent:m2", "done"]);
    expect(rows.at(-1)).toMatchObject({ kind: "done", count: 2 });
  });

  it("names a member that stopped with its run rather than tick it done", () => {
    const rows = panelRows(
      set(
        [agent("a1"), member("m3", 1, { state: "running", tool: "Read" })],
        [workflow("wf_1", { state: "killed", endedAt: T0 + 10 * S })],
      ),
      { doneOpen: true },
    );
    expect(rows.find((r) => r.key === "agent:m3")).toMatchObject({ act: "stopped with its run" });
  });

  it("lists at most six members of a finished run when the done line opens", () => {
    const members = Array.from({ length: 9 }, (_, i) =>
      member(`m${i}`, 1, { state: "done", endedAt: T0 + i * S, startedAt: T0 + i }),
    );
    const rows = panelRows(set([agent("a1"), ...members], [workflow("wf_1", { state: "done" })]), {
      doneOpen: true,
    });
    const after = rows.slice(rows.findIndex((r) => r.kind === "done") + 1);
    expect(after.filter((r) => r.kind === "agent")).toHaveLength(6);
    expect(after.at(-1)).toMatchObject({ kind: "fold", text: "+ 3 more in cut-dead-paths" });
  });
});

describe("panelTally: one tick per agent", () => {
  it("ticks live agents first, then failures, then finished ones", () => {
    const t = panelTally(
      set([
        agent("a1", { outputTokens: 1000 }),
        agent("f", { state: "failed", endedAt: T0 + S, outputTokens: 10 }),
        done("d1", { outputTokens: 500 }),
      ]),
    );
    expect(t.ticks.map((k) => [k.key, k.kind])).toEqual([
      ["a1", "live"],
      ["f", "failed"],
      ["d1", "done"],
    ]);
    expect(t.running).toBe(1);
    expect(t.tokens).toBe(1510);
  });

  it("carries when each live agent last wrote, so the tick can dim on its own", () => {
    const t = panelTally(set([agent("a1", { lastActivityAt: T0 + 7 * S })]));
    expect(t.ticks[0]).toMatchObject({ lastActivityAt: T0 + 7 * S });
  });

  it("mutes a workflow member's tick", () => {
    const t = panelTally(
      set([agent("m", { workflowId: "wf_1", phaseIndex: 1 })], [workflow("wf_1")]),
    );
    expect(t.ticks[0]?.muted).toBe(true);
  });

  it("stops ticking finished agents at twelve", () => {
    const many = Array.from({ length: 20 }, (_, i) => done(`d${i}`, { startedAt: T0 + i }));
    const t = panelTally(set([agent("a1"), ...many]));
    expect(t.ticks.filter((k) => k.kind === "done")).toHaveLength(12);
  });
});

describe("stripLabel: the narrow form's one line", () => {
  it("names the count and the tools in use", () => {
    expect(
      stripLabel(
        set([
          agent("a1", { tool: "Read" }),
          agent("a2", { tool: "Bash", startedAt: T0 + 1 }),
          agent("a3", { tool: "Read", startedAt: T0 + 2 }),
          agent("a4", { tool: "Grep", startedAt: T0 + 3 }),
          agent("a5", { tool: "Edit", startedAt: T0 + 4 }),
        ]),
      ),
    ).toBe("5 running · Read, Bash, Grep");
  });

  it("leaves the tools off when none has been called", () => {
    expect(stripLabel(set([agent("a1")]))).toBe("1 running");
  });
});

describe("snapshotOf", () => {
  it("measures how far the server clock is ahead of this one", () => {
    const s = snapshotOf(set([]), T0 - 4 * S);
    expect(s.skew).toBe(4 * S);
    expect(s.set.at).toBe(T0);
  });
});

/**
 * The drill-in's header: which agent this is, in the words its panel entry
 * uses, and what it has cost so far. The elapsed digits tick in the view; this
 * says only where its clock stops.
 */
describe("drillHead: what the drill-in says about the agent it shows", () => {
  it("calls an ad-hoc agent what its entry calls it", () => {
    const a = agent("a1", {
      description: "Find prior art",
      name: "recon",
      agentType: "Explore",
      toolCalls: 12,
      outputTokens: 9800,
    });
    expect(drillHead(a, undefined)).toEqual({
      kind: "Agent",
      tags: ["recon", "Explore"],
      title: "Find prior art",
      figures: "claude-opus-5-5 · 12 tool calls · 9.8k tokens",
      ending: "",
      endedAt: 0,
    });
  });

  it("calls a workflow member by its label, as its line in the run does", () => {
    const a = agent("m1", { workflowId: "wf_1", label: "frontend source", toolCalls: 1 });
    const h = drillHead(a, workflow("wf_1"));
    expect(h.kind).toBe("Workflow agent");
    expect(h.title).toBe("frontend source");
    expect(h.figures).toBe("claude-opus-5-5 · 1 tool call · 0 tokens");
  });

  it("says a name once when the type is the same word, and leaves out what is empty", () => {
    const h = drillHead(
      agent("a1", { name: "Explore", agentType: "Explore", model: "" }),
      undefined,
    );
    expect(h.tags).toEqual(["Explore"]);
    expect(h.figures).toBe("0 tool calls · 0 tokens");
    expect(drillHead(agent("a2", { agentType: "" }), undefined).tags).toEqual([]);
  });

  it.each([
    ["done", "finished"],
    ["failed", "failed"],
  ] as const)("stops the clock at the end of an agent that is %s", (state, ending) => {
    const h = drillHead(agent("a1", { state, endedAt: T0 + 90 * S }), undefined);
    expect(h.ending).toBe(ending);
    expect(h.endedAt).toBe(T0 + 90 * S);
  });

  it("says a member of a killed run stopped, when the run did", () => {
    // A killed run leaves its in-flight members reading `running` for good.
    const a = agent("m1", { workflowId: "wf_1", lastActivityAt: T0 + 20 * S });
    const h = drillHead(a, workflow("wf_1", { state: "killed", endedAt: T0 + 30 * S }));
    expect(h.ending).toBe("stopped");
    expect(h.endedAt).toBe(T0 + 30 * S);
  });

  it("keeps an ended agent's clock on its last record when no end was stamped", () => {
    const a = agent("a1", { state: "done", endedAt: 0, lastActivityAt: T0 + 40 * S });
    expect(drillHead(a, undefined).endedAt).toBe(T0 + 40 * S);
  });
});
