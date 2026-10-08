// The wire to session-events, typed. Each event mirrors the json tags of Go's
// sessionio.ModEvent for its type, and testdata/mod-wire/<type>.json at the
// repo root is the golden copy both sides test against (test/wire.test.ts here,
// sessionio/modwire_test.go there). Build events through these types, so a
// misspelt field is a compile error rather than a value the server drops.

import type {
  TerminalLobbyAsk, TerminalLobbyDialog, TerminalLobbyPermission, TerminalLobbyPlan, TerminalLobbyText,
} from '../state.d.ts';

// The mod's version, sent in every hello so the lobby can tell which sessions
// run an old copy (fixed by restarting them). .claude-plugin/plugin.json says
// the same; test/version.test.ts keeps them equal and asks for a bump when
// hooks/ changed.
export const MOD_VERSION = '0.5.1';

export type AgentStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed';

// One agent as the `agents` and `level` events list it: the engine's
// AgentInfo with the fields the server reads, or a workflow run.
export type ModAgent = {
  id: string;
  type: string;
  status: AgentStatus;
  name?: string;
  description?: string;
  teammateId?: string;
  parentId?: string;
  spawnedBy?: string;
};

export type HelloBody = {
  sid: string;
  pane: string;
  tmux: string;
  session: string;
  cwd: string;
  transcript?: string;
  model: string;
  version: string;
  mod: string;
  // Random per module load: a server that sees it change knows the mod
  // forgot everything and owes it a whole snapshot.
  instance: string;
  ops: readonly string[];
  // Events the queue dropped since the module loaded (lib/queue.ts).
  dropped: number;
};

export type RowMessage = { type: string; name?: string; role?: string; isMeta?: boolean; content: unknown };

export type RowEvent = { type: 'row'; t: number; uuid: string; door: string; origin: unknown; agentId?: string; message: RowMessage };
export type ResultEvent = {
  type: 'result'; t: number; toolId: string; tool: string; agentId?: string; result: unknown; text?: string; isError?: true;
};
export type DeltaEvent = {
  type: 'delta'; t: number; turnId: string; step: number; index: number; kind: 'text' | 'thinking'; text: string; agentId?: string;
};
export type TurnStartEvent = { type: 'turn_start'; t: number; turnId: string; text: string };
export type TurnEndEvent = {
  type: 'turn_end'; t: number; turnId: string; aborted: boolean; answer: string; agentId?: string; usage?: unknown; durationMs: number;
};
export type PromptEvent = { type: 'prompt'; t: number; text: string; origin: unknown };
export type ModelEvent = { type: 'model'; t: number; model: string; effort?: string };
export type AgentsEvent = { type: 'agents'; t: number; agents: ModAgent[] };
// `last` (final chunk only) is the uuid of the newest main-thread row the
// history covers: session-events replays the transcript up to it (0.4.0).
export type HistoryEvent = { type: 'history'; t: number; messages: unknown[]; running: boolean; more?: true; last?: string };
export type AskEvent = TerminalLobbyAsk;
export type PlanEvent = TerminalLobbyPlan;
export type PermissionEvent = TerminalLobbyPermission;
export type DialogEvent = TerminalLobbyDialog;
export type SettledEvent = { type: 'settled'; t: number; toolId: string; by: 'web' | 'terminal' | 'gone' };
export type AckEvent = { type: 'ack'; t: number; id: string; ok: boolean; error?: string };
export type CommandFailedEvent = { type: 'command_failed'; t: number; id: string; op: string; error: string };
export type SummaryEvent = { type: 'summary'; t: number; text: string };
export type ByeEvent = { type: 'bye'; t: number; reason: string; sid: string };
export type LevelEvent = {
  type: 'level';
  t: number;
  running: boolean;
  compacting: boolean;
  tool: string;
  agents: ModAgent[];
  asks: string[];
  // The last main-thread answer and the newest PushNotification, left out
  // until there is one. They are in the level because a snapshot drops the
  // turn_end and the row that first carried them (@claude_reply, @claude_notice).
  reply?: TerminalLobbyText;
  notice?: TerminalLobbyText;
};

export type ModEvent =
  | RowEvent | ResultEvent | DeltaEvent | TurnStartEvent | TurnEndEvent | PromptEvent | ModelEvent | AgentsEvent
  | HistoryEvent | AskEvent | PlanEvent | PermissionEvent | SettledEvent | AckEvent | CommandFailedEvent | SummaryEvent
  | ByeEvent | LevelEvent;

export type ModEventType = ModEvent['type'];

// An event before the sender stamps its time.
export type EventBody = ModEvent extends infer E ? E extends ModEvent ? Omit<E, 't'> : never : never;

const STATUSES: readonly string[] = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed'];

function isStatus(s: string): s is AgentStatus {
  return STATUSES.includes(s);
}

// An agent status that keeps work going: anything but an ended one.
export function isLive(status: AgentStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'killed';
}

type ListedAgent = {
  id: string; type: string; status: string; name?: string; description?: string;
  teammateId?: string; parentId?: string; spawnedBy?: string;
};

// The engine's list as the wire carries it: the fields the server reads and
// nothing else, so a field a later engine adds never reaches the server
// unannounced. A status the server would not know is sent as `running`, the
// one that keeps the agent counted.
export function toAgents(list: readonly ListedAgent[]): ModAgent[] {
  return list.map((a) => {
    const out: ModAgent = { id: a.id, type: a.type, status: isStatus(a.status) ? a.status : 'running' };
    if (a.name) out.name = a.name;
    if (a.description) out.description = a.description;
    if (a.teammateId) out.teammateId = a.teammateId;
    if (a.parentId) out.parentId = a.parentId;
    if (a.spawnedBy) out.spawnedBy = a.spawnedBy;
    return out;
  });
}
