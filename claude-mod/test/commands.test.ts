import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CommandDeps, OPS, runCommand } from '../hooks/lib/commands.ts';
import { SeenCommands } from '../hooks/lib/seen.ts';
import { SummaryOnce } from '../hooks/lib/summary.ts';
import type { EventBody } from '../hooks/lib/wire.ts';

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function harness(over: Partial<CommandDeps> = {}) {
  const sent: EventBody[] = [];
  const calls: string[] = [];
  const summaries: string[] = [];
  let main: string | null = null;
  const deps: CommandDeps = {
    send: (ev) => { sent.push(ev); },
    seen: new SeenCommands(),
    commandNames: async () => ['unslop'],
    runSlash: async (call) => { calls.push(`run /${call.command} ${call.args}`); return {}; },
    submit: async (text) => { calls.push(`submit ${text}`); return { text }; },
    turns: async () => 0,
    summary: new SummaryOnce(),
    summarize: (text) => { summaries.push(text); },
    mainTurn: () => main,
    abort: async (turnId) => { calls.push(`abort ${turnId}`); },
    answer: (toolId) => toolId === 'held',
    steer: async () => ({ ok: true }),
    ...over,
  };
  return { deps, sent, calls, summaries, setMain: (t: string | null) => { main = t; } };
}

const types = (sent: EventBody[]) => sent.map((e) => (e.type === 'ack' ? `ack ${e.ok}${e.error ? ` ${e.error}` : ''}` : e.type));

test('a prompt is acked at once, then reported as submitted', async () => {
  const h = harness();
  await runCommand(h.deps, { id: 'c1', op: 'prompt', text: 'hello' });
  await settle();
  assert.deepEqual(types(h.sent), ['ack true', 'prompt']);
  assert.deepEqual(h.sent[1], { type: 'prompt', text: 'hello', origin: { kind: 'plugin', name: 'terminal-lobby', asUser: true } });
  assert.deepEqual(h.calls, ['submit hello']);
});

test('a prompt that opens with a path is submitted without the leading slash', async () => {
  const h = harness();
  await runCommand(h.deps, { id: 'c1', op: 'prompt', text: '/tmp/pasted-1.png what is this?' });
  await settle();
  assert.deepEqual(types(h.sent), ['ack true', 'prompt']);
  assert.deepEqual(h.calls, ['submit \u200b/tmp/pasted-1.png what is this?']);
});

// D-F3/T-F5: the server drops a second ack, so a prompt that fails after the
// first is reported as a command_failed event the Text view can show.
const failures: [string, Partial<CommandDeps>, string][] = [
  ['dropped by a hook', { submit: async () => ({ drop: 'policy says no' }) }, 'dropped: policy says no'],
  ['rejected', { submit: () => Promise.reject(new Error('session ended')) }, 'session ended'],
];
for (const [name, over, error] of failures) {
  test(`a prompt ${name} after its ack is reported as command_failed`, async () => {
    const h = harness(over);
    await runCommand(h.deps, { id: 'c1', op: 'prompt', text: 'hello' });
    await settle();
    assert.deepEqual(types(h.sent), ['ack true', 'command_failed']);
    assert.deepEqual(h.sent[1], { type: 'command_failed', id: 'c1', op: 'prompt', error });
    assert.deepEqual(h.summaries, [], 'a prompt that never entered does not spend the summary');
  });
}

const slashFailures: [string, Partial<CommandDeps>, string][] = [
  ['exits non-zero', { runSlash: async () => ({ exitCode: 2, text: 'no such file' }) }, 'no such file'],
  ['exits non-zero with no text', { runSlash: async () => ({ exitCode: 3 }) }, 'exited 3'],
  ['rejects', { runSlash: () => Promise.reject(new Error('unknown command')) }, 'unknown command'],
];
for (const [name, over, error] of slashFailures) {
  test(`a slash command that ${name} is reported as command_failed`, async () => {
    const h = harness(over);
    await runCommand(h.deps, { id: 'c2', op: 'prompt', text: '/unslop a.md' });
    await settle();
    assert.deepEqual(types(h.sent), ['ack true', 'command_failed']);
    assert.deepEqual(h.sent[1], { type: 'command_failed', id: 'c2', op: 'prompt', error });
  });
}

