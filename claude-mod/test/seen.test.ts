import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeenCommands } from '../hooks/lib/seen.ts';

test('the first sight of an id runs it; a repeat does not', () => {
  const seen = new SeenCommands();
  assert.equal(seen.repeat('c1'), undefined);
  assert.deepEqual(seen.repeat('c1'), { ok: true });
});

test('an id reused for a different command (a restarted server) runs it', () => {
  const seen = new SeenCommands();
  assert.equal(seen.repeat({ id: 'c1', op: 'prompt', text: 'count to 200' }), undefined);
  seen.record('c1', { ok: true });
  assert.equal(seen.repeat({ id: 'c1', op: 'prompt', text: 'after restart' }), undefined);
  assert.deepEqual(seen.repeat({ id: 'c1', op: 'prompt', text: 'after restart' }), { ok: true });
});

test('a redelivered command matches whatever order its fields arrive in', () => {
  const seen = new SeenCommands();
  assert.equal(seen.repeat({ id: 'c9', op: 'answer', toolId: 't', answers: { 'Q?': 'A' } }), undefined);
  assert.deepEqual(seen.repeat({ answers: { 'Q?': 'A' }, toolId: 't', op: 'answer', id: 'c9' }), { ok: true });
});

test('a repeat replays the recorded outcome, the latest one winning', () => {
  const seen = new SeenCommands();
  seen.repeat('c1');
  seen.record('c1', { ok: true });
  seen.record('c1', { ok: false, error: 'dropped: busy' });
  assert.deepEqual(seen.repeat('c1'), { ok: false, error: 'dropped: busy' });
});

test('a repeat of a command still running answers ok:true', () => {
  const seen = new SeenCommands();
  seen.repeat('c1');
  assert.deepEqual(seen.repeat('c1'), { ok: true });
});

test('only the most recent ids are remembered', () => {
  const seen = new SeenCommands(3);
  for (const id of ['a', 'b', 'c', 'd']) seen.repeat(id);
  assert.equal(seen.repeat('a'), undefined, 'a was forgotten, so it runs again');
  assert.deepEqual(seen.repeat('d'), { ok: true });
});

test('a command without an id is never treated as a repeat', () => {
  const seen = new SeenCommands();
  assert.equal(seen.repeat(undefined), undefined);
  assert.equal(seen.repeat(undefined), undefined);
  assert.equal(seen.repeat(''), undefined);
  assert.equal(seen.repeat(''), undefined);
});
