import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type Command, type DialogDeps, Holds, OwnDialogs, holdDecision, ownDialog, planOf, racePlan, raceQuestion,
} from '../hooks/lib/dialogs.ts';
import { Pending } from '../hooks/lib/pending.ts';
import type { DialogEvent } from '../hooks/lib/wire.ts';
import { PERMISSION_ALLOW, PERMISSION_DENY } from '../hooks/lib/shape.ts';

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

// Claude Code 2.1.293 ignores a hook's `allow` for a plan and draws its own
// "Ready to code?" menu, so the plan is no longer held in tool.check. The
// native menu (next) races the web: a deny takes it down, an approval only
// carries words, and the approve key goes into the pane from session-events.
// tool.check runs inside tool.call's next (2.1.293 types: "after the
// tool.call and PreToolUse hooks"), so the plan arrives once the check asks.
const asked = (plan: string, planFilePath?: string) =>
  Promise.resolve(planFilePath === undefined ? { plan } : { plan, planFilePath });
const planInput = { tool_use_id: 'p1', asked: asked('1. Do it.', '/home/u/.claude/plans/p.md') };
const KEEP_PLANNING = 'The user wants to keep planning. Do not start on the plan yet.';

test('plan: nothing is announced until the check asks', async () => {
  const h = harness();
  const check = deferred<{ plan: string }>();
  void racePlan(h.deps, { tool_use_id: 'p1', asked: check.promise }, () => new Promise(() => {}));
  await settle();
  assert.equal(h.announced.length, 0);
  check.resolve({ plan: '# Later' });
  await settle();
  assert.equal(h.announced[0]?.type, 'plan');
});

test('plan: a call whose check never asked announces and settles nothing', async () => {
  const h = harness();
  const r = await racePlan(h.deps, { tool_use_id: 'p1', asked: new Promise(() => {}) }, async () => ({ result: 'ok' }));
  assert.deepEqual(r, { result: 'ok' });
  assert.deepEqual(h.log, []);
});

test('plan: announced with the plan and its file before the native menu runs', async () => {
  const h = harness();
  let started = false;
  void racePlan(h.deps, planInput, () => { started = true; return new Promise(() => {}); });
  await settle();
  assert.deepEqual(h.announced[0], { type: 'plan', t: 7, toolId: 'p1', plan: '1. Do it.', planFilePath: '/home/u/.claude/plans/p.md' });
  assert.equal(started, true);
});

test('plan: a web deny with words takes the native menu down with them', async () => {
  const h = harness();
  const p = racePlan(h.deps, planInput, () => new Promise<{ result: string }>(() => {}));
  await settle();
  assert.equal(h.deps.web.resolve('p1', { op: 'decide', decision: 'deny', reason: '  use sqlite  ' }), true);
  const r = await p;
  assert.ok('deny' in r && r.deny.includes('wants changes before you start: use sqlite'));
  assert.deepEqual(h.log, ['announce plan p1', 'settled p1 web']);
});

test('plan: a web deny with no words keeps planning', async () => {
  const h = harness();
  const p = racePlan(h.deps, planInput, () => new Promise(() => {}));
  await settle();
  h.deps.web.resolve('p1', { op: 'decide', decision: 'deny' });
  assert.deepEqual(await p, { deny: KEEP_PLANNING });
});

test('plan: a web approval keeps its words and waits for the native menu to go', async () => {
  const h = harness();
  const local = deferred<{ result: string }>();
  const p = racePlan(h.deps, planInput, () => local.promise);
  await settle();
  assert.equal(h.deps.web.resolve('p1', { op: 'decide', decision: 'allow', feedback: '  use sqlite  ' }), true);
  await settle();
  assert.deepEqual(h.feedback, [['p1', 'use sqlite']]);
  assert.deepEqual(h.log, ['announce plan p1'], 'not settled while the menu is up');
  assert.ok(h.deps.web.has('p1'), 'still listening for a later answer');
  local.resolve({ result: 'approved' });
  assert.deepEqual(await p, { result: 'approved' });
  assert.deepEqual(h.log, ['announce plan p1', 'settled p1 web']);
  assert.equal(h.deps.web.resolve('p1', { op: 'decide', decision: 'deny' }), false, 'no waiter once settled');
});

