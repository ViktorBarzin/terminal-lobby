import type { AgentInfo, AgentSet, WorkflowInfo } from "../types/events";
import type { BackgroundWork, SessionTool } from "../types/lobby";

/**
 * The agent panel's logic (docs/plans/2026-09-12-agent-workflow-visualisation-
 * design.md, "Chosen: Marginalia"): which agents it shows, in what order, and
 * how it words them.
 *
 * Nothing in here reads the clock. The things that change every second, the
 * elapsed digits, the fade of a quiet agent's activity line and a tally tick
 * dimming, are worked out at tick time from timestamps the rows carry, so a
 * running panel re-derives nothing between server frames and its rows are
 * never rebuilt by the passage of time.
 */

/** The set as the server sent it, with how far its clock is ahead of ours. */
export interface AgentSnapshot {
  set: AgentSet;
  /** Server clock minus this device's clock when the frame arrived, in ms. A
   *  phone's clock can be seconds out, and every elapsed figure in the panel is
   *  a difference against a server timestamp. */
  skew: number;
}

export function snapshotOf(set: AgentSet, receivedAt: number): AgentSnapshot {
  return { set, skew: set.at - receivedAt };
}

/** A tally tick dims once its agent has written nothing for this long. It is a
 *  number, not a verdict: 120 s of silence is normal while an agent reads a
 *  large file, and nothing on disk says whether it is alive. */
const QUIET_AFTER_MS = 45_000;
/** The activity line starts to fade after this long without a record... */
const FADE_FROM_MS = 25_000;
/** ...and bottoms out here, still readable. */
const FADE_FLOOR_MS = 195_000;
const FADE_DEPTH = 0.62;
/** Finished agents keep a short tick each, up to this many. */
const DONE_TICKS = 12;
/** A finished run's members listed when the done line opens. */
const DONE_MEMBERS_SHOWN = 6;

export function isQuiet(sinceMs: number): boolean {
  return sinceMs >= QUIET_AFTER_MS;
}

/** How opaque an activity line is, from the time since its agent last wrote. */
export function activityFade(sinceMs: number): number {
  if (sinceMs <= FADE_FROM_MS) return 1;
  const k = Math.min(1, (sinceMs - FADE_FROM_MS) / (FADE_FLOOR_MS - FADE_FROM_MS));
  return 1 - k * FADE_DEPTH;
}

/** `12s`, `3m 04`, `1h 02`: the minutes and seconds keep two digits so the
 *  figure does not change width as it ticks. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}`;
}

/** `980`, `9.8k`, `12k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.max(0, Math.round(n)));
}

/** How long an agent has been going, or went, as of `now` (server clock). */
export function elapsedOf(a: Pick<AgentInfo, "startedAt" | "endedAt">, now: number): number {
  if (a.startedAt <= 0) return 0;
  return Math.max(0, (a.endedAt > 0 ? a.endedAt : now) - a.startedAt);
}

/**
 * Claude Code's colour names, which the panel draws as the agent's spine so it
 * agrees with what the CLI shows. An agent Claude Code gave no colour (a plain
 * background agent, a workflow member) gets the neutral spine rather than one
 * made up here, which would be a second identity scheme beside the CLI's.
 */
const HUES = ["blue", "green", "yellow", "purple", "orange", "pink", "cyan", "red"] as const;
const KNOWN_HUES: ReadonlySet<string> = new Set(HUES);

export function agentHue(a: Pick<AgentInfo, "color">): string {
  return KNOWN_HUES.has(a.color) ? `var(--tl-agent-${a.color})` : "var(--tl-agent-none)";
}

/** Does the session list say the session is still waiting on something? */
function owes(bg: BackgroundWork | undefined): boolean {
  return (bg?.agents ?? 0) > 0 || (bg?.workflows ?? 0) > 0;
}

type Standing = "live" | "failed" | "done" | "stopped";

/**
 * Where an agent stands. A member of a run that is over has ended whatever its
 * own entry still says: a killed run leaves its in-flight members reading
 * `running` in the run file for good.
 */
function standing(a: AgentInfo, runs: Map<string, WorkflowInfo>): Standing {
  const run = a.workflowId ? runs.get(a.workflowId) : undefined;
  const live = a.state === "running" || a.state === "queued";
  if (run && run.state !== "running") {
    if (a.state === "failed") return "failed";
    return live ? "stopped" : "done";
  }
  if (live) return "live";
  return a.state === "failed" ? "failed" : "done";
}

