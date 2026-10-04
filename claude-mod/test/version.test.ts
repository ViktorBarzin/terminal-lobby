import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOD_VERSION } from '../hooks/lib/wire.ts';

// The hello's `mod` is how the lobby tells which sessions run an old copy of
// the mod, which a restart fixes (Viktor, 2026-10-04). Three behaviour
// changes once shipped under one number (Q-F7).

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../.claude-plugin/plugin.json'), 'utf8')) as { version: string };

test('plugin.json and MOD_VERSION name the same version', () => {
  assert.equal(manifest.version, MOD_VERSION);
});

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Against origin/master where the clone has it (a shallow CI checkout does
// not, and skips): hooks/ that differ from master ship as a new version.
test('a change to hooks/ comes with a new version', (t) => {
  const before = git('show', 'origin/master:claude-mod/.claude-plugin/plugin.json');
  const changed = git('diff', '--name-only', 'origin/master', '--', 'hooks');
  if (before === null || changed === null) {
    t.skip('no origin/master in this clone');
    return;
  }
  if (changed.trim() === '') return;
  const old = (JSON.parse(before) as { version: string }).version;
  assert.notEqual(MOD_VERSION, old, `hooks/ changed since origin/master (${changed.trim().split('\n').join(', ')}) but the version is still ${old}`);
});
