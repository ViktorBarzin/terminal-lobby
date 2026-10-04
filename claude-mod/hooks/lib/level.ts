// What the mod knows about the session right now, from the engine's events:
// the main turn, the main thread's tool, compaction, the dialogs open, the
// workflow runs going, and the last reply and notice. The `level` event sends
// it whole (wire contract v3), so session-events writes the tmux options from a
// snapshot rather than from edges it may have missed. What a hot reload would
// lose is saved through `onChange` into $.state (hooks/state.d.ts) and handed
// back to `restore`.

import type { TerminalLobbyLevel, TerminalLobbyText, TerminalLobbyWorkflow } from '../state.d.ts';
import type { DialogEvent, LevelEvent, ModAgent } from './wire.ts';

// A workflow run with no sign of life for this long is taken to have ended
// without its notification reaching the mod. Members raise a turn.step for
// every model request and are counted while a tool of theirs runs, so a live
// run is quiet this long only if one tool call outlasts it.
export const WORKFLOW_QUIET_MS = 30 * 60_000;

// The longest a workflow run is kept without its notification, whatever
// else happens. Any loop the engine's list does not name counts as a member,
// compaction and memory forks included, so a session in use would otherwise
// keep a run whose notification was missed alive for as long as it is used.
export const WORKFLOW_MAX_MS = 24 * 60 * 60_000;

// How many tool calls the mod remembers the loop of (rowSeen).
const PLACED_MAX = 256;

// What session-events keeps of a reply or a notice (modstate.go replyCap).
const TEXT_MAX = 1000;

const TASK_ID = /<task-id>([^<]+)<\/task-id>/g;

