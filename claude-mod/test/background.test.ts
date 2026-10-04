import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningWorkflows, withWorkflows } from '../hooks/lib/background.ts';

// $.agent.list() names subagents and teammates, never a workflow run (the
// engine's AgentLoop docs: "a workflow's agents ... carry ids no list names").
// The Stop hook's background_tasks does list a run, as type "workflow", and the
// lobby's Stop hook read it there until the mod replaced that hook. Without it
// a TV redesign run worked for seven hours under a session that read done
// (2026-10-04).

test('a workflow in flight becomes a running workflow entry', () => {
  const tasks = [
    { id: 'wgthfr873', type: 'workflow', status: 'running', description: 'Integrate and verify', name: 'tv-redesign-live' },
    { id: 'b1', type: 'shell', status: 'running', description: 'npm test', command: 'npm test' },
    { id: 'a1', type: 'subagent', status: 'running', description: 'review', agent_type: 'Explore' },
  ];
  assert.deepEqual(runningWorkflows(tasks), [
    { id: 'wgthfr873', type: 'workflow', status: 'running', name: 'tv-redesign-live', description: 'Integrate and verify' },
  ]);
});

test('a pending workflow counts as running: background_tasks lists only work in flight', () => {
  const got = runningWorkflows([{ id: 'w1', type: 'workflow', status: 'pending', description: 'd' }]);
  assert.equal(got?.[0]?.status, 'running');
});

test('an empty list clears what was there, a missing field leaves it alone', () => {
  assert.deepEqual(runningWorkflows([]), []);
  assert.equal(runningWorkflows(undefined), undefined);
  assert.equal(runningWorkflows('nope'), undefined);
});

test('an entry without a usable id is skipped', () => {
  assert.deepEqual(runningWorkflows([{ type: 'workflow', status: 'running' }, null, 7]), []);
});

test('the workflows join the engine list, which wins for an id it already names', () => {
  const agents = [{ id: 'a1', type: 'general-purpose', status: 'running', description: 'x' }];
  const wfs = [
    { id: 'w1', type: 'workflow', status: 'running', description: 'run' },
    { id: 'a1', type: 'workflow', status: 'running', description: 'dup' },
  ];
  assert.deepEqual(withWorkflows(agents, wfs), [agents[0], wfs[0]]);
  assert.deepEqual(withWorkflows(agents, []), agents);
});
