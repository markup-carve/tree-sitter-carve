#!/usr/bin/env node
// Coverage-matrix guard for the shared Carve spec corpus.
//
// Reads every `NN-slug` base category present in spec/tests/corpus and fails if
// any category is neither in `covered` nor in `skip` of test/coverage.json. A
// new spec category therefore forces an explicit classify decision, mirroring
// the IMPLEMENTED guard in the core Carve implementations.
//
// A skip key is a CATEGORY (`NN-slug`) or a single EXAMPLE (`NN-slug-2`), so one
// unparsable example does not drop assertion for the whole category it lives in.
//
// It also fails on stale matrix entries (a covered/skip key that no longer
// exists in the corpus) and on a category listed in both lists.

import { readFileSync, readdirSync } from 'node:fs';
import { refuseShortRun } from './participants.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);

// A category's identity is its SLUG, not its numbered filename.
//
// The corpus is generated from docs/examples in document order, so the numeric
// prefix is a POSITION: inserting one example anywhere renumbers every category
// after it. Keyed by the full name, this matrix reports the whole tail as
// stale - bumping the submodule 49 commits produced 103 stale covered entries,
// of which none was a real change and exactly THREE categories were new. That
// is why the submodule sat behind: refreshing it meant re-keying a hundred
// entries by hand for no information, so nobody did.
const slugOf = (name) => name.replace(/^\d+-/, '');

const covered = new Set(coverage.covered.map(slugOf));
const skip = new Set(Object.keys(coverage.skip).map(slugOf));

function baseCategory(file) {
  return path.basename(file, '.crv').replace(/-[0-9]+$/, '');
}

// Every finding below is a reconciliation between the corpus and the matrix, so
// an empty corpus produces findings only while the matrix is non-empty. Both
// emptied, this printed "0 corpus categories; 0 covered, 0 skipped. OK" and
// exited 0 (markup-carve/carve#755).
refuseShortRun({
  label: 'CORPUS',
  actual: readdirSync(corpusDir).filter((f) => f.endsWith('.crv')).length,
  atLeast: 1000,
  of: `document(s) under ${corpusDir}`,
  hint: 'the spec corpus has ~1260; run `git submodule update --init`.',
});

const corpusStems = new Set(
  readdirSync(corpusDir)
    .filter((f) => f.endsWith('.crv'))
    .map((f) => slugOf(path.basename(f, '.crv'))),
);
const corpusCategories = new Set([...corpusStems].map((stem) => slugOf(baseCategory(stem))));

const errors = [];

// 1. Every corpus category must be classified.
for (const category of [...corpusCategories].sort()) {
  const inCovered = covered.has(category);
  const inSkip = skip.has(category);
  // An example-level skip does not classify its category: the rest of the
  // category still has to be covered (or skipped) explicitly.
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
for (const key of [...skip].sort()) {
  if (!corpusCategories.has(key) && !corpusStems.has(key)) {
    errors.push(
      `stale skip entry: "${key}" is neither a corpus category nor a corpus example.`,
    );
  }
}

// 3. Every skip entry must carry a non-empty reason.
for (const [key, reason] of Object.entries(coverage.skip)) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    errors.push(`skip entry "${key}" has no reason.`);
  }
}

console.log(
  `coverage-matrix: ${corpusCategories.size} corpus categories; ` +
    `${covered.size} covered, ${skip.size} skipped.`,
);

// 4. The matrix keys must BE slugs. Slug-keyed lookups against numbered keys
// silently match nothing, and "matches nothing" reads as "no findings" in every
// consumer here - the conformance script's covered set would simply go empty
// and it would report success over zero files.
for (const key of [
  ...coverage.covered,
  ...Object.keys(coverage.skip),
  ...Object.keys(coverage.overAcceptance ?? {}),
  ...Object.keys(coverage.invisibleOverAcceptance ?? {}),
]) {
  if (/^\d+-/.test(key)) {
    errors.push(
      `matrix key "${key}" carries a corpus number. Keys are slugs: the number ` +
        `is a position in the spec's document order and moves on every insert.`,
    );
  }
}

// 5. SHARED REASONS. One grammar gap usually spans a whole category, and the
// reason was copied per document: 52 entries carried 12 distinct texts, 27 kB
// of it duplicated. That is not just bulk. Editing one copy and not the other
// fifteen is silent, and the copies are the only record of WHY a gap is
// tolerated - so they drift into disagreeing with each other about the same
// defect.
//
// An entry may therefore write `"reason": "ref:<key>"` and put the text once in
// the top-level `reasons` map. Gated in both directions, like every other
// ledger here: a ref with no entry fails, and an entry nothing references fails
// (a reason nobody points at is a gap that was closed without anyone deleting
// its excuse - carve#755's class).
const reasons = coverage.reasons ?? {};
const referenced = new Set();
for (const [ledgerName, ledger] of Object.entries({
  skip: coverage.skip ?? {},
  overAcceptance: coverage.overAcceptance ?? {},
  invisibleOverAcceptance: coverage.invisibleOverAcceptance ?? {},
  underAcceptance: coverage.underAcceptance ?? {},
  lineTerminatorGaps: coverage.lineTerminatorGaps ?? {},
})) {
  for (const [key, entry] of Object.entries(ledger)) {
    const text = typeof entry === 'string' ? entry : (entry.reason ?? '');
    if (!text.startsWith('ref:')) continue;
    const refKey = text.slice(4);
    referenced.add(refKey);
    if (!(refKey in reasons)) {
      errors.push(
        `${ledgerName}["${key}"] cites reason "${refKey}", which is not in ` +
          `\`reasons\`. Add the text there, or write the reason inline.`,
      );
    }
  }
}
for (const key of Object.keys(reasons)) {
  if (!referenced.has(key)) {
    errors.push(
      `reasons["${key}"] is referenced by no entry. The gap it explains was ` +
        `closed without its explanation being removed - delete it.`,
    );
  }
}

if (errors.length) {
  console.error('\nCoverage-matrix failures:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `coverage-matrix: OK (every corpus category is classified; ` +
    `${Object.keys(reasons).length} shared reason(s), all referenced).`,
);