test('plan: a web approval with no words stores none', async () => {
  const h = harness();
  const local = deferred<{ result: string }>();
  const p = racePlan(h.deps, planInput, () => local.promise);
  await settle();
  h.deps.web.resolve('p1', { op: 'decide', decision: 'allow', feedback: '   ' });
  await settle();
  local.resolve({ result: 'approved' });
  await p;
  assert.deepEqual(h.feedback, []);
  assert.deepEqual(h.log, ['announce plan p1', 'settled p1 web']);
});

test('plan: an approval then a deny from the web denies', async () => {
  const h = harness();
  const p = racePlan(h.deps, planInput, () => new Promise(() => {}));
  await settle();
  h.deps.web.resolve('p1', { op: 'decide', decision: 'allow' });
  await settle();
  assert.equal(h.deps.web.resolve('p1', { op: 'decide', decision: 'deny' }), true);
  assert.deepEqual(await p, { deny: KEEP_PLANNING });
  assert.deepEqual(h.log, ['announce plan p1', 'settled p1 web']);
});

test('plan: answered in the terminal with no web command', async () => {
  const h = harness();
  const local = deferred<{ result: string }>();
  const p = racePlan(h.deps, planInput, () => local.promise);
  await settle();
  local.resolve({ result: 'approved' });
  assert.deepEqual(await p, { result: 'approved' });
  assert.deepEqual(h.log, ['announce plan p1', 'settled p1 terminal']);
  assert.equal(h.deps.web.resolve('p1', { op: 'decide', decision: 'allow' }), false);
});

test('plan: a call that rejects once the menu is up settles as gone and rethrows', async () => {
  const h = harness();
  const local = deferred<never>();
  const p = racePlan(h.deps, planInput, () => local.promise);
  await settle();
  local.reject(new Error('aborted'));
  await assert.rejects(p, /aborted/);
  assert.deepEqual(h.log, ['announce plan p1', 'settled p1 gone']);
  assert.equal(h.deps.web.has('p1'), false);
});

test('plan: a call aborted before its check asked rethrows and announces nothing', async () => {
  const h = harness();
  const p = racePlan(h.deps, { tool_use_id: 'p1', asked: new Promise(() => {}) }, () => Promise.reject(new Error('aborted')));
  await assert.rejects(p, /aborted/);
  assert.deepEqual(h.log, []);
});

test('plan: a long plan is capped before it is announced', async () => {
  const h = harness();
  void racePlan(h.deps, { tool_use_id: 'p1', asked: asked('p'.repeat(300_000)) }, () => new Promise(() => {}));
  await settle();
  const ev = h.announced[0];
  assert.ok(ev?.type === 'plan' && ev.plan.length < 270_000 && ev.planFilePath === undefined);
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

// Claude Code 2.1.293 writes some ExitPlanMode calls with an empty input, the
// plan only in its file (2026-10-08). The plan card then reads the file the
// call names, or the one the last plan-mode reminder named.
test('planOf: a plan in the input is used as it is', async () => {
  const read = async () => { throw new Error('read'); };
  assert.deepEqual(await planOf({ plan: '# P', planFilePath: '/p.md' }, '/other.md', read), { plan: '# P', planFilePath: '/p.md' });
});

test('planOf: an empty input reads the plan file it names, else the reminder\'s', async () => {
  const files: Record<string, string> = { '/p.md': '# From p', '/r.md': '# From reminder' };
  const read = async (path: string) => {
    const f = files[path];
    if (f === undefined) throw new Error('no file');
    return f;
  };
  assert.deepEqual(await planOf({ planFilePath: '/p.md' }, '/r.md', read), { plan: '# From p', planFilePath: '/p.md' });
  assert.deepEqual(await planOf({}, '/r.md', read), { plan: '# From reminder', planFilePath: '/r.md' });
  assert.deepEqual(await planOf(undefined, '/r.md', read), { plan: '# From reminder', planFilePath: '/r.md' });
  assert.deepEqual(await planOf({}, '', read), { plan: '' });
  assert.deepEqual(await planOf({}, '/gone.md', read), { plan: '', planFilePath: '/gone.md' });
});