/**
 * The presence rule: the panel appears while something in the set is running
 * and something says the session still owes that work.
 *
 * Running is what the files say, and they cannot say when an agent died: one
 * killed mid tool call, or left waiting on a task whose notice never came,
 * reads as running for good. So running alone does not hold the panel up.
 * What does is an open turn, the session list still counting background work,
 * or an agent whose own transcript says it is waiting on background work it
 * started. The last is there because Claude Code stops listing an agent as
 * working once its turn ends, so the session list drops an agent that has
 * paused to wait on its own background Bash while that Bash still runs.
 *
 * A session's agents and workflow runs live inside its claude process, so
 * once the session list says that process has gone (`tool`), nothing in the
 * set can still be running, whatever its transcripts last said.
 */
export function panelPresent(
  set: AgentSet | null | undefined,
  working: boolean,
  bg: BackgroundWork | undefined,
  tool?: SessionTool,
): boolean {
  if (!set) return false;
  if (tool !== undefined && tool !== "claude") return false;
  const runs = new Map(set.workflows.map((w) => [w.id, w]));
  const live = set.agents.filter((a) => standing(a, runs) === "live");
  if (live.length === 0 && !set.workflows.some((w) => w.state === "running")) return false;
  return working || owes(bg) || live.some((a) => a.waiting === true);
}

interface RowBase {
  /** Stable across frames: the panel keeps one DOM node per key. */
  key: string;
}

/** An agent drawn on its own: an ad-hoc subagent, or a finished run's member. */
export interface AgentRow extends RowBase {
  kind: "agent";
  agent: AgentInfo;
  title: string;
  /** The live activity line, or the outcome once it has ended. */
  act: string;
  /** The same line whole, for hover: `act` keeps only what fits at 260px. */
  hint: string;
  /** Tool calls and tokens. Elapsed sits by the title and ticks on its own. */
  counts: string;
  /** How many rows above it in the list are its ancestors: the spine's indent. */
  indent: number;
  hue: string;
  ended: boolean;
  failed: boolean;
}

/** A running workflow's header. */
export interface WorkflowRow extends RowBase {
  kind: "workflow";
  /** What the run is: its summary, else its name, else its id. It has a line
   *  to itself, under the kind and the figures, because beside them a real
   *  name or id kept about five characters. */
  title: string;
  /** The same for hover, with the name when the summary took its place. */
  hint: string;
  /** Nothing describes the run yet, so its title is only its id. */
  idOnly: boolean;
  startedAt: number;
  /** Output tokens across its members, the same measure as every other figure
   *  here. The run file's own total counts input and cache tokens too. */
  tokens: number;
}

export interface PhaseRow extends RowBase {
  kind: "phase";
  title: string;
  state: "waiting" | "running" | "done";
  /** What the phase says for itself; a running phase's elapsed ticks beside it. */
  status: string;
  startedAt: number;
  tokens: number;
}

/** One line per live or failed member: description plus current tool only. */
export interface MemberRow extends RowBase {
  kind: "member";
  agent: AgentInfo;
  title: string;
  act: string;
  hue: string;
  failed: boolean;
}

export interface FoldRow extends RowBase {
  kind: "fold";
  text: string;
}

/** The finished agents, collapsed to one line that opens. */
export interface DoneRow extends RowBase {
  kind: "done";
  count: number;
  open: boolean;
}

export type PanelRow = AgentRow | WorkflowRow | PhaseRow | MemberRow | FoldRow | DoneRow;

const titleOf = (a: AgentInfo): string => a.description || a.name || a.label || a.id;
const memberTitle = (a: AgentInfo): string => a.label || a.description || a.name || a.id;

/** The tools whose detail is a file path. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

/**
 * The part of a call's detail worth its place on the line. About twenty
 * characters fit beside the tool name at 260px, and the start of an absolute
 * path is the part that says least, so a file tool keeps its file's own name.
 * The server sends the path whole so that a client can make this cut
 * (sessionio toolDetail); the whole of it stays on hover.
 */
function detailShown(tool: string, detail: string): string {
  if (!FILE_TOOLS.has(tool)) return detail;
  return detail.split("/").filter(Boolean).at(-1) ?? detail;
}

/**
 * The one-line answer to "what is this agent doing now", or how it ended,
 * with the same line whole for hover. A workflow member's line is the tool
 * alone: sixteen rows each carrying a file path is the density the design
 * moved the figures off those rows to avoid.
 */
