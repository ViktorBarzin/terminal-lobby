import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptStamp } from '../hooks/lib/stamp.ts';

// Claude Code creates the transcript only when the first message arrives, so
// a hello at session start cannot name it. Measured live on 2026-10-02: with
// no hello after that, @claude_transcript stayed unset for the whole first
// turn and the agent API failed every first message to a new conversation.

test('a hello without the transcript owes one hello once the file appears', () => {
  const s = new TranscriptStamp();
  s.hello(false);
  assert.equal(s.appeared(false), false);
  assert.equal(s.appeared(true), true);
  assert.equal(s.appeared(true), false);
});

test('a hello that named the transcript owes nothing', () => {
  const s = new TranscriptStamp();
  s.hello(true);
  assert.equal(s.appeared(true), false);
});

test('a new conversation (a /clear) starts owing again', () => {
  const s = new TranscriptStamp();
  s.hello(true);
  s.hello(false);
  assert.equal(s.pending, true);
  assert.equal(s.appeared(true), true);
  assert.equal(s.pending, false);
});

test('before any hello nothing is owed', () => {
  const s = new TranscriptStamp();
  assert.equal(s.pending, false);
  assert.equal(s.appeared(true), false);
});