type Workflow = TerminalLobbyWorkflow & { seenAt: number; launchedAt: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

function isDialog(v: unknown): v is DialogEvent {
  return isRecord(v) && isString(v.toolId) && typeof v.t === 'number' &&
    (v.type === 'ask' || v.type === 'plan' || v.type === 'permission');
}

function isText(v: unknown): v is TerminalLobbyText {
  return isRecord(v) && typeof v.t === 'number' && isString(v.text);
}

function isSaved(v: unknown): v is TerminalLobbyLevel {
  return isRecord(v) && (v.mainTurn === null || isString(v.mainTurn)) &&
    Array.isArray(v.dialogs) && v.dialogs.every(isDialog) &&
    Array.isArray(v.native) && v.native.every(isString) &&
    Array.isArray(v.workflows) && v.workflows.every((w) => isRecord(w) && isString(w.id)) &&
    (v.reply === undefined || isText(v.reply)) && (v.notice === undefined || isText(v.notice));
}

function cut(text: string): string {
  const chars = Array.from(text);
  return chars.length > TEXT_MAX ? chars.slice(0, TEXT_MAX).join('') : text;
}

export class Level {
  #onChange: (saved: TerminalLobbyLevel) => void;
  #mainTurn: string | null = null;
  // The main turn that ended last: a prompt.submit naming it is late news.
  #endedTurn: string | null = null;
  #mainTools: string[] = [];
  #compacting = false;
  #dialogs = new Map<string, DialogEvent>();
  // The dialogs Claude drew itself, by tool_use_id, with the loop each
  // blocks (undefined for the main loop).
  #native = new Map<string, string | undefined>();
  #workflows = new Map<string, Workflow>();
  // Tool calls of loops the engine's list does not name: workflow members.
  #memberTools = new Set<string>();
  #listed = new Set<string>();
  #placed = new Map<string, string>();
  #reply: TerminalLobbyText | undefined;
  #notice: TerminalLobbyText | undefined;

  constructor(onChange: (saved: TerminalLobbyLevel) => void = () => {}) {
    this.#onChange = onChange;
  }

  get mainTurn(): string | null {
    return this.#mainTurn;
  }

  turnStarted(turnId: string): void {
    this.#mainTools = [];
    this.#setTurn(turnId);
  }

  // Every model request of every loop. The main loop's re-teaches the turn to
  // a module that loaded after its turn.start; a loop the engine's list does
  // not name is a workflow's member, and shows the runs are alive. A loop
  // stepping again has had its own dialog answered. True when the level changed.
  stepped(turnId: string, agentId: string | undefined, now: number): boolean {
    const cleared = this.#movedOn(agentId);
    if (agentId === undefined) return this.#setTurn(turnId) || cleared;
    this.#touch(agentId, now);
    return cleared;
  }

  // A prompt as submitted: one typed or delivered during a turn names it, and
  // a task notification ends the workflow runs it names. True when either
  // changed the level.
  promptSubmitted(turnId: string | undefined, text: string): boolean {
    const changed = turnId !== undefined && turnId !== this.#endedTurn && this.#setTurn(turnId);
    let ended = false;
    for (const m of text.matchAll(TASK_ID)) {
      if (m[1] !== undefined && this.#workflows.delete(m[1])) ended = true;
    }
    if (ended) this.#save();
    return changed || ended;
  }

  // A loop's turn.complete ends the dialogs Claude drew for that loop. The
  // main loop runs one turn at a time, so its turn.complete also ends
  // whatever turn the mod held.
  turnEnded(turnId: string, agentId: string | undefined): void {
    this.#movedOn(agentId);
    if (agentId !== undefined) return;
    this.#mainTools = [];
    this.#endedTurn = turnId;
    this.#mainTurn = null;
    this.#save();
  }

  // A turn's answer: the main loop's last non-blank one is the session's reply.
  answered(agentId: string | undefined, answer: string, t: number): void {
    if (agentId !== undefined || answer.trim() === '') return;
    this.#reply = { t, text: cut(answer) };
    this.#save();
  }

  // A main-thread tool call starting means any dialog Claude drew for the
  // main loop has been answered. True when that closed one.
  toolStarted(toolId: string, agentId: string | undefined): boolean {
    if (agentId === undefined) {
      const cleared = this.#movedOn(undefined);
      this.#mainTools.push(toolId);
      return cleared;
    }
    if (!this.#listed.has(agentId)) this.#memberTools.add(toolId);
    return false;
  }

  // A tool call's result: it is no longer in flight, and no dialog for it can
  // still be up. True when that closed a dialog.
  toolEnded(toolId: string): boolean {
    this.#mainTools = this.#mainTools.filter((id) => id !== toolId);
    this.#memberTools.delete(toolId);
    const had = this.#dialogs.delete(toolId);
    this.#native.delete(toolId);
    if (had) this.#save();
    return had;
  }

  compacting(on: boolean): void {
    this.#compacting = on;
  }

  open(ev: DialogEvent): void {
    this.#dialogs.delete(ev.toolId);
    this.#dialogs.set(ev.toolId, ev);
    this.#native.delete(ev.toolId);
    this.#save();
  }

  settle(toolId: string): void {
    if (this.#dialogs.delete(toolId)) {
      this.#native.delete(toolId);
      this.#save();
    }
  }

  // The mod's own dialog failed and Claude drew its own for the same call:
  // still open, but nothing of the mod's will settle it. It goes when the
  // loop it blocks moves on.
  handOver(toolId: string): void {
    const ev = this.#dialogs.get(toolId);
    if (!ev) return;
    this.#native.set(toolId, this.#loopOf(ev));
    this.#save();
  }

  dialogs(): DialogEvent[] {
    return [...this.#dialogs.values()];
  }

  // A stored row. The tool calls a subagent's assistant row asks for are that
  // subagent's, which tool.check does not say; a PushNotification the main
  // loop asks for is the session's newest notice.
  rowSeen(agentId: string | undefined, content: unknown, t = 0): void {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!isRecord(b) || b.type !== 'tool_use' || !isString(b.id)) continue;
      if (agentId === undefined) {
        const message = isString(b.name) && b.name.endsWith('PushNotification') && isRecord(b.input) ? b.input.message : undefined;
        if (isString(message) && message.trim() !== '') {
          this.#notice = { t, text: cut(message) };
          this.#save();
        }
        continue;
      }
      this.#placed.delete(b.id);
      this.#placed.set(b.id, agentId);
    }
    while (this.#placed.size > PLACED_MAX) {
      const oldest = this.#placed.keys().next().value;
      if (oldest === undefined) break;
      this.#placed.delete(oldest);
    }
  }

  agentOf(toolId: string): string | undefined {
    return this.#placed.get(toolId);
  }

  // The Workflow tool's result: a local run launched in the background.
  // True when it added one.
  workflowLaunched(result: unknown, now = 0): boolean {
    if (!isRecord(result) || result.status !== 'async_launched' || !isString(result.taskId) || !result.taskId) return false;
    const w: Workflow = { id: result.taskId, seenAt: now, launchedAt: now };
    if (isString(result.workflowName) && result.workflowName) w.name = result.workflowName;
    if (isString(result.summary) && result.summary) w.description = result.summary;
    this.#workflows.set(w.id, w);
    this.#save();
    return true;
  }

  // The ids the engine's list named last.
  listed(ids: readonly string[]): void {
    this.#listed = new Set(ids);
  }

  // Drops the runs quiet past WORKFLOW_QUIET_MS, and any launched more than
  // WORKFLOW_MAX_MS ago. True when it dropped one.
  expire(now: number): boolean {
    const quiet = this.#memberTools.size === 0;
    let changed = false;
    for (const [id, w] of this.#workflows) {
      if (now - w.launchedAt > WORKFLOW_MAX_MS || (quiet && now - w.seenAt > WORKFLOW_QUIET_MS)) {
        this.#workflows.delete(id);
        changed = true;
      }
    }
    if (changed) this.#save();
    return changed;
  }

  // The engine's list with the workflow runs after it.
  agents(engine: readonly ModAgent[]): ModAgent[] {
    const named = new Set(engine.map((a) => a.id));
    const runs: ModAgent[] = [];
    for (const w of this.#workflows.values()) {
      if (named.has(w.id)) continue;
      const a: ModAgent = { id: w.id, type: 'workflow', status: 'running' };
      if (w.name) a.name = w.name;
      if (w.description) a.description = w.description;
      runs.push(a);
    }
    return [...engine, ...runs];
  }

  level(agents: ModAgent[], t: number): LevelEvent {
    const ev: LevelEvent = {
      type: 'level',
      t,
      running: this.#mainTurn !== null,
      compacting: this.#compacting,
      tool: this.#mainTools.at(-1) ?? '',
      agents,
      asks: [...this.#dialogs.keys()],
    };
    if (this.#reply) ev.reply = this.#reply;
    if (this.#notice) ev.notice = this.#notice;
    return ev;
  }

  // A /clear or a resume: another conversation goes on in this process.
  reset(): void {
    this.#mainTurn = null;
    this.#endedTurn = null;
    this.#mainTools = [];
    this.#compacting = false;
    this.#dialogs.clear();
    this.#native.clear();
    this.#workflows.clear();
    this.#memberTools.clear();
    this.#placed.clear();
    this.#reply = undefined;
    this.#notice = undefined;
    this.#save();
  }

  // What $.state held from before a reload. The dialogs come back as Claude's
  // own: the hooks that held them went with the old module, so each goes when
  // the loop it blocks moves on.
  restore(saved: unknown, now: number): void {
    if (!isSaved(saved)) return;
    this.#mainTurn = saved.mainTurn;
    this.#dialogs = new Map(saved.dialogs.map((d) => [d.toolId, d]));
    this.#native = new Map(saved.dialogs.map((d) => [d.toolId, this.#loopOf(d)]));
    this.#workflows = new Map(saved.workflows.map((w) => [w.id, { ...w, seenAt: now, launchedAt: w.launchedAt ?? now }]));
    this.#reply = saved.reply;
    this.#notice = saved.notice;
  }

  // The loop a dialog blocks: a permission says, or the row that asked for
  // the call did; a question is always the main loop's.
  #loopOf(ev: DialogEvent): string | undefined {
    return (ev.type === 'permission' ? ev.agentId : undefined) ?? this.#placed.get(ev.toolId);
  }

  // Drops the dialogs Claude drew for the loop that has just moved on. True
  // when one went.
  #movedOn(agentId: string | undefined): boolean {
    let cleared = false;
    for (const [id, loop] of this.#native) {
      if (loop !== agentId) continue;
      this.#native.delete(id);
      this.#dialogs.delete(id);
      cleared = true;
    }
    if (cleared) this.#save();
    return cleared;
  }

  #setTurn(turnId: string): boolean {
    if (this.#mainTurn === turnId) return false;
    this.#mainTurn = turnId;
    this.#save();
    return true;
  }

  #touch(agentId: string, now: number): void {
    if (this.#listed.has(agentId)) return;
    for (const w of this.#workflows.values()) w.seenAt = now;
  }

  #save(): void {
    const saved: TerminalLobbyLevel = {
      mainTurn: this.#mainTurn,
      dialogs: this.dialogs(),
      native: [...this.#native.keys()],
      workflows: [...this.#workflows.values()].map((w) => {
        const kept: TerminalLobbyWorkflow = { id: w.id, launchedAt: w.launchedAt };
        if (w.name) kept.name = w.name;
        if (w.description) kept.description = w.description;
        return kept;
      }),
    };
    if (this.#reply) saved.reply = this.#reply;
    if (this.#notice) saved.notice = this.#notice;
    this.#onChange(saved);
  }
}