function activityOf(a: AgentInfo, at: Standing, detail = true): { act: string; hint: string } {
  const line = (text: string) => ({ act: text, hint: text });
  if (at === "failed") return line(`× ${a.result || "failed"}`);
  if (at === "stopped") return line("stopped with its run");
  if (at === "done") return line(`✓ ${a.result || "done"}`);
  if (a.state === "queued") return line("queued");
  if (!a.tool) return line("no tool call yet");
  if (!detail || !a.toolDetail) return line(`▸ ${a.tool}`);
  return {
    act: `▸ ${a.tool} ${detailShown(a.tool, a.toolDetail)}`,
    hint: `▸ ${a.tool} ${a.toolDetail}`,
  };
}

const bySpawn = (x: AgentInfo, y: AgentInfo): number =>
  x.startedAt - y.startedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * The agents in tree order: each child straight after its parent, siblings in
 * spawn order, with the ancestors each one sits under.
 *
 * Built over finished agents as well as running ones, then filtered. That is
 * what keeps rows from reordering: when a parent finishes, its running child
 * stays at the parent's place in the list instead of re-sorting among the
 * other top-level agents by its own start time.
 */
function treeOrder(agents: AgentInfo[]): { agent: AgentInfo; ancestors: string[] }[] {
  const ids = new Set(agents.map((a) => a.id));
  const children = new Map<string, AgentInfo[]>();
  const roots: AgentInfo[] = [];
  for (const a of agents) {
    if (a.parentId && a.parentId !== a.id && ids.has(a.parentId)) {
      const list = children.get(a.parentId) ?? [];
      list.push(a);
      children.set(a.parentId, list);
    } else {
      roots.push(a);
    }
  }
  const out: { agent: AgentInfo; ancestors: string[] }[] = [];
  const seen = new Set<string>();
  const walk = (list: AgentInfo[], ancestors: string[]): void => {
    for (const a of [...list].sort(bySpawn)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push({ agent: a, ancestors });
      walk(children.get(a.id) ?? [], [...ancestors, a.id]);
    }
  };
  walk(roots, []);
  // A parent chain that loops has no root to start from; list what is left.
  walk(
    agents.filter((a) => !seen.has(a.id)),
    [],
  );
  return out;
}

function agentRow(a: AgentInfo, at: Standing, indent: number): AgentRow {
  return {
    kind: "agent",
    key: `agent:${a.id}`,
    agent: a,
    title: titleOf(a),
    ...activityOf(a, at),
    counts: `${a.toolCalls} · ${formatTokens(a.outputTokens)}`,
    indent,
    hue: agentHue(a),
    ended: at !== "live",
    failed: at === "failed",
  };
}

const sum = (agents: AgentInfo[]): number => agents.reduce((n, a) => n + a.outputTokens, 0);

/** The phases a run names, or the ones its members fall into when it names none. */
function phasesOf(run: WorkflowInfo, members: AgentInfo[]): { index: number; title: string }[] {
  if (run.phases.length > 0) return [...run.phases].sort((x, y) => x.index - y.index);
  const seen = [...new Set(members.map((m) => m.phaseIndex))].sort((x, y) => x - y);
  return seen.map((index) => ({ index, title: "" }));
}

function workflowRows(
  run: WorkflowInfo,
  members: AgentInfo[],
  runs: Map<string, WorkflowInfo>,
): PanelRow[] {
  // A run still going may have no run file yet, and then nothing names or
  // describes it but its id.
  const title = run.summary || run.name || run.id;
  const out: PanelRow[] = [
    {
      kind: "workflow",
      key: `wf:${run.id}`,
      title,
      hint: run.summary && run.name ? `${run.name}: ${run.summary}` : title,
      idOnly: !run.summary && !run.name,
      startedAt: run.startedAt,
      tokens: sum(members),
    },
  ];
  for (const phase of phasesOf(run, members)) {
    const mine = members.filter((m) => m.phaseIndex === phase.index).sort(bySpawn);
    const at = mine.map((m) => standing(m, runs));
    const running = mine.filter((m, i) => at[i] === "live" && m.state === "running").length;
    const queued = mine.filter((m, i) => at[i] === "live" && m.state === "queued").length;
    const failed = at.filter((s) => s === "failed").length;
    const finished = at.filter((s) => s === "done").length;
    const started = mine.filter((m) => m.state !== "queued" && m.startedAt > 0);
    // A phase whose members have all landed is done, even before the run file
    // moves on to the next one; one with members still to come is under way as
    // soon as any of them has started.
    const state: PhaseRow["state"] =
      mine.length > 0 && running + queued === 0
        ? "done"
        : started.length > 0
          ? "running"
          : "waiting";
    let status = "";
    if (state === "running") status = running > 0 ? `${running} running` : `${queued} queued`;
    else if (state === "done") {
      status = failed > 0 ? `✓ ${finished} · ${failed} failed` : `✓ ${finished} done`;
    }
    out.push({
      kind: "phase",
      key: `phase:${run.id}:${phase.index}`,
      title: phase.title ? `${phase.index} · ${phase.title}` : String(phase.index),
      state,
      status,
      startedAt: started.length > 0 ? Math.min(...started.map((m) => m.startedAt)) : 0,
      tokens: sum(mine),
    });
    mine.forEach((m, i) => {
      const s = at[i];
      if (s === "failed" || (s === "live" && m.state === "running")) {
        out.push({
          kind: "member",
          key: `member:${m.id}`,
          agent: m,
          title: memberTitle(m),
          act: activityOf(m, s, false).act,
          hue: agentHue(m),
          failed: s === "failed",
        });
      }
    });
    if (state === "running" && finished > 0) {
      out.push({ kind: "fold", key: `fold:${run.id}:${phase.index}`, text: `✓ ${finished} done` });
    }
  }
  return out;
}

