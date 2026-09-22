#!/usr/bin/env node
// Fails on any -Woverflow the C compiler reports for src/parser.c.
//
// tree-sitter stores dynamic precedence as int16_t, so a `prec.dynamic` value
// past 32767 wraps silently in the generated tables. The include directive
// asked for 1,000,000 and got 16,960, and every build (editors included)
// printed 18 warnings that nobody here read (tree-sitter-carve#385).
//
// A probe that must warn runs first: a compiler that never emits the warning
// would otherwise pass this check without looking.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cc = process.env.CC || 'cc';

const compile = (file) => {
  const result = spawnSync(
    cc,
    ['-fsyntax-only', '-Woverflow', '-I', path.join(repoRoot, 'src'), file],
    { encoding: 'utf8' },
  );
  if (result.error) {
    console.error(`parser-warnings: cannot run ${cc}: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`parser-warnings: ${cc} failed on ${file}:\n${result.stderr}`);
    process.exit(2);
  }
  return result.stderr.split('\n').filter((line) => line.includes('[-Woverflow]'));
};

const scratch = mkdtempSync(path.join(tmpdir(), 'parser-warnings-'));
try {
  const probe = path.join(scratch, 'probe.c');
  writeFileSync(probe, 'short probe = 1000000;\n');
  if (compile(probe).length === 0) {
    console.error(`parser-warnings: ${cc} does not report -Woverflow, so this check cannot see one`);
    process.exit(2);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const found = compile(path.join(repoRoot, 'src', 'parser.c'));
if (found.length > 0) {
  console.error(`parser-warnings: ${found.length} -Woverflow warning(s) in src/parser.c:`);
  for (const line of found.slice(0, 5)) console.error(`  ${line}`);
  console.error('A value in grammar.js does not fit the table it is generated into (dynamic precedence is int16_t).');
  process.exit(1);
}
console.log(`parser-warnings: src/parser.c compiles with no -Woverflow (${cc})`);
