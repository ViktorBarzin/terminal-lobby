import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shapeResult, shapeRow } from '../hooks/lib/shape.ts';
import { type HelloBody, type ModEvent, type ModEventType, MOD_VERSION, toAgents } from '../hooks/lib/wire.ts';

// testdata/mod-wire/<type>.json is the golden copy of each event, written by
// the Go side (sessionio/modwire_test.go decodes it with unknown fields
// refused). Here every field the mod's types allow, filled in, must be exactly
// the golden file's keys, so neither side can add or misspell a field alone
// (Q-F10).

const GOLDEN = join(import.meta.dirname, '../../testdata/mod-wire');

function golden(name: string): Record<string, unknown> | undefined {
  const path = join(GOLDEN, `${name}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const keys = (v: object) => Object.keys(v).sort();

// Every event with every optional field set: Required<> makes the compiler
// refuse a sample that leaves one out.
const full: { [K in ModEventType]: Required<Extract<ModEvent, { type: K }>> } = {
  row: { type: 'row', t: 1, uuid: 'u', door: 'prompt', origin: {}, agentId: 'a', message: { type: 'user', content: [] } },
  result: { type: 'result', t: 1, toolId: 't', tool: 'Bash', agentId: 'a', result: null, text: 'x', isError: true },
  delta: { type: 'delta', t: 1, turnId: 'T', step: 0, index: 0, kind: 'text', text: 'x', agentId: 'a' },
  turn_start: { type: 'turn_start', t: 1, turnId: 'T', text: 'x' },
  turn_end: { type: 'turn_end', t: 1, turnId: 'T', aborted: false, answer: '', agentId: 'a', usage: {}, durationMs: 1 },
  prompt: { type: 'prompt', t: 1, text: 'x', origin: {} },
  model: { type: 'model', t: 1, model: 'm', effort: 'high' },
  agents: { type: 'agents', t: 1, agents: [] },
  history: { type: 'history', t: 1, messages: [], running: true, more: true },
  ask: { type: 'ask', t: 1, toolId: 't', questions: [] },
  plan: { type: 'plan', t: 1, toolId: 't', plan: 'p', planFilePath: '/p' },
  permission: { type: 'permission', t: 1, toolId: 't', tool: 'Bash', input: {}, reason: 'r', agentId: 'a' },
  settled: { type: 'settled', t: 1, toolId: 't', by: 'web' },
  ack: { type: 'ack', t: 1, id: 'c', ok: false, error: 'e' },
  command_failed: { type: 'command_failed', t: 1, id: 'c', op: 'prompt', error: 'e' },
  summary: { type: 'summary', t: 1, text: 'x' },
  bye: { type: 'bye', t: 1, reason: 'clear', sid: 's' },
  level: {
    type: 'level', t: 1, running: true, compacting: false, tool: '', agents: [], asks: [], reply: { t: 1, text: 'r' },
    notice: { t: 1, text: 'n' },
  },
};

for (const [type, sample] of Object.entries(full)) {
  test(`${type}: the mod's fields are the golden file's`, (t) => {
    const want = golden(type);
    if (!want) {
      t.skip(`testdata/mod-wire/${type}.json does not exist yet`);
      return;
    }
    assert.deepEqual(keys(sample), keys(want));
  });
}

test('hello: the body the mod sends has the golden file\'s fields', (t) => {
  const want = golden('hello');
  if (!want) {
    t.skip('testdata/mod-wire/hello.json does not exist yet');
    return;
  }
  const body: Required<HelloBody> = {
    sid: 's', pane: '%1', tmux: '', session: 'x', cwd: '/', transcript: '/t', model: 'm', version: 'v', mod: MOD_VERSION,
    instance: 'i', ops: [], dropped: 0,
  };
  assert.deepEqual(keys(body), keys(want));
  assert.equal(want.mod, MOD_VERSION, 'the golden hello names this mod version');
});

test('row and result shapers produce the golden fields', () => {
  const row = shapeRow(
    { door: 'prompt', origin: { kind: 'user' }, uuid: 'u', agentId: 'a' },
    { uuid: 'u', message: { type: 'user', name: 'n', role: 'user', isMeta: false, content: [] } },
    1,
  );
  const wantRow = golden('row');
  if (wantRow) {
    assert.deepEqual(keys(row), keys(wantRow));
    assert.deepEqual(keys(row.message), keys(wantRow.message as object));
  }
  const result = shapeResult({ tool: 'Bash', tool_use_id: 't', agentId: 'a' }, { result: {}, text: 'x', isError: true }, 1);
  const wantResult = golden('result');
  if (wantResult) assert.deepEqual(keys(result), keys(wantResult));
});

test('an agent carries exactly the fields the golden agents name', () => {
  const want = golden('agents');
  if (!want) return;
  const goldenKeys = new Set((want.agents as object[]).flatMap((a) => Object.keys(a)));
  const [shaped] = toAgents([{
    id: 'a', type: 'general-purpose', status: 'waiting', name: 'n', description: 'd', teammateId: 'x@y', parentId: 'p',
    spawnedBy: 'terminal-lobby',
  }]);
  assert.deepEqual(keys(shaped ?? {}), [...goldenKeys].sort());
});

test('toAgents leaves out what the engine adds beyond the wire, and an unknown status reads as running', () => {
  const engine = [{ id: 'a', type: 't', status: 'sleeping', description: '', extra: 1 }];
  assert.deepEqual(toAgents(engine), [{ id: 'a', type: 't', status: 'running' }]);
});

test('the level\'s reply and notice have the golden fields', () => {
  const want = golden('level');
  if (!want) return;
  for (const k of ['reply', 'notice'] as const) {
    assert.deepEqual(keys(full.level[k]), keys(want[k] as object), k);
  }
});