/**
 * The panel's rows, top to bottom.
 *
 * Running agents on top in tree order, each with the ancestors it runs under,
 * then failures (a failure never folds away, and it sits with the loose agents
 * so it never reads as part of a run it was not in), then each running
 * workflow, then one line for everything finished, which lists it newest first
 * when open.
 */
export function panelRows(set: AgentSet, opts: { doneOpen: boolean }): PanelRow[] {
  const runs = new Map(set.workflows.map((w) => [w.id, w]));
  const isMember = (a: AgentInfo) => a.workflowId !== "" && runs.has(a.workflowId);
  const loose = set.agents.filter((a) => !isMember(a));
  const order = treeOrder(loose);
  const at = new Map(set.agents.map((a) => [a.id, standing(a, runs)]));
  const out: PanelRow[] = [];

  // An agent that has ended while one of its own still runs keeps its place,
  // drawn as ended, so the tree above a running agent stays whole. A parent
  // that ends its turn to wait on a child it launched in the background reads
  // as running (sessionio agenttail.go, stop), so this is for one that really
  // finished and left its child going. Without its row the child would lose
  // its indent.
  const live = new Set(order.filter((o) => at.get(o.agent.id) === "live").map((o) => o.agent.id));
  const held = new Set(
    order
      .filter((o) => live.has(o.agent.id))
      .flatMap((o) => o.ancestors.filter((id) => !live.has(id))),
  );
  const shown = (id: string) => live.has(id) || held.has(id);
  for (const o of order) {
    if (!shown(o.agent.id)) continue;
    const s = at.get(o.agent.id) ?? standing(o.agent, runs);
    out.push(agentRow(o.agent, s, o.ancestors.filter(shown).length));
  }

  const ended = (a: AgentInfo) => a.endedAt || a.lastActivityAt;
  const failedLoose = loose.filter((a) => at.get(a.id) === "failed" && !held.has(a.id));
  for (const a of failedLoose.sort((x, y) => ended(x) - ended(y)))
    out.push(agentRow(a, "failed", 0));

  const finishedMembers: AgentInfo[] = [];
  for (const run of set.workflows) {
    const members = set.agents.filter((a) => a.workflowId === run.id);
    if (run.state === "running") {
      out.push(...workflowRows(run, members, runs));
      continue;
    }
    for (const m of members.sort(bySpawn)) {
      if (at.get(m.id) === "failed") out.push(agentRow(m, "failed", 0));
      else finishedMembers.push(m);
    }
  }

  const doneLoose = loose
    .filter((a) => at.get(a.id) === "done" && !held.has(a.id))
    .sort((x, y) => ended(y) - ended(x));
  const count = doneLoose.length + finishedMembers.length;
  if (count === 0) return out;
  out.push({ kind: "done", key: "done", count, open: opts.doneOpen });
  if (!opts.doneOpen) return out;
  for (const a of doneLoose) out.push(agentRow(a, "done", 0));
  for (const run of set.workflows) {
    const mine = finishedMembers.filter((m) => m.workflowId === run.id);
    for (const m of mine.slice(0, DONE_MEMBERS_SHOWN))
      out.push(agentRow(m, at.get(m.id) ?? "done", 0));
    if (mine.length > DONE_MEMBERS_SHOWN) {
      out.push({
        kind: "fold",
        key: `more:${run.id}`,
        text: `+ ${mine.length - DONE_MEMBERS_SHOWN} more in ${run.name || run.id}`,
      });
    }
  }
  return out;
}

