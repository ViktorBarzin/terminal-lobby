import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Level, WORKFLOW_MAX_MS, WORKFLOW_QUIET_MS } from '../hooks/lib/level.ts';
import type { TerminalLobbyLevel } from '../hooks/state.d.ts';
import { ask, permission } from './events.ts';

function tracked() {
  const saves: TerminalLobbyLevel[] = [];
  const lv = new Level((s) => saves.push(s));
  return { lv, saves };
}

const snap = (lv: Level) => lv.level([], 0);

test('a main turn runs from turn.start to turn.complete', () => {
  const { lv } = tracked();
  assert.equal(snap(lv).running, false);
  lv.turnStarted('T1');
  assert.equal(snap(lv).running, true);
  lv.turnEnded('T1', undefined);
  assert.equal(snap(lv).running, false);
});

test('a subagent turn ending leaves the main turn running', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.turnEnded('S1', 'a1');
  assert.equal(snap(lv).running, true);
});

// L-F4: a module loaded or reloaded mid-turn never sees that turn's
// turn.start, so it learns the turn from the next main step, or from a
// prompt typed into it.
test('a main step re-learns the turn a reload forgot; a subagent step does not', () => {
  const { lv } = tracked();
  lv.stepped('S1', 'a1', 0);
  assert.equal(lv.mainTurn, null);
  lv.stepped('T1', undefined, 0);
  assert.equal(lv.mainTurn, 'T1');
  assert.equal(snap(lv).running, true);
});

test('a prompt typed during a turn names that turn', () => {
  const { lv } = tracked();
  lv.promptSubmitted('T7', 'and also this');
  assert.equal(lv.mainTurn, 'T7');
  lv.promptSubmitted(undefined, 'idle prompt');
  assert.equal(lv.mainTurn, 'T7', 'a prompt with no turn says nothing about one');
});

test('the main loop runs one turn at a time, so any main end closes the turn', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.turnEnded('T0', undefined);
  assert.equal(lv.mainTurn, null);
});

test('the tool in flight is the main thread\'s latest, and subagent tools do not count', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.toolStarted('t1', undefined);
  lv.toolStarted('t2', undefined);
  lv.toolStarted('s1', 'a1');
  assert.equal(snap(lv).tool, 't2');
  lv.toolEnded('t2');
  assert.equal(snap(lv).tool, 't1');
  lv.toolEnded('t1');
  assert.equal(snap(lv).tool, '');
});

test('a main turn end clears the tools it left in flight', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.toolStarted('t1', undefined);
  lv.turnEnded('T1', undefined);
  assert.equal(snap(lv).tool, '');
});

test('compaction shows in the level while it runs', () => {
  const { lv } = tracked();
  lv.compacting(true);
  assert.equal(snap(lv).compacting, true);
  lv.compacting(false);
  assert.equal(snap(lv).compacting, false);
});

test('open dialogs are listed oldest first and leave when settled', () => {
  const { lv } = tracked();
  lv.open(ask('q1'));
  lv.open(permission('p1'));
  assert.deepEqual(snap(lv).asks, ['q1', 'p1']);
  assert.deepEqual(lv.dialogs().map((d) => d.toolId), ['q1', 'p1']);
  lv.settle('q1');
  assert.deepEqual(snap(lv).asks, ['p1']);
});

// Contract item 11 (L-F7, D-F5): when the mod's own dialog fails, Claude draws
// its own for the same call. It stays announced until the tool's result or
// the main turn's end.
test('a dialog handed to Claude\'s own menu stays until its tool finishes', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.open(permission('p1'));
  lv.handOver('p1');
  assert.deepEqual(snap(lv).asks, ['p1']);
  lv.toolEnded('p1');
  assert.deepEqual(snap(lv).asks, []);
});

test('a handed-over dialog leaves at the main turn end; a held one stays', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.open(permission('native'));
  lv.handOver('native');
  lv.open(permission('held'));
  lv.turnEnded('T1', undefined);
  assert.deepEqual(snap(lv).asks, ['held']);
});

test('a tool that finishes takes its dialog with it, held or not', () => {
  const { lv } = tracked();
  lv.open(ask('q1'));
  lv.toolEnded('q1');
  assert.deepEqual(snap(lv).asks, []);
});

