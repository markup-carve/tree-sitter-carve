#!/usr/bin/env node
// The shared block battery, run against this grammar.
//
// Every other Carve grammar runs this table - carve-grammars' three, and the
// VS Code, IntelliJ, Sublime, Vim and Emacs ports, which each vendor it. This
// one did not, and that is how `^<TAB>cap` parsed as a caption here while
// every engine renders it as a paragraph: the corpus has no caption-with-tab
// document, so corpus conformance could not see it, and nothing else looked.
//
// The battery is the shape-level counterpart to corpus conformance. The corpus
// checks whole documents the spec ships; this checks the one-line forms that
// sit exactly on a rule's boundary, which is where a grammar drifts first.
//
// tests/lib/block-battery.json is a COPY. tools/check-battery-drift.sh proves
// it is still the same copy.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const battery = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests', 'lib', 'block-battery.json'), 'utf8'),
).shapes;

// An empty table checks nothing and says "0 shapes checked, 0 recorded
// disagreement(s)" on the way out, which is the same sentence a clean run ends
// with. Measured, not reasoned: `shapes: []` exits 0 here
// (markup-carve/carve#755).
//
// Nothing else covers it. The reconciliation below is the usual three-direction
// one, but its record - `batteryDisagreements` - is at ZERO today, so an empty
// battery produces no NEW disagreement and no recorded one to go stale. That is
// the ticket's fourth variant in its realized form: a gate that stopped working
// the moment its subject became healthy. tools/check-battery-drift.sh does not
// close it either, because a table emptied UPSTREAM matches an emptied copy.
refuseShortRun({
  label: 'BATTERY',
  actual: battery.length,
  atLeast: 30,
  of: 'shape(s) in tests/lib/block-battery.json',
  hint: 'the vendored copy is the population; re-copy it from carve-grammars.',
});

// The battery's vocabulary is the RENDERED shape, not this grammar's node
// names, so the map is here rather than in the shared table: every consumer
// spells its own nodes differently and the table has to stay engine-neutral.
const NODE_CLASS = [
  [/^section$|^heading$/, 'heading'],
  [/^caption$/, 'caption'],
  [/^block_quote$/, 'quote'],
  [/^definition_list$/, 'deflist'],
  [/^list$/, 'list'],
];

const cli = path.join(repoRoot, 'node_modules', '.bin', 'tree-sitter');
const work = mkdtempSync(path.join(tmpdir(), 'carve-battery-'));

function classify(src) {
  const file = path.join(work, 'shape.crv');
  // A trailing line keeps the shape off the last line of the document, where
  // an end-anchored rule can behave differently.
  writeFileSync(file, `${src}\nafter\n`);
  let out;
  try {
    out = execFileSync(cli, ['parse', file], { encoding: 'utf8' });
  } catch (error) {
    // A parse ERROR is its own answer: not one of the battery's classes.
    out = error.stdout ?? '';
  }
  const first = out.split('\n')[1] ?? '';
  const node = first.trim().replace(/^\(/, '').split(/[\s[]/)[0] ?? '';
  for (const [pattern, name] of NODE_CLASS) if (pattern.test(node)) return name;
  return 'none';
}

// Shapes this grammar is knowingly wrong about, checked in the THREE
// directions corpus-conformance already uses for over-acceptance: a NEW
// disagreement fails, a recorded one that has been FIXED fails so the record
// cannot rot, and a recorded one that now produces a DIFFERENT class fails
// because the record no longer describes it.
const known = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
).batteryDisagreements ?? {};

const failures = [];
const seen = new Set();
for (const { src, want, why } of battery) {
  const got = classify(src);
  if (got === want) continue;
  const record = known[src];
  if (record) {
    seen.add(src);
    if (record.got !== got) {
      failures.push(
        `  ${JSON.stringify(src).padEnd(14)} recorded got=${record.got}, now got=${got}` +
          ' - update test/coverage.json batteryDisagreements',
      );
    }
    continue;
  }
  failures.push(
    `  ${JSON.stringify(src).padEnd(14)} want=${want.padEnd(8)} got=${got}` +
      (why ? `   (${why})` : ''),
  );
}
for (const src of Object.keys(known)) {
  if (!seen.has(src)) {
    failures.push(
      `  ${JSON.stringify(src).padEnd(14)} is recorded as disagreeing and now AGREES` +
        ' - delete it from test/coverage.json batteryDisagreements',
    );
  }
}
rmSync(work, { recursive: true, force: true });

if (failures.length) {
  console.log('The shared block battery disagrees with this grammar:');
  console.log(failures.join('\n'));
  console.log(
    `\n${failures.length} of ${battery.length} shapes wrong. ` +
      'The battery records what the engines render; change the grammar, not the battery.',
  );
  process.exit(1);
}
console.log(
  `block battery: ${battery.length} shapes checked, ` +
    `${Object.keys(known).length} recorded disagreement(s).`,
);
