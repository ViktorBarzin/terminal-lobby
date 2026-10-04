import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STEER_PREFIX, steer, type SteerAgent, type SteerDeps, type SteerResult } from '../hooks/lib/steer.ts';

const errorOf = (r: SteerResult) => (r.ok ? '' : r.error);

// A message the person types to a subagent from the Text view. Measured on CLI
// 2.1.288 (2026-10-03): $.session.send to { agentId } reaches a running
// subagent at its next tool boundary and an idle teammate when it next runs;
// the agent reads it as the coordinator's, so the prefix says who is speaking.

function deps(agents: SteerAgent[], delivered = true): SteerDeps & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    list: async () => agents,
    send: async (args) => {
      sent.push(args);
      return delivered ? { isDelivered: true } : { isDelivered: false, reason: 'gone' };
    },
  };
}

test('a running subagent is sent the message with the prefix', async () => {
  const d = deps([{ id: 'a1', type: 'general-purpose', status: 'running' }]);
  assert.deepEqual(await steer(d, 'a1', 'stop and report'), { ok: true });
  assert.deepEqual(d.sent, [{ to: { agentId: 'a1' }, text: `${STEER_PREFIX}\n\nstop and report` }]);
});

test('an idle teammate, which the engine still runs, is sent it', async () => {
  const d = deps([{ id: 'atm-b8c5', type: 'teammate', status: 'running' }]);
  assert.deepEqual(await steer(d, 'atm-b8c5', 'wake up'), { ok: true });
});

// Contract v3, item 9 (Q-F5): only an ended agent is finished. A waiting
// background agent and an idle teammate (the engine's documented word for one
// between messages) are still there to read it.
for (const status of ['completed', 'failed', 'killed'] as const) {
  test(`a ${status} agent is refused, read-only by choice`, async () => {
    const d = deps([{ id: 'a1', type: 'general-purpose', status }]);
    const r = await steer(d, 'a1', 'hi');
    assert.equal(r.ok, false);
    assert.match(errorOf(r), /^finished: /);
    assert.deepEqual(d.sent, []);
  });
}

for (const status of ['pending', 'waiting', 'idle'] as const) {
  test(`a ${status} agent is sent the message`, async () => {
    const d = deps([{ id: 'a1', type: status === 'idle' ? 'teammate' : 'general-purpose', status }]);
    assert.deepEqual(await steer(d, 'a1', 'hi'), { ok: true });
  });
}

test('an agent the engine does not list, or a workflow, cannot be addressed', async () => {
  const lists: SteerAgent[][] = [[], [{ id: 'a1', type: 'workflow', status: 'running' }]];
  for (const agents of lists) {
    const d = deps(agents);
    const r = await steer(d, 'a1', 'hi');
    assert.match(errorOf(r), /^not-addressable: /);
    assert.deepEqual(d.sent, []);
  }
});

test('an undelivered send passes its reason on', async () => {
  const d = deps([{ id: 'a1', type: 'general-purpose', status: 'running' }], false);
  assert.deepEqual(await steer(d, 'a1', 'hi'), { ok: false, error: 'gone' });
});

test('an empty message or id is refused before anything is sent', async () => {
  const d = deps([{ id: 'a1', type: 'general-purpose', status: 'running' }]);
  assert.equal((await steer(d, '', 'hi')).ok, false);
  assert.equal((await steer(d, 'a1', '   ')).ok, false);
  assert.deepEqual(d.sent, []);
});

// session-events strips the prefix to show the person's own words, so the two
// spellings must not drift.
test('the prefix is the one session-events reads', () => {
  const go = readFileSync(join(import.meta.dirname, '../../sessionio/steer.go'), 'utf8');
  assert.ok(go.includes(`const SteerPrefix = ${JSON.stringify(STEER_PREFIX)}`), 'sessionio/steer.go spells SteerPrefix differently');
});
