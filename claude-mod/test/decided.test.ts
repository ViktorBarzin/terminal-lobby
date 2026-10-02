import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Decided } from '../hooks/lib/decided.ts';

// Measured live on 2026-10-02 (CLI 2.1.287): every allowed tool call asked
// twice. One answer, typed or sent, took the first dialog down and the same
// dialog came straight back for the same tool_use_id. The second check
// reuses the decision instead of asking again.

test('a decision made for a tool call answers its next check', () => {
  const d = new Decided();
  d.remember('toolu_1', { decision: 'allow' });
  assert.deepEqual(d.recall('toolu_1'), { decision: 'allow' });
});

test('another tool call is asked afresh', () => {
  const d = new Decided();
  d.remember('toolu_1', { decision: 'allow' });
  assert.equal(d.recall('toolu_2'), undefined);
});

test('a call without its own id is never remembered', () => {
  const d = new Decided();
  d.remember('', { decision: 'allow' });
  assert.equal(d.recall(''), undefined);
});

test('a decision answers one repeat, then the call asks again', () => {
  const d = new Decided();
  d.remember('toolu_1', { decision: 'allow' });
  d.recall('toolu_1');
  assert.equal(d.recall('toolu_1'), undefined);
});

test('only the most recent calls are kept', () => {
  const d = new Decided(2);
  d.remember('a', { decision: 'allow' });
  d.remember('b', { decision: 'allow' });
  d.remember('c', { decision: 'deny', reason: 'no' });
  assert.equal(d.recall('a'), undefined);
  assert.deepEqual(d.recall('c'), { decision: 'deny', reason: 'no' });
});