// Contract item 10 (S-F3): tool.check carries no agentId, so the mod places a
// call by the stored row that asked for it.
test('a tool call is placed in the loop whose row asked for it', () => {
  const { lv } = tracked();
  lv.rowSeen('a1', [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: {} }]);
  lv.rowSeen(undefined, [{ type: 'tool_use', id: 'toolu_main', name: 'Bash', input: {} }]);
  lv.rowSeen('a1', 'not blocks');
  assert.equal(lv.agentOf('toolu_9'), 'a1');
  assert.equal(lv.agentOf('toolu_main'), undefined);
  assert.equal(lv.agentOf('nope'), undefined);
});

const launched = (taskId: string) => ({ status: 'async_launched', taskId, workflowName: 'release', summary: 'Cut it' });

// Measured 2026-10-04 (2.1.289): classic.Stop never reaches the mod, the
// engine's list never names a workflow, the Workflow tool answers its task id
// at once, and a task notification naming that id ends the run (L-F5).
test('a launched workflow counts as background work until its notification', () => {
  const { lv } = tracked();
  assert.equal(lv.workflowLaunched(launched('w1')), true);
  assert.deepEqual(lv.agents([]), [{ id: 'w1', type: 'workflow', status: 'running', name: 'release', description: 'Cut it' }]);
  lv.promptSubmitted(undefined, '<task-notification>\n<task-id>other</task-id>');
  assert.equal(lv.agents([]).length, 1);
  lv.promptSubmitted(undefined, '<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>');
  assert.deepEqual(lv.agents([]), []);
});

test('a Workflow result that launched nothing adds nothing', () => {
  const { lv } = tracked();
  for (const r of [undefined, null, 'x', { status: 'remote_launched', taskId: 'r1' }, { status: 'async_launched' }]) {
    assert.equal(lv.workflowLaunched(r), false);
  }
  assert.deepEqual(lv.agents([]), []);
});

test('the engine\'s entry wins over a workflow with the same id', () => {
  const { lv } = tracked();
  lv.workflowLaunched(launched('x1'));
  const engine = [{ id: 'x1', type: 'general-purpose', status: 'running' as const }];
  assert.deepEqual(lv.agents(engine), engine);
});

test('a workflow whose members have gone quiet that long is dropped', () => {
  const { lv } = tracked();
  lv.workflowLaunched(launched('w1'), 0);
  assert.equal(lv.expire(WORKFLOW_QUIET_MS - 1), false);
  assert.equal(lv.agents([]).length, 1);
  assert.equal(lv.expire(WORKFLOW_QUIET_MS + 1), true);
  assert.deepEqual(lv.agents([]), []);
});

test('an unlisted loop stepping, or running a tool, keeps workflows alive; a listed agent does not', () => {
  const { lv } = tracked();
  lv.workflowLaunched(launched('w1'), 0);
  lv.listed(['a-listed']);
  lv.stepped('S', 'a-listed', WORKFLOW_QUIET_MS);
  assert.equal(lv.expire(WORKFLOW_QUIET_MS + 1), true, 'a listed agent is not a workflow member');

  lv.workflowLaunched(launched('w2'), 0);
  lv.stepped('S', 'member', WORKFLOW_QUIET_MS);
  assert.equal(lv.expire(WORKFLOW_QUIET_MS + 1), false);

  lv.toolStarted('long', 'member');
  assert.equal(lv.expire(10 * WORKFLOW_QUIET_MS), false, 'a member tool in flight keeps it');
  lv.toolEnded('long');
  assert.equal(lv.expire(10 * WORKFLOW_QUIET_MS), true);
});

test('the level carries agents, asks and the turn together', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.toolStarted('t1', undefined);
  lv.open(ask('q1'));
  const agents = [{ id: 'a1', type: 'Explore', status: 'waiting' as const }];
  assert.deepEqual(lv.level(agents, 42), {
    type: 'level', t: 42, running: true, compacting: false, tool: 't1', agents, asks: ['q1'],
  });
});