test('a slash command that runs is acked once and submits nothing', async () => {
  const h = harness();
  await runCommand(h.deps, { id: 'c2', op: 'prompt', text: '/unslop a.md' });
  await settle();
  assert.deepEqual(types(h.sent), ['ack true']);
  assert.deepEqual(h.calls, ['run /unslop a.md']);
});

test('the first prompt of a fresh conversation is summarized once it entered', async () => {
  const h = harness();
  await runCommand(h.deps, { id: 'c1', op: 'prompt', text: 'build it' });
  await runCommand(h.deps, { id: 'c2', op: 'prompt', text: 'and test it' });
  await settle();
  assert.deepEqual(h.summaries, ['build it']);
});

test('a resumed conversation is not summarized', async () => {
  const h = harness({ turns: async () => 4 });
  await runCommand(h.deps, { id: 'c1', op: 'prompt', text: 'more' });
  await settle();
  assert.deepEqual(h.summaries, []);
});

test('a dropped first prompt leaves the summary for the next one', async () => {
  let n = 0;
  const h = harness({ submit: async (text) => (n++ === 0 ? { drop: 'no' } : { text }) });
  await runCommand(h.deps, { id: 'c1', op: 'prompt', text: 'first' });
  await settle();
  await runCommand(h.deps, { id: 'c2', op: 'prompt', text: 'second' });
  await settle();
  assert.deepEqual(h.summaries, ['second']);
});

test('a long prompt is capped in the event, not in what is submitted', async () => {
  const h = harness();
  const text = 'p'.repeat(300_000);
  await runCommand(h.deps, { id: 'c1', op: 'prompt', text });
  await settle();
  const ev = h.sent[1];
  assert.ok(ev?.type === 'prompt' && ev.text.length < 270_000);
  assert.equal(h.calls[0], `submit ${text}`);
});

test('abort stops the main turn the mod knows', async () => {
  const h = harness();
  h.setMain('T1');
  await runCommand(h.deps, { id: 'c3', op: 'abort' });
  assert.deepEqual(h.calls, ['abort T1']);
  assert.deepEqual(types(h.sent), ['ack true']);
});

test('abort with no turn running is refused as idle', async () => {
  const h = harness();
  await runCommand(h.deps, { id: 'c3', op: 'abort' });
  assert.deepEqual(types(h.sent), ['ack false idle']);
});

test('an abort the engine refuses is acked with its error', async () => {
  const h = harness({ abort: () => Promise.reject(new Error('not the running turn')) });
  h.setMain('T1');
  await runCommand(h.deps, { id: 'c3', op: 'abort' });
  assert.deepEqual(types(h.sent), ['ack false not the running turn']);
});

for (const op of ['answer', 'decide']) {
  test(`${op} reaches a held dialog, or is acked gone`, async () => {
    const h = harness();
    await runCommand(h.deps, { id: 'c4', op, toolId: 'held' });
    await runCommand(h.deps, { id: 'c5', op, toolId: 'other' });
    assert.deepEqual(types(h.sent), ['ack true', 'ack false gone']);
  });
}

test('steer passes the engine\'s refusal on', async () => {
  const h = harness({ steer: async () => ({ ok: false, error: 'finished: done' }) });
  await runCommand(h.deps, { id: 'c6', op: 'steer', agentId: 'a1', text: 'hi' });
  assert.deepEqual(types(h.sent), ['ack false finished: done']);
});

// D-F11/T-F12: the server never sends them, and `model` raised Claude's own
// "Switch model?" confirm.
for (const op of ['model', 'history', 'nope']) {
  test(`${op} is an unknown op`, async () => {
    const h = harness();
    await runCommand(h.deps, { id: 'c7', op });
    assert.deepEqual(types(h.sent), [`ack false unknown op ${op}`]);
  });
}

test('OPS names what runCommand runs, and the hello ops the server reads', () => {
  assert.deepEqual([...OPS], ['prompt', 'abort', 'answer', 'decide', 'steer', 'level', 'decide-feedback', 'plan-keys']);
});

test('a command sent again after a re-hello is only acked again', async () => {
  const h = harness();
  h.setMain('T1');
  await runCommand(h.deps, { id: 'c8', op: 'abort' });
  await runCommand(h.deps, { id: 'c8', op: 'abort' });
  assert.deepEqual(h.calls, ['abort T1']);
  assert.deepEqual(types(h.sent), ['ack true', 'ack true']);
});
