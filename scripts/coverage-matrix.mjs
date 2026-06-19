#!/usr/bin/env node
// Coverage-matrix guard for the shared Carve spec corpus.
//
// Reads every `NN-slug` base category present in spec/tests/corpus and fails if
// any category is neither in `covered` nor in `skip` of test/coverage.json. A
// new spec category therefore forces an explicit classify decision, mirroring
// the IMPLEMENTED guard in the core Carve implementations.
//
// It also fails on stale matrix entries (a covered/skip category that no longer
// exists in the corpus) and on a category listed in both lists.

import { readFileSync, readdirSync } from 'node:fs';
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

const corpusCategories = new Set(
  readdirSync(corpusDir)
    .filter((f) => f.endsWith('.crv'))
    .map(baseCategory),
);

const errors = [];

// 1. Every corpus category must be classified.
for (const category of [...corpusCategories].sort()) {
  const inCovered = covered.has(category);
  const inSkip = skip.has(category);
  if (!inCovered && !inSkip) {
    errors.push(
      `unclassified category: "${category}" exists in the corpus but is in neither ` +
        `covered nor skip. Add it to test/coverage.json (covered if the grammar ` +
        `parses it cleanly, otherwise skip with a reason).`,
    );
  }
  if (inCovered && inSkip) {
    errors.push(`category "${category}" appears in both covered and skip.`);
  }
}

// 2. No stale matrix entries.
for (const category of [...covered].sort()) {
  if (!corpusCategories.has(category)) {
    errors.push(`stale covered entry: "${category}" is not present in the corpus.`);
  }
}
for (const category of [...skip].sort()) {
  if (!corpusCategories.has(category)) {
    errors.push(`stale skip entry: "${category}" is not present in the corpus.`);
  }
}

// 3. Every skip entry must carry a non-empty reason.
for (const [category, reason] of Object.entries(coverage.skip)) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    errors.push(`skip entry "${category}" has no reason.`);
  }
}

console.log(
  `coverage-matrix: ${corpusCategories.size} corpus categories; ` +
    `${covered.size} covered, ${skip.size} skipped.`,
);

if (errors.length) {
  console.error('\nCoverage-matrix failures:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('coverage-matrix: OK (every corpus category is classified).');
