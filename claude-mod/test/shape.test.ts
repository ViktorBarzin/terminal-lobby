import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs, capStrings, decisionFromLabel, dialogFor, isOwnDialog, projectSlug, shapeResult, shapeRow,
  stripMedia, transcriptPath, webAnswer, webAnswerResult, TEXT_CAP,
} from '../hooks/lib/shape.ts';

test('backoff doubles from 1 s, caps at 30 s, and jitters within [half, full]', () => {
  for (const [attempt, full] of [[0, 1000], [1, 2000], [2, 4000], [4, 16000], [5, 30000], [12, 30000]]) {
    assert.equal(backoffMs(attempt, () => 0), full / 2);
    assert.equal(backoffMs(attempt, () => 0.999999), Math.round(full / 2 + 0.999999 * full / 2));
  }
});

test('project slug replaces every non-alphanumeric character with a dash', () => {
  assert.equal(projectSlug('/home/wizard/code/terminal-lobby/.worktrees/claude-mod-events'),
    '-home-wizard-code-terminal-lobby--worktrees-claude-mod-events');
  assert.equal(projectSlug('/tmp/a b_c'), '-tmp-a-b-c');
});

test('transcript path sits under the config dir projects folder', () => {
  assert.equal(transcriptPath('/home/u/.claude', '/home/u/code', 'abc'),
    '/home/u/.claude/projects/-home-u-code/abc.jsonl');
});

test('stripMedia empties base64 data and records its decoded size', () => {
  const content = [
    { type: 'text', text: 'see' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    { type: 'tool_result', tool_use_id: 'x', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ] },
  ];
  const out = stripMedia(content) as typeof content;
  assert.deepEqual(out[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, bytes: 5 });
  assert.deepEqual((out[2].content as unknown[])[0],
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, bytes: 3 });
  assert.equal(content[1].source?.data, 'aGVsbG8=', 'input untouched');
});

test('stripMedia empties a base64 field in a tool result object', () => {
  const out = stripMedia({ type: 'image', file: { base64: 'YWJjZA==', type: 'image/png' } });
  assert.deepEqual(out, { type: 'image', file: { base64: '', type: 'image/png', bytes: 4 } });
});

test('capStrings truncates long strings and marks how much was cut', () => {
  const long = 'x'.repeat(30);
  assert.deepEqual(capStrings({ a: [long, 'short'] }, 10),
    { a: ['xxxxxxxxxx\n[... 20 more characters]', 'short'] });
});

test('shapeRow forwards the stored row with media stripped', () => {
  const ev = shapeRow(
    { door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'in-uuid', agentId: 'a1' },
    { uuid: 'stored-uuid', message: { type: 'assistant', role: 'assistant', content: [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ] } },
    42,
  );
  assert.deepEqual(ev, {
    type: 'row', t: 42, uuid: 'stored-uuid', door: 'response', origin: { kind: 'model', model: 'm' },
    agentId: 'a1',
    message: { type: 'assistant', role: 'assistant', content: [
      { type: 'text', text: 'hi' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' }, bytes: 3 },
    ] },
  });
});

test('shapeRow leaves out absent optional fields and caps a huge text block', () => {
  const ev = shapeRow(
    { door: 'prompt', origin: { kind: 'composer' }, uuid: 'u' },
    { uuid: 'u', message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'y'.repeat(TEXT_CAP + 5) }] } },
    1,
  );
  assert.equal('agentId' in ev, false);
  const text = (ev.message as { content: { text: string }[] }).content[0].text;
  assert.ok(text.startsWith('y'.repeat(TEXT_CAP)));
  assert.ok(text.endsWith('[... 5 more characters]'));
});

test('shapeResult carries the tool outcome', () => {
  const ev = shapeResult(
    { tool: 'Bash', tool_use_id: 'toolu_1', agentId: undefined },
    { result: { stdout: 'hello' }, text: 'hello', ref: 1, isReadOnly: true },
    7,
  );
  assert.deepEqual(ev, { type: 'result', t: 7, toolId: 'toolu_1', tool: 'Bash', result: { stdout: 'hello' }, text: 'hello' });
});

test('shapeResult marks an error and a denial', () => {
  assert.equal(shapeResult({ tool: 'Bash', tool_use_id: 't' }, { isError: true, result: 'boom', text: 'boom' }, 1).isError, true);
  const denied = shapeResult({ tool: 'Bash', tool_use_id: 't' }, { deny: 'no' }, 1);
  assert.equal(denied.isError, true);
  assert.equal(denied.text, 'no');
});

test('webAnswerResult maps question text to labels and joins multi-select', () => {
  const questions = [
    { question: 'Fruit?', header: 'F', options: [{ label: 'Apple' }, { label: 'Pear' }], multiSelect: false },
    { question: 'Pets?', header: 'P', options: [{ label: 'Cat' }, { label: 'Dog' }], multiSelect: true },
  ];
  assert.deepEqual(webAnswerResult(questions, { 'Fruit?': 'Pear', 'Pets?': ['Cat', 'Dog'] }, undefined), {
    questions, answers: { 'Fruit?': 'Pear', 'Pets?': 'Cat, Dog' }, annotations: {},
  });
});

