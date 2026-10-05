import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue, MAX_EVENT_CHARS } from '../hooks/lib/queue.ts';
import { historyEvents, HISTORY_CHUNK_CHARS } from '../hooks/lib/shape.ts';
import type { RowEvent } from '../hooks/lib/wire.ts';

// Claude Code refuses a mod's request body over 4,194,304 characters
// (measured on 2.1.287, 2026-10-02). A refused batch is resent forever and
// holds every event behind it, so no batch may get near that.

const row = (n: number, chars: number): RowEvent => ({
  type: 'row', t: n, uuid: `u${n}`, door: 'response', origin: {}, message: { type: 'assistant', content: 'x'.repeat(chars) },
});

test('a batch stops before it passes the size budget', () => {
  const q = new EventQueue();
  for (let i = 0; i < 10; i++) q.push(row(i, 300_000));
  const batch = q.take(200, 1_000_000);
  assert.equal(batch.length, 3);
  assert.equal(q.size, 7);
});

test('a batch always carries at least one event', () => {
  const q = new EventQueue();
  q.push(row(1, 2_000_000));
  assert.equal(q.take(200, 1_000_000).length, 1);
});

test('an event too big for any request is dropped, not resent forever', () => {
  const q = new EventQueue();
  q.push(row(1, MAX_EVENT_CHARS + 10));
  q.push(row(2, 10));
  const batch = q.take(200, 1_000_000);
  assert.deepEqual(batch.map((e) => e.type === 'row' && e.uuid), ['u2']);
  assert.equal(q.dropped, 1);
});

const msg = (i: number, chars: number) => ({ role: i % 2 ? 'assistant' : 'user', text: `${i}:` + 'y'.repeat(chars), toolUses: [] });

test('history goes out in chunks under the budget, and only the last says it is the end', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(i, 200_000));
  const evs = historyEvents(5, messages, false);
  assert.ok(evs.length > 1, `${evs.length} chunk(s)`);
  for (const e of evs) {
    assert.equal(e.type, 'history');
    assert.ok(JSON.stringify(e).length <= HISTORY_CHUNK_CHARS + 1000, `chunk of ${JSON.stringify(e).length}`);
  }
  assert.deepEqual(evs.map((e) => e.more === true), [...evs.slice(1).map(() => true), false]);
  assert.equal(evs.flatMap((e) => e.messages as unknown[]).length, 40, 'every message is sent once');
  assert.equal(evs.at(-1)?.running, false);
});

test('a huge message is trimmed rather than left to block the history', () => {
  const evs = historyEvents(5, [
    { role: 'user', text: 'z'.repeat(5_000_000), toolUses: [] },
    { role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 't1', tool: 'Read', text: 'r'.repeat(5_000_000), result: { file: { content: 'c'.repeat(5_000_000) } } }] },
  ], true);
  for (const e of evs) assert.ok(JSON.stringify(e).length <= HISTORY_CHUNK_CHARS + 1000);
  const all = evs.flatMap((e) => e.messages as Array<{ text: string; toolUses: Array<{ text: string; result: unknown }> }>);
  assert.equal(all.length, 2);
  assert.ok((all[0]?.text.length ?? 0) < 100_000);
  const use = all[1]?.toolUses[0];
  assert.ok(use && use.text.length < 100_000);
  assert.ok(JSON.stringify(use.result).length < 100_000, 'the structured result is bounded');
  assert.equal(evs.at(-1)?.running, true);
});

test('an empty history is one event', () => {
  const evs = historyEvents(5, [], false);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.more, undefined);
});

// The server replays the transcript up to the last main-thread row this
// history covers, so the final chunk names it and no other chunk does.
test('only the final history chunk names the last row it covers', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(i, 200_000));
  const evs = historyEvents(5, messages, false, 'uuid-last');
  assert.ok(evs.length > 1);
  assert.deepEqual(evs.map((e) => e.last), [...evs.slice(1).map(() => undefined), 'uuid-last']);
  assert.equal(historyEvents(5, [], false).at(-1)?.last, undefined, 'no row stored yet, no barrier');
});
