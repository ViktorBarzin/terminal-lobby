import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenDialogs } from '../hooks/lib/open.ts';

test('a dialog is open from its announcement until it settles', () => {
  const d = new OpenDialogs();
  d.add({ type: 'ask', t: 1, toolId: 'a' });
  d.add({ type: 'plan', t: 2, toolId: 'b' });
  assert.deepEqual(d.list().map((e) => e.toolId), ['a', 'b']);
  d.settle('a');
  assert.deepEqual(d.list().map((e) => e.toolId), ['b']);
  d.settle('nope');
  assert.equal(d.list().length, 1);
});

test('announcing the same call again keeps one entry, the newest', () => {
  const d = new OpenDialogs();
  d.add({ type: 'permission', t: 1, toolId: 'a', tool: 'Bash' });
  d.add({ type: 'permission', t: 2, toolId: 'a', tool: 'Bash' });
  assert.deepEqual(d.list().map((e) => e.t), [2]);
});

test('list hands out copies the caller cannot change', () => {
  const d = new OpenDialogs();
  d.add({ type: 'ask', t: 1, toolId: 'a' });
  d.list().pop();
  assert.equal(d.list().length, 1);
});
