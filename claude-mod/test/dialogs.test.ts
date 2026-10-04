import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Command, type DialogDeps, Holds, OwnDialogs, holdDecision, ownDialog, raceQuestion,
} from '../hooks/lib/dialogs.ts';
import { Pending } from '../hooks/lib/pending.ts';
import type { DialogEvent } from '../hooks/lib/wire.ts';
import { PERMISSION_ALLOW, PERMISSION_DENY, PLAN_APPROVE } from '../hooks/lib/shape.ts';

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// A promise the test resolves or rejects by hand.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  const log: string[] = [];
  const announced: DialogEvent[] = [];
  const feedback: [string, string][] = [];
  const asks: { question: string; answer: ReturnType<typeof deferred<string>> }[] = [];
  const deps: DialogDeps = {
    announce: (ev) => { announced.push(ev); log.push(`announce ${ev.type} ${ev.toolId}`); },
    settled: (toolId, by) => log.push(`settled ${toolId} ${by}`),
    handOver: (toolId) => log.push(`handOver ${toolId}`),
    web: new Pending<Command>(),
    own: new OwnDialogs(),
    ask: (question) => {
      const answer = deferred<string>();
      asks.push({ question, answer });
      return answer.promise;
    },
    now: () => 7,
    agentOf: (toolId) => (toolId === 'sub-call' ? 'a1' : undefined),
    feedback: (toolId, words) => feedback.push([toolId, words]),
  };
  return { deps, log, announced, asks, feedback };
}

const ASK = 'ask' as const;
const bash = { tool: 'Bash', input: { command: 'rm -rf build' } };
const plan = { tool: 'ExitPlanMode', input: { plan: '1. Do it.' } };

// The race each dialog kind runs: the terminal answers first, or the web does.
test('permission: the terminal answer wins and is settled by the terminal', async () => {
  const h = harness();
  const p = holdDecision(h.deps, { ...bash, tool_use_id: 't1' }, { decision: ASK });
  await settle();
  h.asks[0]?.answer.resolve(PERMISSION_DENY);
  assert.deepEqual(await p, { decision: 'deny', reason: 'The user denied this Bash call.' });
  assert.deepEqual(h.log, ['announce permission t1', 'settled t1 terminal']);
});

test('permission: the web answer wins and takes the terminal dialog down', async () => {
  const h = harness();
  const p = holdDecision(h.deps, { ...bash, tool_use_id: 't1' }, { decision: ASK });
  await settle();
  assert.equal(h.deps.web.resolve('t1', { op: 'decide', decision: 'allow' }), true);
  assert.deepEqual(await p, { decision: 'allow' });
  assert.deepEqual(h.log, ['announce permission t1', 'settled t1 web']);
  const question = h.asks[0]?.question ?? '';
  assert.equal(await h.deps.own.get(question), PERMISSION_ALLOW, 'the dialog is answered with the web\'s choice');
});

test('plan: the web approval wins; its feedback is kept for the plan\'s tool result', async () => {
  const h = harness();
  const p = holdDecision(h.deps, { ...plan, tool_use_id: 'p1' }, { decision: ASK });
  await settle();
  assert.equal(h.announced[0]?.type, 'plan');
  h.deps.web.resolve('p1', { op: 'decide', decision: 'allow', feedback: '  use sqlite  ' });
  assert.deepEqual(await p, { decision: 'allow' });
  assert.deepEqual(h.feedback, [['p1', 'use sqlite']]);
  assert.equal(await h.deps.own.get(h.asks[0]?.question ?? ''), PLAN_APPROVE);
});

test('plan: the terminal approval wins and no feedback is kept', async () => {
  const h = harness();
  const p = holdDecision(h.deps, { ...plan, tool_use_id: 'p1' }, { decision: ASK });
  await settle();
  h.asks[0]?.answer.resolve(PLAN_APPROVE);
  assert.deepEqual(await p, { decision: 'allow' });
  assert.deepEqual(h.feedback, []);
  assert.deepEqual(h.log, ['announce plan p1', 'settled p1 terminal']);
});

// Contract item 11 (L-F7, D-F5): Esc on the mod's dialog makes Claude draw
// its own for the same call. The lobby keeps showing it.
test('a dismissed mod dialog hands over to Claude\'s menu without settling', async () => {
  const h = harness();
  const p = holdDecision(h.deps, { ...bash, tool_use_id: 't1' }, { decision: ASK, reason: 'needs approval' });
  await settle();
  h.asks[0]?.answer.reject(new Error('dismissed'));
  assert.deepEqual(await p, { decision: ASK, reason: 'needs approval' });
  assert.deepEqual(h.log, ['announce permission t1', 'handOver t1']);
});

test('a permission names the subagent whose row asked for the call', async () => {
  const h = harness();
  void holdDecision(h.deps, { ...bash, tool_use_id: 'sub-call' }, { decision: ASK, reason: 'why' });
  await settle();
  assert.deepEqual(h.announced[0], {
    type: 'permission', t: 7, toolId: 'sub-call', tool: 'Bash', input: bash.input, reason: 'why', agentId: 'a1',
  });
});

// D-F8: once the terminal has answered, a web answer must not be acked as applied.
test('the web waiter goes as soon as the terminal answers', async () => {
  const h = harness();
  const p = holdDecision(h.deps, { ...bash, tool_use_id: 't1' }, { decision: ASK });
  await settle();
  h.asks[0]?.answer.resolve(PERMISSION_ALLOW);
  await Promise.resolve();
  assert.equal(h.deps.web.resolve('t1', { op: 'decide', decision: 'deny' }), false);
  assert.deepEqual(await p, { decision: 'allow' });
});

