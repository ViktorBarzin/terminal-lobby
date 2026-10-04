// Well-formed wire events for tests, each with only what its type requires
// unless a test says otherwise.

import type {
  AckEvent, AskEvent, DeltaEvent, LevelEvent, PermissionEvent, RowEvent, TurnEndEvent,
} from '../hooks/lib/wire.ts';

export const row = (uuid: string, t = 0): RowEvent => ({
  type: 'row', t, uuid, door: 'response', origin: { kind: 'engine' }, message: { type: 'assistant', content: [] },
});

export const delta = (text: string, over: Partial<DeltaEvent> = {}): DeltaEvent => ({
  type: 'delta', t: 1, turnId: 'T', step: 0, index: 0, kind: 'text', text, ...over,
});

export const turnEnd = (turnId = 'T', t = 3): TurnEndEvent => ({
  type: 'turn_end', t, turnId, aborted: false, answer: '', durationMs: 0,
});

export const level = (over: Partial<LevelEvent> = {}): LevelEvent => ({
  type: 'level', t: 0, running: false, compacting: false, tool: '', agents: [], asks: [], ...over,
});

export const ack = (id: string, t = 0): AckEvent => ({ type: 'ack', t, id, ok: true });

export const ask = (toolId: string, t = 5): AskEvent => ({ type: 'ask', t, toolId, questions: [{ question: 'Which?' }] });

export const permission = (toolId: string, t = 5): PermissionEvent => ({
  type: 'permission', t, toolId, tool: 'Bash', input: { command: 'ls' },
});
