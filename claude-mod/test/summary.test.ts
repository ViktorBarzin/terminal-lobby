import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_MAX_TOKENS, SUMMARY_MODEL, SummaryOnce, summaryFrom, summaryRequest } from '../hooks/lib/summary.ts';

// Claude Code writes no summary into the terminal title for a prompt a plugin
// submitted. Measured 2026-10-03: every session started from the lobby since
// the mod shipped (morning of 2026-10-02) sat on "Claude Code" until tmux-api's
// auto-title gave up, and its pushes named the random id.

test('a conversation owes one summary', () => {
  const s = new SummaryOnce();
  assert.equal(s.claim(), true);
  assert.equal(s.claim(), false);
  assert.equal(s.claim(), false);
});

test('a /clear starts a conversation that owes one again', () => {
  const s = new SummaryOnce();
  s.claim();
  s.reset();
  assert.equal(s.claim(), true);
});

test('the request asks the small model for a short title of the prompt', () => {
  const r = summaryRequest('fix the notification titles');
  assert.equal(r.model, SUMMARY_MODEL);
  assert.equal(r.maxTokens, SUMMARY_MAX_TOKENS);
  assert.equal(r.prompt, 'fix the notification titles');
  assert.match(r.system, /title/);
});

test('a long prompt is cut before it is sent', () => {
  const r = summaryRequest('x'.repeat(10_000));
  assert.ok(r.prompt.length <= 4001);
});

test('the title is the reply without the wrapping a model adds', () => {
  for (const [reply, want] of [
    ['Notification titles fall back to ids', 'Notification titles fall back to ids'],
    ['"Notification titles fall back to ids."', 'Notification titles fall back to ids'],
    ['Title: Fix push titles\n\nThis covers...', 'Fix push titles'],
    ['**Fix push titles**', 'Fix push titles'],
    ['\n  Вентилация в гаража  \n', 'Вентилация в гаража'],
    ['“Trip to Tashkent”', 'Trip to Tashkent'],
    ['', ''],
    ['  \n "" \n', ''],
  ] as const) {
    assert.equal(summaryFrom(reply), want, JSON.stringify(reply));
  }
});

test('the title is capped at 64 characters, counted as characters', () => {
  const t = summaryFrom('🙂'.repeat(100));
  assert.equal([...t].length, 64);
});