test('reset forgets the conversation: turn, tools, dialogs, workflows, compaction', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.toolStarted('t1', undefined);
  lv.open(ask('q1'));
  lv.compacting(true);
  lv.workflowLaunched(launched('w1'));
  lv.reset();
  assert.deepEqual(lv.level(lv.agents([]), 0), {
    type: 'level', t: 0, running: false, compacting: false, tool: '', agents: [], asks: [],
  });
});

test('every change to what survives a reload is saved', () => {
  const { lv, saves } = tracked();
  lv.turnStarted('T1');
  lv.open(ask('q1'));
  lv.workflowLaunched(launched('w1'));
  lv.toolStarted('t1', undefined);
  lv.compacting(true);
  assert.equal(saves.length, 3, 'tools and compaction are not kept across a reload');
  assert.deepEqual(saves.at(-1), {
    mainTurn: 'T1', dialogs: [ask('q1')], native: [], workflows: [{ id: 'w1', launchedAt: 0, name: 'release', description: 'Cut it' }],
  });
  lv.stepped('T1', undefined, 0);
  assert.equal(saves.length, 3, 'a step of the known turn changes nothing');
});

// L-F4/S-F8: after a reload, the restored dialogs are no longer held by this
// module's hooks, so they are treated as Claude's own: the main turn end or
// their tool's result takes them off.
test('restore brings back the turn, dialogs and workflows a reload would lose', () => {
  const { lv } = tracked();
  lv.restore({ mainTurn: 'T1', dialogs: [ask('q1')], native: [], workflows: [{ id: 'w1', name: 'release' }] }, 0);
  assert.equal(lv.mainTurn, 'T1');
  assert.deepEqual(snap(lv).asks, ['q1']);
  assert.deepEqual(lv.agents([]).map((a) => a.id), ['w1']);
  assert.equal(lv.expire(WORKFLOW_QUIET_MS - 1), false, 'a restored workflow gets a fresh quiet window');
  lv.turnEnded('T1', undefined);
  assert.deepEqual(snap(lv).asks, []);
});

test('restore ignores a value that is not a saved level', () => {
  const { lv } = tracked();
  lv.restore(undefined, 0);
  lv.restore({ mainTurn: 5, dialogs: 'x' }, 0);
  assert.deepEqual(lv.level(lv.agents([]), 0).asks, []);
  assert.equal(lv.mainTurn, null);
});

// Refute finding 2. A dialog Claude draws itself is off the screen once the
// loop it blocked moves on: the main loop's next step or tool call, or the
// subagent's next step or turn end. The main turn ending says nothing about a
// subagent's dialog.
test('a restored subagent dialog leaves when that agent moves on, main idle', () => {
  const { lv } = tracked();
  lv.restore({ mainTurn: null, dialogs: [{ ...permission('toolu_X'), agentId: 'a1' }], native: [], workflows: [] }, 0);
  lv.stepped('t-other', 'a2', 1000);
  assert.deepEqual(snap(lv).asks, ['toolu_X'], 'another agent moving on says nothing');
  lv.stepped('t-sub', 'a1', 1000);
  assert.deepEqual(snap(lv).asks, []);
});

test('a restored subagent dialog leaves at that agent\'s turn end', () => {
  const { lv } = tracked();
  lv.restore({ mainTurn: null, dialogs: [{ ...permission('toolu_X'), agentId: 'a1' }], native: [], workflows: [] }, 0);
  lv.turnEnded('t-sub', 'a1');
  assert.deepEqual(snap(lv).asks, []);
});

test('a restored main-thread dialog leaves at the next main step or tool call', () => {
  for (const moveOn of [(l: Level) => l.stepped('T1', undefined, 1000), (l: Level) => l.toolStarted('toolu_next', undefined)]) {
    const { lv } = tracked();
    lv.restore({ mainTurn: 'T1', dialogs: [permission('toolu_M')], native: [], workflows: [] }, 0);
    lv.stepped('S', 'a1', 1000);
    assert.deepEqual(snap(lv).asks, ['toolu_M'], 'a subagent moving on says nothing');
    moveOn(lv);
    assert.deepEqual(snap(lv).asks, []);
  }
});