// D-F9: a web answer that lands before the mod's $.ui.ask reaches its own
// tool.call must still take that dialog down when it gets there.
test('the takedown outlives a web win until the mod\'s dialog itself settles', async () => {
  const h = harness();
  const p = holdDecision(h.deps, { ...bash, tool_use_id: 't1' }, { decision: ASK });
  await settle();
  h.deps.web.resolve('t1', { op: 'decide', decision: 'deny' });
  await p;
  const question = h.asks[0]?.question ?? '';
  const takedown = h.deps.own.get(question);
  assert.ok(takedown, 'still registered for the dialog\'s late tool.call');
  const local = deferred<{ result: unknown }>();
  const r = await ownDialog({ questions: [{ question }] }, takedown, () => local.promise);
  assert.deepEqual(r, { result: { questions: [{ question }], answers: { [question]: PERMISSION_DENY }, annotations: {} } });
  h.asks[0]?.answer.resolve(PERMISSION_DENY);
  await settle();
  assert.equal(h.deps.own.get(question), undefined);
});

test('two dialogs with the same question get told apart', async () => {
  const h = harness();
  void holdDecision(h.deps, { ...bash, tool_use_id: 't1' }, { decision: ASK });
  void holdDecision(h.deps, { ...bash, tool_use_id: 't2' }, { decision: ASK });
  await settle();
  assert.equal(h.asks[1]?.question, `${h.asks[0]?.question} (2)`);
});

// D-F7: a check repeated for the same call, at the same time or right after,
// awaits the one hold rather than drawing a second dialog.
test('Holds: a concurrent repeat awaits the same hold', async () => {
  const holds = new Holds<string>();
  const d = deferred<string>();
  let started = 0;
  const start = () => { started++; return d.promise; };
  const a = holds.run('t1', start);
  const b = holds.run('t1', start);
  d.resolve('allow');
  assert.deepEqual([await a, await b], ['allow', 'allow']);
  assert.equal(started, 1);
});

test('Holds: one sequential repeat takes the answer given; a third check asks again', async () => {
  const holds = new Holds<string>();
  let n = 0;
  const start = () => Promise.resolve(`answer ${++n}`);
  assert.equal(await holds.run('t1', start), 'answer 1');
  assert.equal(await holds.run('t1', start), 'answer 1');
  assert.equal(await holds.run('t1', start), 'answer 2');
  assert.equal(await holds.run('t2', start), 'answer 3');
});

test('Holds: a hold that throws at once is not kept', async () => {
  const holds = new Holds<string>();
  await assert.rejects(holds.run('t1', () => { throw new Error('boom'); }));
  assert.equal(await holds.run('t1', () => Promise.resolve('ok')), 'ok');
});

test('Holds stays bounded', async () => {
  const holds = new Holds<number>(2);
  let n = 0;
  const start = () => Promise.resolve(++n);
  await holds.run('a', start);
  await holds.run('b', start);
  await holds.run('c', start);
  assert.equal(await holds.run('a', start), 4, 'the oldest was forgotten');
});

const questions = [{ question: 'Which?', header: 'Q', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }];

test('ask: the terminal answer wins', async () => {
  const h = harness();
  const local = deferred<{ result: unknown }>();
  const p = raceQuestion(h.deps, { tool_use_id: 'q1', questions }, () => local.promise);
  local.resolve({ result: 'terminal' });
  assert.deepEqual(await p, { result: 'terminal' });
  assert.deepEqual(h.log, ['announce ask q1', 'settled q1 terminal']);
  assert.equal(h.deps.web.resolve('q1', { op: 'answer' }), false, 'the waiter went with the terminal answer');
});

test('ask: the web answer wins and becomes the result', async () => {
  const h = harness();
  const local = deferred<{ result: unknown }>();
  const p = raceQuestion(h.deps, { tool_use_id: 'q1', questions }, () => local.promise);
  await settle();
  h.deps.web.resolve('q1', { op: 'answer', answers: { 'Which?': 'B' } });
  assert.deepEqual(await p, { result: { questions, answers: { 'Which?': 'B' }, annotations: {} } });
  assert.deepEqual(h.log, ['announce ask q1', 'settled q1 web']);
});

test('ask: a call that rejects settles as gone and rethrows', async () => {
  const h = harness();
  const p = raceQuestion(h.deps, { tool_use_id: 'q1', questions }, () => Promise.reject(new Error('aborted')));
  await assert.rejects(p, /aborted/);
  assert.deepEqual(h.log, ['announce ask q1', 'settled q1 gone']);
});

test('ask: long strings in the questions are capped before they are announced', async () => {
  const h = harness();
  const long = [{ question: 'x'.repeat(300_000) }];
  void raceQuestion(h.deps, { tool_use_id: 'q1', questions: long }, () => new Promise(() => {}));
  await settle();
  const ev = h.announced[0];
  assert.ok(ev?.type === 'ask' && JSON.stringify(ev.questions).length < 270_000);
});

test('a terminal answer to the mod\'s own dialog passes through', async () => {
  const r = await ownDialog({ questions: [{ question: 'Q' }] }, new Promise(() => {}), () => Promise.resolve({ result: 'mine' }));
  assert.deepEqual(r, { result: 'mine' });
});
