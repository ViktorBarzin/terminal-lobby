import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endSession, type EndDeps } from '../hooks/lib/lifecycle.ts';

function harness(over: Partial<EndDeps> = {}) {
  const log: string[] = [];
  const deps: EndDeps = {
    bye: (reason, sid) => log.push(`bye ${reason} ${sid}`),
    drain: async () => { log.push('drain'); },
    forget: () => log.push('forget'),
    rehello: (ended) => log.push(`rehello after ${ended}`),
    stop: () => log.push('stop'),
    ...over,
  };
  return { deps, log };
}

const next = (log: string[]) => async () => { log.push('next'); return { sessionId: 'old' }; };

// L-F1/S-F4: a /clear or a resume ends the conversation, not the process. The
// engine's end step runs first, then the mod forgets the old conversation and
// says hello for the new one.
for (const reason of ['clear', 'resume']) {
  test(`session.end ${reason}: the process goes on, so the mod says hello again`, async () => {
    const { deps, log } = harness();
    const r = await endSession(deps, { reason, sessionId: 'old' }, next(log));
    assert.deepEqual(r, { sessionId: 'old' });
    assert.deepEqual(log, [`bye ${reason} old`, 'drain', 'next', 'forget', 'rehello after old']);
  });
}

for (const reason of ['prompt_input_exit', 'logout', 'other']) {
  test(`session.end ${reason}: the process is going, so the link stops`, async () => {
    const { deps, log } = harness();
    await endSession(deps, { reason, sessionId: 'old' }, next(log));
    assert.deepEqual(log, [`bye ${reason} old`, 'drain', 'stop', 'next']);
  });
}

test('a failing bye or drain never keeps the session from ending', async () => {
  const { deps, log } = harness({ drain: () => Promise.reject(new Error('down')) });
  await endSession(deps, { reason: 'clear', sessionId: 'old' }, next(log));
  assert.deepEqual(log, ['bye clear old', 'next', 'forget', 'rehello after old']);
});
