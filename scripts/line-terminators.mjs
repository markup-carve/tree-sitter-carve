#!/usr/bin/env node
// EVERY LINE TERMINATOR THE LANGUAGE DEFINES PRODUCES THE SAME DOCUMENT.
//
// `newline = '\n' | '\r\n' | '\r'` (spec `resources/grammar.ebnf`), and PART 0's
// INPUT paragraph names that production rather than restating it. Three
// spellings, one language: rewriting a document's terminators from one spelling
// to another must not change what it parses to. That is the whole statement, and
// it is what this check measures - each corpus document is written out in all
// three spellings and the three trees must agree, node type for node type.
//
// NOTHING ELSE HERE COULD SEE THAT. The tree carries no ERROR when lines fold
// together, so corpus-conformance passes it. The heading count is right - there
// is one heading, it is simply the whole document - so the coverage matrix
// passes it. under-acceptance.mjs cannot see it either, and for a reason it
// states in its own header: `paragraph` is deliberately unmapped there, because
// a paragraph is the fallback every gap falls into and comparing it would report
// every gap twice. A construct that swallows the following lines INTO a block
// therefore shows up nowhere, which is how a whole line-ending spelling stayed
// unmodeled while three checks reported the category clean (#143).
//
// WHY NOT ROW NUMBERS. This check used to ask where the tree ENDS - `endRow <
// lines - 2` - which read well and cannot work. tree-sitter's own lexer advances
// the row and resets the column on '\n' and on nothing else
// (`lib/src/lexer.c`, `ts_lexer__do_advance`), so in a document written with
// lone carriage returns every node stays on row 0 however correct this grammar
// is. The old measurement was of tree-sitter core, not of this grammar, and it
// could report neither a fix nor a regression. Comparing SHAPES asks the
// grammar's own question and leaves positions - which this repository does not
// control for that spelling - out of it.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);
const recorded = coverage.lineTerminatorGaps ?? {};

const files = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.crv'))
  .sort();

// The wiring guard: an empty or moved corpus would find no gaps and report a
// clean run having measured nothing. This was the FIRST copy of it, and its
// comment used to say "the same guard the other sweeps carry" - they did not,
// and three of them exited 0 over an empty corpus until markup-carve/carve#755
// measured it. One spelling now, in scripts/participants.mjs.
refuseShortRun({
  label: 'CORPUS',
  actual: files.length,
  atLeast: 400,
  of: `document(s) under ${corpusDir}`,
  hint: 'the spec corpus has ~650; run `git submodule update --init`.',
});

const SPELLINGS = { lf: '\n', crlf: '\r\n', cr: '\r' };
const work = mkdtempSync(path.join(tmpdir(), 'line-terminators-'));
const written = { lf: [], crlf: [], cr: [] };
for (const f of files) {
  const lines = readFileSync(path.join(corpusDir, f), 'utf8').split(/\r\n|\r|\n/);
  for (const [name, sep] of Object.entries(SPELLINGS)) {
    const p = path.join(work, `${name}-${f}`);
    writeFileSync(p, lines.join(sep));
    written[name].push(p);
  }
}

// ONE FILE PER PROCESS, deliberately. `tree-sitter parse` given many paths
// stops printing part way through a long run - a batch of 200 corpus documents
// came back with 135 trees - and a check that cannot tell a short answer from a
// clean one is worse than no check. The cost is bounded by resolving the CLI
// once instead of paying `npx`'s own startup 2000 times.
const localCli = path.join(repoRoot, 'node_modules', '.bin', 'tree-sitter');
const [cli, cliArgs] = existsSync(localCli)
  ? [localCli, []]
  : ['npx', ['tree-sitter']];
function parseOne(file) {
  const run = spawnSync(cli, [...cliArgs, 'parse', file], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) {
    console.error(`Failed to run tree-sitter parse: ${run.error.message}`);
    rmSync(work, { recursive: true, force: true });
    process.exit(2);
  }
  return run.stdout || '';
}
function parseAll(paths) {
  return paths.map(parseOne);
}

// Node types only. Positions cannot be compared across spellings (see the
// header), and neither can the per-file summary tree-sitter appends to a tree it
// found an ERROR in - but WHETHER there was an ERROR is part of the shape.
const shape = (t) =>
  t
    .replace(/\s*\[\d+, \d+\] - \[\d+, \d+\]/g, '')
    .replace(/\S*\.crv\s+[\d.]+ ms\s+[\d.]+ bytes\/ms/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const parsed = {};
for (const name of Object.keys(SPELLINGS)) {
  const trees = parseAll(written[name]);
  const empty = trees.filter((t) => !t.trim()).length;
  if (empty) {
    console.error(
      `${empty} document(s) in the ${name} spelling produced no parse tree at ` +
        'all; the tree-sitter output format changed and this check cannot be ' +
        'trusted.',
    );
    rmSync(work, { recursive: true, force: true });
    process.exit(2);
  }
  parsed[name] = trees.map(shape);
}
rmSync(work, { recursive: true, force: true });

const found = {};
files.forEach((file, i) => {
  const differs = ['crlf', 'cr'].filter((n) => parsed[n][i] !== parsed.lf[i]);
  if (differs.length) {
    found[path.basename(file, '.crv').replace(/^[0-9]+-/, '')] =
      `the ${differs.join(' and ')} spelling(s) parse to a different tree than lf`;
  }
});

const isNew = Object.keys(found).filter((k) => !(k in recorded));
const fixed = Object.keys(recorded).filter((k) => !(k in found));

console.log(
  `line-terminators: checked ${files.length} document(s) in ` +
    `${Object.keys(SPELLINGS).length} spellings; ` +
    `${Object.keys(found).length} divergent, ${Object.keys(recorded).length} recorded.`,
);

if (isNew.length) {
  console.error(
    '\nDocuments a line terminator the language defines does not carry through:',
  );
  for (const k of isNew) console.error(`  - ${k}: ${found[k]}`);
}
if (fixed.length) {
  console.error(
    '\nRecorded divergences that no longer happen - delete these from ' +
      '`lineTerminatorGaps` in test/coverage.json:',
  );
  for (const k of fixed) console.error(`  - ${k}`);
}
if (isNew.length || fixed.length) process.exit(1);

console.log('line-terminators: OK (every recorded divergence is exactly the set found).');
