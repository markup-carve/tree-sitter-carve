#!/usr/bin/env node
// Shared-corpus conformance check.
//
// For every `.crv` input in the shared Carve spec corpus (spec/tests/corpus)
// that belongs to a COVERED category (see test/coverage.json), parse it with
// the generated tree-sitter grammar and assert the resulting tree contains no
// ERROR and no MISSING node. A spec construct the grammar chokes on fails CI.
//
// Files in SKIP categories are not asserted here (they have a recorded grammar
// gap), and a skip key may also name a single EXAMPLE (`NN-slug-2`) so one
// unparsable example does not drop assertion for its whole category. The
// coverage-matrix check is what guards the skip list itself.
//
// Parsing is delegated to the `tree-sitter parse` CLI so this script does not
// depend on the compiled native node binding being loadable in CI. All covered
// files are parsed in a single `--quiet` invocation: in quiet mode the CLI
// prints exactly one line per file whose tree has an error (ERROR or MISSING)
// and stays silent for clean files, so any output line is a conformance
// failure.

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);

const covered = new Set(coverage.covered);
const skip = new Set(Object.keys(coverage.skip));

function baseCategory(file) {
  return path.basename(file, '.crv').replace(/-[0-9]+$/, '');
}

const allFiles = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.crv'))
  .sort();

const coveredFiles = [];
let skippedCount = 0;
for (const file of allFiles) {
  const category = baseCategory(file);
  const stem = path.basename(file, '.crv');
  if (skip.has(category) || skip.has(stem)) {
    skippedCount += 1;
    continue;
  }
  // Unknown categories are reported by the coverage-matrix check; conformance
  // only asserts on categories explicitly marked covered.
  if (covered.has(category)) {
    coveredFiles.push(path.join(corpusDir, file));
  }
}

// `tree-sitter parse --quiet FILES...` prints one line per file whose parse
// tree contains an error and is silent otherwise; exit status is non-zero when
// any tree had an error. We rely on stdout: each printed line names a failing
// covered file.
const result = spawnSync(
  'npx',
  ['tree-sitter', 'parse', '--quiet', ...coveredFiles],
  { cwd: repoRoot, encoding: 'utf8' },
);

if (result.error) {
  console.error(`Failed to run tree-sitter parse: ${result.error.message}`);
  process.exit(2);
}

const failures = (result.stdout || '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

// In `--quiet` mode the CLI is silent for clean files and prints one line per
// file with an error, so a clean run is empty stdout with exit 0 and a run with
// conformance failures is non-empty stdout with exit non-zero. A non-zero exit
// with no per-file output means the invocation itself failed (parser failed to
// load, bad path, etc.) - that must be a hard error, never a silent pass.
if (failures.length === 0 && result.status !== 0) {
  console.error(
    `tree-sitter parse exited with status ${result.status} but produced no ` +
      'per-file output; the parse invocation failed.',
  );
  if (result.stderr) console.error(result.stderr.toString().trim());
  process.exit(2);
}

console.log(
  `corpus-conformance: parsed ${coveredFiles.length} file(s) across ${covered.size} ` +
    `covered categories; ${skippedCount} file(s) skipped via ${skip.size} skip entr` +
    `${skip.size === 1 ? 'y' : 'ies'}.`,
);

if (failures.length) {
  console.error('\nConformance failures (covered category produced ERROR/MISSING):');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nA covered category must parse cleanly. Either fix the grammar or move the ' +
      'category to the skip list in test/coverage.json with a reason.',
  );
  process.exit(1);
}

console.log('corpus-conformance: OK (no ERROR/MISSING in any covered category).');
