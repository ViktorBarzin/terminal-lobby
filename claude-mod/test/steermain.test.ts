import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAIN_STEER_LEAD, TAKE_WAIT_MS, frameMainSteer, steerInto, type SteerMainDeps, type SteerMainCall,
} from '../hooks/lib/steermain.ts';

// A prompt sent from the Text view while Claude's main turn runs is held by
// session-events. At the turn's next tool boundary the mod takes it and
// attaches it to the tool's result as context, which the model reads before
// its next step. Measured on CLI 2.1.296 (2026-10-10): the model changed
// course on it, and the engine stores it as a hook_additional_context row.

function deps(texts: string[] | Error | 'never' = []): SteerMainDeps & { takes: number; waits: number[] } {
  const d = {
    takes: 0,
    waits: [] as number[],
    take: async () => {
      d.takes++;
      if (texts === 'never') return new Promise<string[]>(() => {});
      if (texts instanceof Error) throw texts;
      return texts;
    },
    wait: (ms: number) => {
      d.waits.push(ms);
      return Promise.resolve();
    },
  };
  return d;
}

const main: SteerMainCall = { toolId: 'toolu_1', aborted: false };

// The parts of a tool.call result steerInto reads and writes.
type Result = { result?: unknown; text?: string; isError?: boolean; deny?: string; context?: readonly string[] };
const result = (r: Result): Result => r;

test('held prompts ride on the tool result as one context entry each, after what is there', async () => {
  const r = await steerInto(deps(['first', 'second']), main, result({ result: 'ok', context: ['plan feedback'] }));
  assert.deepEqual(r.context, ['plan feedback', frameMainSteer('first'), frameMainSteer('second')]);
  assert.equal(r.result, 'ok');
});

test('an errored result carries them too: a failed call is still a boundary', async () => {
  const r = await steerInto(deps(['look here']), main, result({ isError: true, result: 'boom', text: 'boom' }));
  assert.deepEqual(r.context, [frameMainSteer('look here')]);
});

test('nothing held leaves the result as it was', async () => {
  const before = result({ result: 'ok' });
  assert.equal(await steerInto(deps([]), main, before), before);
});

test('nothing is taken where the context could not land', async () => {
  const cases: [string, SteerMainCall, Result][] = [
    ['a subagent call', { ...main, agentId: 'a1' }, { result: 'ok' }],
    ['a denied call', main, { deny: 'no' }],
    ['an interrupted call', { ...main, aborted: true }, { result: 'ok' }],
    ["the mod's own dialog", { ...main, toolId: 'toolu_plugin_x' }, { result: 'ok' }],
  ];
  for (const [name, call, r] of cases) {
    const d = deps(['held']);
    assert.equal(await steerInto(d, call, r), r, name);
    assert.equal(d.takes, 0, `${name}: took the held prompts`);
  }
});

// A slow or broken server must not hold up Claude's tool calls. What the
// server handed over without the mod using it goes out at the turn's end.
test('a take that does not answer in time, or fails, leaves the result alone', async () => {
  const slow = deps('never');
  const before = result({ result: 'ok' });
  assert.equal(await steerInto(slow, main, before), before);
  assert.deepEqual(slow.waits, [TAKE_WAIT_MS]);
  assert.equal(await steerInto(deps(new Error('refused')), main, before), before);
});

test('the frame leads with the line and trims the words', () => {
  assert.equal(frameMainSteer('  stop \n'), `${MAIN_STEER_LEAD}\n\nstop`);
});

// session-events finds the person's words by the lead, so the two spellings
// must not drift.
test('the lead is the one session-events reads', () => {
  const go = readFileSync(join(import.meta.dirname, '../../sessionio/steermain.go'), 'utf8');
  assert.ok(go.includes(`const MainSteerLead = ${JSON.stringify(MAIN_STEER_LEAD)}`), 'sessionio/steermain.go spells MainSteerLead differently');
});
