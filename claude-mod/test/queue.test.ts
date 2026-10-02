import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../hooks/lib/queue.ts';

const delta = (text: string, over: Record<string, unknown> = {}) => ({
  type: 'delta', t: 1, turnId: 'T', step: 0, index: 0, kind: 'text', text, ...over,
});

test('adjacent deltas of the same block merge, keeping the first t', () => {
  const q = new EventQueue();
  q.push({ ...delta('Hel'), t: 10 });
  q.push({ ...delta('lo '), t: 20 });
  q.push({ ...delta('there'), t: 30 });
  assert.deepEqual(q.take(), [{ ...delta('Hello there'), t: 10 }]);
});

for (const [field, value] of [
  ['turnId', 'U'], ['agentId', 'a1'], ['step', 1], ['index', 1], ['kind', 'thinking'],
] as const) {
  test(`deltas differing in ${field} do not merge`, () => {
    const q = new EventQueue();
    q.push(delta('a'));
    q.push(delta('b', { [field]: value }));
    assert.equal(q.take().length, 2);
  });
}

test('a row between two deltas keeps them apart', () => {
  const q = new EventQueue();
  q.push(delta('a'));
  q.push({ type: 'row', t: 2, uuid: 'u' });
  q.push(delta('b'));
  assert.deepEqual(q.take().map((e) => e.type), ['delta', 'row', 'delta']);
});

test('a block\'s deltas stay ahead of its stored row, through merging and a requeue', () => {
  const q = new EventQueue();
  q.push(delta('Hel'));
  q.push(delta('lo'));
  q.push({ type: 'row', t: 2, uuid: 'block-row' });
  const batch = q.take();
  q.push({ type: 'turn_end', t: 3, turnId: 'T' });
  q.requeue(batch); // a failed POST puts the batch back in front
  assert.deepEqual(q.take().map((e) => e.type === 'delta' ? `delta:${e.text}` : e.type),
    ['delta:Hello', 'row', 'turn_end']);
});

test('a merged delta does not change the event that was pushed', () => {
  const q = new EventQueue();
  const first = delta('a');
  q.push(first);
  q.push(delta('b'));
  assert.equal(first.text, 'a');
});

test('take respects the batch limit and leaves the rest in order', () => {
  const q = new EventQueue();
  for (let i = 0; i < 5; i++) q.push({ type: 'row', t: i, uuid: String(i) });
  assert.deepEqual(q.take(2).map((e) => e.uuid), ['0', '1']);
  assert.equal(q.size, 3);
  assert.deepEqual(q.take().map((e) => e.uuid), ['2', '3', '4']);
  assert.equal(q.size, 0);
});

test('requeue puts a batch back in front, in order', () => {
  const q = new EventQueue();
  q.push({ type: 'row', t: 1, uuid: 'a' });
  q.push({ type: 'row', t: 2, uuid: 'b' });
  const batch = q.take(1);
  q.push({ type: 'row', t: 3, uuid: 'c' });
  q.requeue(batch);
  assert.deepEqual(q.take().map((e) => e.uuid), ['a', 'b', 'c']);
});

test('over the cap, the oldest deltas go first and rows stay', () => {
  const q = new EventQueue(4);
  q.push(delta('1', { index: 1 }));
  q.push({ type: 'row', t: 1, uuid: 'r1' });
  q.push(delta('2', { index: 2 }));
  q.push({ type: 'turn_end', t: 1, turnId: 'T' });
  q.push({ type: 'row', t: 1, uuid: 'r2' });
  q.push(delta('3', { index: 3 }));
  const got = q.take();
  assert.deepEqual(got.map((e) => e.type === 'delta' ? `d${e.index}` : e.type),
    ['row', 'turn_end', 'row', 'd3']);
  assert.equal(q.dropped, 2);
});

test('over the cap with no deltas left, superseded snapshots go next', () => {
  const q = new EventQueue(2);
  q.push({ type: 'agents', t: 1, agents: [] });
  q.push({ type: 'row', t: 1, uuid: 'r1' });
  q.push({ type: 'row', t: 1, uuid: 'r2' });
  assert.deepEqual(q.take().map((e) => e.type), ['row', 'row']);
});

test('rows and turn events are never dropped, even past the cap', () => {
  const q = new EventQueue(2);
  for (let i = 0; i < 5; i++) q.push({ type: 'row', t: i, uuid: String(i) });
  assert.equal(q.size, 5);
});

test('prepend puts one event ahead of everything queued', () => {
  const q = new EventQueue();
  q.push({ type: 'row', t: 1, uuid: 'a' });
  q.prepend({ type: 'history', t: 0, messages: [] });
  assert.deepEqual(q.take().map((e) => e.type), ['history', 'row']);
});
