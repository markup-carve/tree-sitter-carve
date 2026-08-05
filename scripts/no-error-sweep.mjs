#!/usr/bin/env node
// EVERY INPUT IS A VALID CARVE DOCUMENT, so none of them may parse to ERROR.
//
// There is no such thing as invalid Carve: a construct that does not form
// degrades to text, which is why the language has no parse-error state. A grammar
// that produces an ERROR node is therefore always wrong, whatever the shape - no
// engine comparison needed, no fixture, no expected output.
//
// That makes this the one check that can look OUTSIDE the corpus. The other five
// cannot: corpus-conformance only sees documents the spec ships, the battery asks
// about the FIRST node of a one-shape document, under-acceptance compares node
// counts for corpus documents, and the coverage matrix is about categories. Three
// defects fixed this week - a content-less marker line (#75), a marker attribute
// on a bullet (#89), an over-indented block attribute (#84) - were invisible to
// all of them, and the first of those was an ERROR tree for a document as
// ordinary as
//
//     - a
//     -
//     x
//
// The generator is DETERMINISTIC - a fixed line vocabulary in a fixed order - so
// the recorded families below are stable and a diff to them is reviewable. It is
// not a fuzzer: randomness would make the record churn and the failures
// irreproducible.
//
// Families are recorded, not individual documents: 127 failing documents reduce
// to a handful of causes, and a per-document list would hide that.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);
const recorded = coverage.errorFamilies ?? {};

// One line per construct that opens or continues a block, plus the shapes that
// sit on a rule's boundary. Deliberately short: every entry multiplies the run.
const LINES = [
  '- a', '- ', '-', '- [x] t', '-{.x} a',
  '1. a', '1. ', '1.', 'a) x',
  ':: t', ':  d', ': d',
  '> q', '>',
  '  - n', '   x', 'x', '',
  '{.c}', '  {.c}',
  '```', '``` js', ':::', '::: note',
  '%%', '%%%', '| a |', '^ cap', '---', '***',
];
const TAILS = ['x', '', '- b'];
// A LITERAL, not `LINES.length * LINES.length * TAILS.length`. Derived from the
// arrays it is meant to guard, this expectation can never fail: shrinking the
// vocabulary shrinks the expectation with it, and the sweep reports a smaller
// question answered as a pass. Measured while writing this - dropping one tail
// took the run from 2700 documents to 1800 and the population check stayed
// silent. Update the number deliberately when the vocabulary grows.
const EXPECTED_DOCUMENTS = 2700;

/** The family a failing document belongs to: the two lines that shaped it. */
const familyOf = (first, second) => `${JSON.stringify(first)} + ${JSON.stringify(second)}`;

const work = mkdtempSync(path.join(tmpdir(), 'carve-no-error-'));
const byFile = new Map();
for (const first of LINES) {
  for (const second of LINES) {
    for (const tail of TAILS) {
      const file = path.join(work, `s${byFile.size}.crv`);
      writeFileSync(file, `${first}\n${second}\n${tail}\n`);
      byFile.set(file, familyOf(first, second));
    }
  }
}

if (byFile.size !== EXPECTED_DOCUMENTS) {
  console.error(
    `no-error sweep: generated ${byFile.size} documents, expected ${EXPECTED_DOCUMENTS}. ` +
      'A run over fewer than it should have is not a pass.',
  );
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// In batches: one `tree-sitter parse` per document costs a process each, and the
// CLI prints one line per file in --quiet mode only when the tree has an error.
const files = [...byFile.keys()];
const found = new Map();
const BATCH = 400;
for (let i = 0; i < files.length; i += BATCH) {
  const batch = files.slice(i, i + BATCH);
  const run = spawnSync('npx', ['tree-sitter', 'parse', '--quiet', ...batch], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) {
    console.error(`Failed to run tree-sitter parse: ${run.error.message}`);
    rmSync(work, { recursive: true, force: true });
    process.exit(2);
  }
  for (const line of (run.stdout || '').split('\n')) {
    if (!line.includes('ERROR')) continue;
    const file = line.split(/\s/)[0];
    const family = byFile.get(file);
    if (family) found.set(family, (found.get(family) ?? 0) + 1);
  }
}
rmSync(work, { recursive: true, force: true });

const familiesFound = [...found.keys()].sort();
const isNew = familiesFound.filter((f) => !(f in recorded));
const nowFixed = Object.keys(recorded).filter((f) => !found.has(f));
const changed = familiesFound
  .filter((f) => f in recorded && recorded[f].documents !== found.get(f))
  .map((f) => `${f}: recorded ${recorded[f].documents} document(s), now ${found.get(f)}`);

const total = [...found.values()].reduce((n, x) => n + x, 0);
console.log(
  `no-error sweep: parsed ${byFile.size} generated document(s); ` +
    `${total} produced an ERROR across ${familiesFound.length} family(ies), ` +
    `${Object.keys(recorded).length} recorded.`,
);

if (isNew.length || nowFixed.length || changed.length) {
  if (isNew.length) {
    console.error('\nERROR on a valid document, and no record says why:');
    for (const f of isNew) console.error(`  - ${f} (${found.get(f)} document(s))`);
  }
  if (nowFixed.length) {
    console.error(
      '\nRecorded ERROR families that no longer happen - remove these from ' +
        '`errorFamilies` in test/coverage.json:',
    );
    for (const f of nowFixed) console.error(`  - ${f}`);
  }
  if (changed.length) {
    console.error('\nRecorded ERROR families whose document count changed:');
    for (const c of changed) console.error(`  - ${c}`);
  }
  process.exit(1);
}
console.log('no-error sweep: OK (every ERROR family is recorded exactly).');