test('webAnswerResult passes the server answers and annotations through as given', () => {
  const questions = [{ question: 'Fruit?', options: [{ label: 'Apple' }, { label: 'Pear' }] }];
  const r = webAnswerResult(questions, { 'Fruit?': 'Apple', 'Other?': 'x' }, { 'Fruit?': { notes: 'n' } });
  assert.deepEqual(r.answers, { 'Fruit?': 'Apple', 'Other?': 'x' });
  assert.deepEqual(r.annotations, { 'Fruit?': { notes: 'n' } });
});

test('webAnswer turns a chat answer into a denial carrying the text verbatim', () => {
  const questions = [{ question: 'Fruit?', options: [{ label: 'Apple' }, { label: 'Pear' }] }];
  assert.deepEqual(webAnswer(questions, { chat: 'Let us talk about\nthe options first.' }),
    { deny: 'Let us talk about\nthe options first.' });
  assert.deepEqual(webAnswer(questions, { chat: '' }), { deny: '' });
  assert.deepEqual(webAnswer(questions, { answers: { 'Fruit?': 'Pear' } }),
    { result: { questions, answers: { 'Fruit?': 'Pear' }, annotations: {} } });
});

test('dialogFor a plan offers approve and keep planning', () => {
  const d = dialogFor('ExitPlanMode', { plan: '# Plan' });
  assert.deepEqual(d.options, ['Approve plan', 'Keep planning']);
  assert.match(d.question, /plan/i);
  assert.ok(d.question.endsWith('?'));
});

test('dialogFor a plan shows the plan, cut when it is very long', () => {
  assert.ok(dialogFor('ExitPlanMode', { plan: '1. Write x\n2. Test x' }).question.includes('1. Write x\n2. Test x'));
  const long = dialogFor('ExitPlanMode', { plan: 'p'.repeat(20000) }).question;
  assert.ok(long.length < 5000, `question was ${long.length} chars`);
  assert.match(long, /\/plan/);
});

test('dialogFor a permission names the tool and what it will do', () => {
  assert.match(dialogFor('Bash', { command: 'rm -rf build' }).question, /Bash.*rm -rf build/);
  assert.match(dialogFor('Write', { file_path: '/tmp/x', content: 'y' }).question, /Write.*\/tmp\/x/);
  assert.match(dialogFor('WebFetch', { url: 'https://e.com', prompt: 'p' }).question, /https:\/\/e\.com/);
  const d = dialogFor('mcp__x__y', { a: 1 });
  assert.deepEqual(d.options, ['Allow', 'Deny']);
  assert.match(d.question, /mcp__x__y.*"a":1/);
});

test('dialogFor keeps a long command short enough for a dialog', () => {
  const q = dialogFor('Bash', { command: 'echo ' + 'z'.repeat(2000) }).question;
  assert.ok(q.length < 400, `question was ${q.length} chars`);
  assert.ok(q.endsWith('?'));
});

test('isOwnDialog recognises the mod dialogs as $.ui.ask hands them to tool.call', () => {
  const asked = (tool: string, input: unknown) => {
    const d = dialogFor(tool, input);
    return [{ question: d.question, header: d.header, multiSelect: false, options: d.options.map((label) => ({ label })) }];
  };
  assert.equal(isOwnDialog(asked('Bash', { command: 'echo a\necho b' })), true);
  assert.equal(isOwnDialog(asked('ExitPlanMode', { plan: '1. do x' })), true);
  assert.equal(isOwnDialog(asked('mcp__x__y', { a: 1 })), true);
});

test('isOwnDialog leaves the model questions alone', () => {
  assert.equal(isOwnDialog([{ question: 'Which fruit?', header: 'Fruit', options: [{ label: 'Apple' }, { label: 'Pear' }] }]), false);
  assert.equal(isOwnDialog([{ question: 'Allow it?', header: 'Permission', options: [{ label: 'Allow' }, { label: 'Deny' }, { label: 'Ask later' }] }]), false);
  assert.equal(isOwnDialog([{ question: 'Ship it?', header: 'Release', options: [{ label: 'Allow' }, { label: 'Deny' }] }]), false);
  assert.equal(isOwnDialog([
    { question: 'Allow Bash: ls?', header: 'Permission', options: [{ label: 'Allow' }, { label: 'Deny' }] },
    { question: 'And?', header: 'More', options: [{ label: 'A' }, { label: 'B' }] },
  ]), false);
  assert.equal(isOwnDialog([]), false);
});

test('decisionFromLabel maps the dialog answer to a tool.check result', () => {
  assert.deepEqual(decisionFromLabel('ExitPlanMode', 'Approve plan'), { decision: 'allow' });
  assert.deepEqual(decisionFromLabel('Bash', 'Allow'), { decision: 'allow' });
  assert.equal(decisionFromLabel('ExitPlanMode', 'Keep planning').decision, 'deny');
  assert.equal(decisionFromLabel('Bash', 'Deny').decision, 'deny');
  assert.deepEqual(decisionFromLabel('Bash', 'use the dry-run flag first'),
    { decision: 'deny', reason: 'use the dry-run flag first' });
});