export interface Tick {
  key: string;
  kind: "live" | "failed" | "done";
  hue: string;
  /** A workflow member: its hue drops most of its chroma, like its row. */
  muted: boolean;
  /** When a live agent last wrote; the tick dims itself from this at tick time. */
  lastActivityAt: number;
}

export interface Tally {
  ticks: Tick[];
  running: number;
  /** Output tokens across every agent in the set. */
  tokens: number;
}

/**
 * The tally above the list: one tick per agent, the whole glance in a line.
 * Live agents first in the order the list draws them, then failures, then a
 * short tick for each finished agent, up to twelve.
 */
export function panelTally(set: AgentSet): Tally {
  const runs = new Map(set.workflows.map((w) => [w.id, w]));
  const at = new Map(set.agents.map((a) => [a.id, standing(a, runs)]));
  const inRun = (a: AgentInfo) => a.workflowId !== "" && runs.has(a.workflowId);
  const loose = treeOrder(set.agents.filter((a) => !inRun(a))).map((o) => o.agent);
  const members = set.workflows.flatMap((w) =>
    set.agents.filter((a) => a.workflowId === w.id).sort(bySpawn),
  );
  const ordered = [...loose, ...members];
  const tick = (a: AgentInfo, kind: Tick["kind"]): Tick => ({
    key: a.id,
    kind,
    hue: agentHue(a),
    muted: inRun(a),
    lastActivityAt: a.lastActivityAt,
  });
  const running = ordered.filter((a) => at.get(a.id) === "live" && a.state === "running");
  const ticks = [
    ...running.map((a) => tick(a, "live")),
    ...ordered.filter((a) => at.get(a.id) === "failed").map((a) => tick(a, "failed")),
    ...ordered
      .filter((a) => {
        const s = at.get(a.id);
        return s === "done" || s === "stopped";
      })
      .slice(0, DONE_TICKS)
      .map((a) => tick(a, "done")),
  ];
  return { ticks, running: running.length, tokens: sum(set.agents) };
}

/** The narrow form's single line: how many are running, and with what. */
export function stripLabel(set: AgentSet): string {
  const { running } = panelTally(set);
  const runs = new Map(set.workflows.map((w) => [w.id, w]));
  const tools: string[] = [];
  for (const a of set.agents) {
    if (standing(a, runs) !== "live" || !a.tool || tools.includes(a.tool)) continue;
    tools.push(a.tool);
  }
  const shown = tools.slice(0, 3).join(", ");
  return shown ? `${running} running · ${shown}` : `${running} running`;
}

/** What the drill-in's header says about the agent it shows. */
export interface DrillHead {
  /** "Agent", or "Workflow agent" for a member of a run. */
  kind: string;
  /** The agent's name and its type, each once, whichever it has. */
  tags: string[];
  /** The words its panel entry uses, so the two read as the same agent. */
  title: string;
  /** Model, tool calls and output tokens: `claude-opus-5-5 · 12 tool calls · 9.8k tokens`. */
  figures: string;
  /** Empty while it runs. A member of a run that is over has stopped, whatever
   *  its own entry still says. */
  ending: "" | "finished" | "failed" | "stopped";
  /** Server ms where its elapsed clock stops, 0 while it runs. */
  endedAt: number;
}

export function drillHead(a: AgentInfo, run: WorkflowInfo | undefined): DrillHead {
  const s = standing(a, new Map(run ? [[run.id, run]] : []));
  const ending = s === "live" ? "" : s === "done" ? "finished" : s;
  const endedAt =
    ending === ""
      ? 0
      : s === "stopped"
        ? run?.endedAt || a.lastActivityAt
        : a.endedAt || a.lastActivityAt;
  const calls = `${a.toolCalls} ${a.toolCalls === 1 ? "tool call" : "tool calls"}`;
  return {
    kind: a.workflowId ? "Workflow agent" : "Agent",
    tags: [...new Set([a.name, a.agentType].filter((t) => t !== ""))],
    title: a.workflowId ? memberTitle(a) : titleOf(a),
    figures: [a.model, calls, `${formatTokens(a.outputTokens)} tokens`]
      .filter((p) => p !== "")
      .join(" · "),
    ending,
    endedAt,
  };
}
