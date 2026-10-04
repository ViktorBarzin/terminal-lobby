import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../hooks/lib/queue.ts';
import type { DeltaEvent, ModEvent } from '../hooks/lib/wire.ts';
import { ack, delta, level, row, turnEnd } from './events.ts';

const label = (e: ModEvent) => (e.type === 'delta' ? `delta:${e.text}` : e.type === 'row' ? `row:${e.uuid}` : e.type);

test('adjacent deltas of the same block merge, keeping the first t', () => {
  const q = new EventQueue();
  q.push({ ...delta('Hel'), t: 10 });
  q.push({ ...delta('lo '), t: 20 });
  q.push({ ...delta('there'), t: 30 });
  assert.deepEqual(q.take(), [{ ...delta('Hello there'), t: 10 }]);
});

const differing: [string, Partial<DeltaEvent>][] = [
  ['turnId', { turnId: 'U' }], ['agentId', { agentId: 'a1' }], ['step', { step: 1 }], ['index', { index: 1 }],
  ['kind', { kind: 'thinking' }],
];
for (const [field, over] of differing) {
  test(`deltas differing in ${field} do not merge`, () => {
    const q = new EventQueue();
    q.push(delta('a'));
    q.push(delta('b', over));
    assert.equal(q.take().length, 2);
  });
}

test('a row between two deltas keeps them apart', () => {
  const q = new EventQueue();
  q.push(delta('a'));
  q.push(row('u', 2));
  q.push(delta('b'));
  assert.deepEqual(q.take().map((e) => e.type), ['delta', 'row', 'delta']);
});

test('a block\'s deltas stay ahead of its stored row, through merging and a requeue', () => {
  const q = new EventQueue();
  q.push(delta('Hel'));
  q.push(delta('lo'));
  q.push(row('block-row', 2));
  const batch = q.take();
  q.push(turnEnd());
  q.requeue(batch); // a failed POST puts the batch back in front
  assert.deepEqual(q.take().map(label), ['delta:Hello', 'row:block-row', 'turn_end']);
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
  for (let i = 0; i < 5; i++) q.push(row(String(i), i));
  assert.deepEqual(q.take(2).map(label), ['row:0', 'row:1']);
  assert.equal(q.size, 3);
  assert.deepEqual(q.take().map(label), ['row:2', 'row:3', 'row:4']);
  assert.equal(q.size, 0);
});

test('requeue puts a batch back in front, in order', () => {
  const q = new EventQueue();
  q.push(row('a', 1));
  q.push(row('b', 2));
  const batch = q.take(1);
  q.push(row('c', 3));
  q.requeue(batch);
  assert.deepEqual(q.take().map(label), ['row:a', 'row:b', 'row:c']);
});

test('over the cap, the oldest deltas go first and rows stay', () => {
  const q = new EventQueue(4);
  q.push(delta('1', { index: 1 }));
  q.push(row('r1', 1));
  q.push(delta('2', { index: 2 }));
  q.push(turnEnd());
  q.push(row('r2', 1));
  q.push(delta('3', { index: 3 }));
  assert.deepEqual(q.take().map(label), ['row:r1', 'turn_end', 'row:r2', 'delta:3']);
  assert.equal(q.dropped, 2);
});

test('over the cap with no deltas left, superseded snapshots go next', () => {
  const q = new EventQueue(2);
  q.push({ type: 'agents', t: 1, agents: [] });
  q.push(row('r1', 1));
  q.push(row('r2', 1));
  assert.deepEqual(q.take().map((e) => e.type), ['row', 'row']);
});

test('rows and turn events are never dropped, even past the cap', () => {
  const q = new EventQueue(2);
  for (let i = 0; i < 5; i++) q.push(row(String(i), i));
  assert.equal(q.size, 5);
});

test('prepend puts one event ahead of everything queued', () => {
  const q = new EventQueue();
  q.push(row('a', 1));
  q.prepend({ type: 'history', t: 0, messages: [], running: false });
  assert.deepEqual(q.take().map((e) => e.type), ['history', 'row']);
});

// Wire contract v3: a level is the mod's whole view at one moment, so the
// queue holds at most one, the newest, and never sheds or drops it.
test('a new level replaces the one still queued, wherever it was', () => {
  const q = new EventQueue();
  q.push(level({ t: 1 }));
  q.push(row('a', 2));
  q.push(level({ t: 3, running: true }));
  const got = q.take();
  assert.deepEqual(got.map((e) => e.type), ['row', 'level']);
  assert.equal(got[1]?.t, 3);
});

test('a level survives the cap that sheds snapshots and deltas', () => {
  const q = new EventQueue(2);
  q.push(level());
  q.push(delta('a'));
  q.push(row('r1', 1));
  q.push(row('r2', 1));
  assert.deepEqual(q.take().map((e) => e.type), ['level', 'row', 'row']);
});

test('a prepended level gives way to a newer one already queued', () => {
  const q = new EventQueue();
  q.push(level({ t: 9 }));
  q.prepend({ type: 'history', t: 0, messages: [], running: false }, level({ t: 1 }));
  const got = q.take();
  assert.deepEqual(got.map((e) => `${e.type}@${e.t}`), ['history@0', 'level@9']);
});

test('keepOnly drops what a snapshot covers and keeps acks in order, uncounted', () => {
  const q = new EventQueue();
  q.push(row('a', 1));
  q.push(ack('c1', 2));
  q.push(turnEnd());
  q.push({ type: 'summary', t: 4, text: 'Title' });
  q.push({ type: 'command_failed', t: 5, id: 'c2', op: 'prompt', error: 'dropped: no' });
  q.push(level());
  q.keepOnly(new Set(['ack', 'summary', 'command_failed']));
  assert.deepEqual(q.take().map((e) => e.type), ['ack', 'summary', 'command_failed']);
  assert.equal(q.dropped, 0);
});
