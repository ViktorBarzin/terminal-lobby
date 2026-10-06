import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asProse, slashCall } from '../hooks/lib/command.ts';

// A prompt from the lobby that names a slash command runs it, the way the
// typed `/name args` does. $.prompt.submit hands any text to the model as a
// user turn, so "/unslop" sent that way ran nothing (measured on CLI 2.1.289,
// 2026-10-04: POST /prompt answered 204 and the pane never moved).

const names = ['unslop', 'compact', 'doc-tone', 'frontend-design:frontend-design'];

test('a bare command runs with no args', () => {
  assert.deepEqual(slashCall('/unslop', names), { command: 'unslop', args: '' });
});

test('everything after the name is its args, newlines included', () => {
  assert.deepEqual(slashCall('/doc-tone docs/a.md\nkeep the numbers', names), {
    command: 'doc-tone',
    args: 'docs/a.md\nkeep the numbers',
  });
});

test('surrounding whitespace does not stop it', () => {
  assert.deepEqual(slashCall('  /compact  \n', names), { command: 'compact', args: '' });
});

test('a plugin skill runs by its namespaced name', () => {
  assert.deepEqual(slashCall('/frontend-design:frontend-design a login page', names), {
    command: 'frontend-design:frontend-design',
    args: 'a login page',
  });
});

for (const text of [
  'please run /unslop on this', // not the whole prompt, so it is prose
  '/usr/bin is missing jq', // a path, not a command
  '/nosuchskill do it', // a name this session does not have
  '/', // a slash on its own
  'unslop',
]) {
  test(`stays a prompt: ${JSON.stringify(text)}`, () => {
    assert.equal(slashCall(text, names), null);
  });
}

// $.prompt.submit refuses a text that starts with a slash once leading
// whitespace is trimmed (CLI 2.1.290: "a text beginning with / would run a
// command as the user"). A prompt opening with a pasted image starts with its
// path, so it went nowhere (2026-10-06).
for (const [name, text, sent] of [
  ['a pasted image first', '/var/lib/clipboard-store/u/s/pasted-1.png what is this?', '\u200b/var/lib/clipboard-store/u/s/pasted-1.png what is this?'],
  ['a path first', '/usr/bin is missing jq', '\u200b/usr/bin is missing jq'],
  ['a path after leading whitespace', '\n  /tmp/a.png', '\u200b/tmp/a.png'],
  ['an unknown name', '/nosuchskill do it', '\u200b/nosuchskill do it'],
] as const) {
  test(`prose with ${name} goes in behind a zero-width space`, () => {
    assert.equal(asProse(text), sent);
    assert.ok(!asProse(text).trimStart().startsWith('/'));
  });
}

for (const text of ['hello', 'see /tmp/a.png', '  indented prose']) {
  test(`prose that does not start with a slash is untouched: ${JSON.stringify(text)}`, () => {
    assert.equal(asProse(text), text);
  });
}
