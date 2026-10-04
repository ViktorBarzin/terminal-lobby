// Type-checks hooks/ and test/ against Claude Code's plugin API declarations.
//
// The declarations are Claude Code's own and are not vendored into this
// repository. Claude Code writes them beside a mod it loads from a folder the
// person owns (.claude-plugin/types/, after `claude --plugin-dir claude-mod`),
// and into the plugin-authoring skill's folder as that skill loads
// (/var/tmp/claude-<uid>/bundled-skills/<version>/<hash>/plugin-authoring/types/).
// This takes the newest version found in either place, or CLAUDE_CODE_TYPES
// when set to a claude-code.d.ts, writes two configs under .typecheck/ and runs
// tsc on each: hooks/ alone, with no Node types (the module runs with no
// Node), then hooks/ and test/ with Node's.
//
// Usage: npm install && npm run typecheck

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

type Found = { files: string[]; version: number[]; mtime: number; where: string };

function versionOf(file: string): number[] {
  const first = readFileSync(file, 'utf8').slice(0, 200).split('\n')[0] ?? '';
  const m = /Written by Claude Code (\d+)\.(\d+)\.(\d+)/.exec(first);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function found(files: string[], where: string): Found {
  const main = files[0] ?? '';
  return { files, version: versionOf(main), mtime: statSync(main).mtimeMs, where };
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function candidates(): Found[] {
  const out: Found[] = [];
  const env = process.env.CLAUDE_CODE_TYPES;
  if (env) return [found([env], 'CLAUDE_CODE_TYPES')];
  const laid = join(root, '.claude-plugin/types');
  const api = join(laid, 'claude-code/index.d.ts');
  if (existsSync(api)) {
    const tools = join(laid, 'claude-code-tools/index.d.ts');
    out.push(found(existsSync(tools) ? [api, tools] : [api], laid));
  }
  for (const user of list('/var/tmp').filter((d) => d.startsWith('claude-'))) {
    const skills = join('/var/tmp', user, 'bundled-skills');
    for (const version of list(skills)) {
      for (const hash of list(join(skills, version))) {
        const file = join(skills, version, hash, 'plugin-authoring/types/claude-code.d.ts');
        if (existsSync(file)) out.push(found([file], file));
      }
    }
  }
  return out;
}

function newer(a: Found, b: Found): number {
  for (let i = 0; i < 3; i++) {
    const d = (a.version[i] ?? 0) - (b.version[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.mtime - b.mtime;
}

const best = candidates().sort(newer).at(-1);
if (!best) {
  console.error('typecheck: no Claude Code plugin declarations found. Load the mod once with `claude --plugin-dir claude-mod`,\n'
    + 'open the plugin-authoring skill in any session, or set CLAUDE_CODE_TYPES to a claude-code.d.ts.');
  process.exit(2);
}
const tsc = join(root, 'node_modules/.bin/tsc');
if (!existsSync(tsc)) {
  console.error('typecheck: TypeScript is not installed here; run `npm install` in claude-mod first.');
  process.exit(2);
}
console.log(`typecheck: Claude Code ${best.version.join('.')} declarations from ${best.where}`);

// The engine's recommended settings for a hooks module (the header of its
// declarations), plus importing the mod's own .ts files by name.
const compilerOptions = {
  target: 'es2023',
  lib: ['es2023'],
  module: 'esnext',
  moduleResolution: 'bundler',
  strict: true,
  noUncheckedIndexedAccess: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
};
const out = join(root, '.typecheck');
mkdirSync(out, { recursive: true });
const configs = {
  hooks: { compilerOptions: { ...compilerOptions, types: [] }, files: best.files, include: ['../hooks/**/*.ts'] },
  tests: {
    compilerOptions: { ...compilerOptions, types: ['node'], typeRoots: ['../node_modules/@types'] },
    files: best.files,
    include: ['../hooks/**/*.ts', '../test/**/*.ts', '../scripts/**/*.ts'],
  },
};
let failed = false;
for (const [name, config] of Object.entries(configs)) {
  const path = join(out, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  try {
    execFileSync(tsc, ['-p', path], { stdio: 'inherit' });
    console.log(`typecheck: ${name} clean`);
  } catch {
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
