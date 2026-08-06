#!/usr/bin/env node
// Every line terminator the language defines actually ends a line here.
//
// `newline = '\n' | '\r\n' | '\r'` (spec grammar.ebnf). This scanner's model is
// different: `advance` skips a `\r` wherever it meets one. That makes the CRLF
// spelling work, because the `\n` behind it still terminates the line - and it
// makes a LONE `\r` disappear, so a file written with old-Mac line endings has
// no terminators at all and folds into a single line.
//
// NOTHING ELSE HERE COULD SEE THAT. The tree carries no ERROR, so
// corpus-conformance passes it. The heading count is right - there is one
// heading, it is simply the whole document - so the coverage matrix passes it.
// under-acceptance.mjs cannot see it either, and for a reason it states in its
// own header: `paragraph` is deliberately unmapped there, because a paragraph is
// the fallback every gap falls into and comparing it would report every gap
// twice. A construct that swallows the following lines INTO a block therefore
// shows up nowhere, which is how a whole line-ending spelling stayed unmodeled
// while three checks reported the category clean (tree-sitter-carve#143).
//
// THE MEASUREMENT. Count the source's lines by the language's own definition,
// then ask where the tree ends. A grammar that honors the terminator ends on or
// near the last line; one that does not ends on row 0 with four lines above it.
// The comparison is deliberately loose - `endRow < lines - 1` - because a
// trailing newline, a final blank line and a document that ends mid-line all
// move the last row by one without meaning anything. Only a real fold clears it,
// and over the whole corpus exactly one document does.
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);
const recorded = coverage.lineTerminatorGaps ?? {};

const files = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.crv'))
  .sort()
  .map((f) => path.join(corpusDir, f));

// The same wiring guard the other sweeps carry: an empty or moved corpus would
// find no gaps and report a clean run having measured nothing.
if (files.length < 400) {
  console.error(
    `Only ${files.length} corpus document(s) under ${corpusDir}; the corpus has ~650, ` +
      'so this is a wiring problem, not a clean run.',
  );
  process.exit(2);
}

const parsed = spawnSync('npx', ['tree-sitter', 'parse', ...files], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
});
if (parsed.error) {
  console.error(`Failed to run tree-sitter parse: ${parsed.error.message}`);
  process.exit(2);
}
const trees = (parsed.stdout || '').split(/^(?=\(document )/m).filter((t) => t.trim());
if (trees.length !== files.length) {
  console.error(
    `Expected ${files.length} parse trees, got ${trees.length}; the tree-sitter ` +
      'output format changed and this check cannot be trusted.',
  );
  process.exit(2);
}

const found = {};
files.forEach((file, i) => {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r\n|\r|\n/).length;
  const span = trees[i].match(/^\(document \[\d+, \d+\] - \[(\d+), \d+\]/);
  if (!span) return;
  const endRow = Number(span[1]);
  if (endRow < lines - 2) {
    found[path.basename(file, '.crv').replace(/^[0-9]+-/, '')] =
      `source has ${lines} line(s), tree ends on row ${endRow}`;
  }
});

const isNew = Object.keys(found).filter((k) => !(k in recorded));
const fixed = Object.keys(recorded).filter((k) => !(k in found));

console.log(
  `line-terminators: checked ${files.length} document(s); ` +
    `${Object.keys(found).length} folded, ${Object.keys(recorded).length} recorded.`,
);

if (isNew.length) {
  console.error(
    '\nDocuments whose lines the grammar folded together (a line terminator the ' +
      'language defines is not one here):',
  );
  for (const k of isNew) console.error(`  - ${k}: ${found[k]}`);
}
if (fixed.length) {
  console.error(
    '\nRecorded folds that no longer happen - delete these from ' +
      '`lineTerminatorGaps` in test/coverage.json:',
  );
  for (const k of fixed) console.error(`  - ${k}`);
}
if (isNew.length || fixed.length) process.exit(1);

console.log('line-terminators: OK (every recorded fold is exactly the set found).');