test('a handed-over subagent dialog survives the main turn end while still on screen', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.open({ ...permission('toolu_S'), agentId: 'a1' });
  lv.handOver('toolu_S');
  lv.turnEnded('T1', undefined);
  assert.deepEqual(snap(lv).asks, ['toolu_S']);
  lv.turnEnded('t-sub', 'a1');
  assert.deepEqual(snap(lv).asks, []);
});

test('a held dialog is not cleared by the loop moving on; only a handed-over one is', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.open(permission('held'));
  lv.stepped('T1', undefined, 1);
  lv.toolStarted('other', undefined);
  assert.deepEqual(snap(lv).asks, ['held']);
});

// Refute NIT 7.
test('a prompt.submit naming a turn that already ended does not re-open it', () => {
  const { lv } = tracked();
  lv.turnStarted('T1');
  lv.turnEnded('T1', undefined);
  lv.promptSubmitted('T1', 'typed at the edge of the turn');
  assert.equal(snap(lv).running, false);
  lv.promptSubmitted('T2', 'into the next turn');
  assert.equal(snap(lv).running, true);
});

// Refute finding 1: the level carries the last main reply and the newest
// PushNotification, which a snapshot would otherwise drop with their events.
test('the level carries the last main reply and the newest notice', () => {
  const { lv, saves } = tracked();
  assert.equal('reply' in snap(lv), false);
  assert.equal('notice' in snap(lv), false);
  lv.turnStarted('T1');
  lv.answered(undefined, 'Deployed v2', 10);
  lv.answered('a1', 'subagent words', 11);
  lv.answered(undefined, '   ', 12);
  lv.rowSeen(undefined, [{ type: 'tool_use', id: 't', name: 'PushNotification', input: { message: 'Build is green' } }], 13);
  lv.rowSeen('a1', [{ type: 'tool_use', id: 't2', name: 'PushNotification', input: { message: 'from a subagent' } }], 14);
  lv.rowSeen(undefined, [{ type: 'tool_use', id: 't3', name: 'mcp__x__PushNotification', input: { message: '' } }], 15);
  const s = snap(lv);
  assert.deepEqual(s.reply, { t: 10, text: 'Deployed v2' });
  assert.deepEqual(s.notice, { t: 13, text: 'Build is green' });
  assert.deepEqual(saves.at(-1)?.reply, { t: 10, text: 'Deployed v2' }, 'kept across a reload');
  lv.reset();
  assert.equal('reply' in snap(lv), false);
});

test('a long reply or notice is cut to what the server keeps', () => {
  const { lv } = tracked();
  lv.answered(undefined, 'r'.repeat(5000), 1);
  lv.rowSeen(undefined, [{ type: 'tool_use', id: 't', name: 'PushNotification', input: { message: 'n'.repeat(5000) } }], 2);
  assert.equal(snap(lv).reply?.text.length, 1000);
  assert.equal(snap(lv).notice?.text.length, 1000);
});

test('restore brings back the reply and notice', () => {
  const { lv } = tracked();
  lv.restore({
    mainTurn: null, dialogs: [], native: [], workflows: [], reply: { t: 1, text: 'r' }, notice: { t: 2, text: 'n' },
  }, 0);
  assert.deepEqual(snap(lv).reply, { t: 1, text: 'r' });
  assert.deepEqual(snap(lv).notice, { t: 2, text: 'n' });
});

// Refute NIT 9: activity from forks keeps runs alive, so a run whose
// notification never came is dropped a day after its launch whatever else
// happened.
test('a workflow is dropped a day after its launch, through a reload too', () => {
  const { lv, saves } = tracked();
  lv.workflowLaunched(launched('w1'), 0);
  lv.stepped('S', 'member', WORKFLOW_MAX_MS - 1);
  assert.equal(lv.expire(WORKFLOW_MAX_MS - 1), false);
  const saved = saves.at(-1);
  const again = tracked().lv;
  again.restore(saved, WORKFLOW_MAX_MS - 1);
  again.stepped('S', 'member', WORKFLOW_MAX_MS + 1);
  assert.equal(again.expire(WORKFLOW_MAX_MS + 1), true);
});
