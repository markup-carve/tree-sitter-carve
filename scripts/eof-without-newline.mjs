#!/usr/bin/env node
// A DOCUMENT MAY END WITHOUT A TERMINATOR, and `scripts/no-error-sweep.mjs`
// cannot see whether it parses: it writes every generated document as
// `lines.join('\n') + '\n'`, and every corpus file already ends with a newline.
// So the one input class an editor produces constantly - a buffer whose last
// line the author is still typing - was unmeasured, and 457 of the 1870 pinned
// corpus documents parsed to ERROR in it (#458).
//
// This measures that class directly: parse each corpus document with its final
// newline stripped, and record the set that still fails. The population is a
// LEDGER rather than a count, so swapping one document for another cannot hide
// behind a stable number - the same reason carve-grammars keeps its populations
// as sets.
//
// Refresh with UPDATE_LEDGER=1 and read the diff. An ADDED entry is a
// regression: a shape that used to survive its missing terminator. A REMOVED
// entry is progress and the ledger shrinks with it.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import Parser from 'tree-sitter';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Carve = (await import(path.join(repoRoot, 'bindings/node/index.js'))).default;
const LEDGER = path.join(repoRoot, 'test/eof-without-newline-ledger.json');
const corpusDir = path.join(repoRoot, 'spec/tests/corpus');

const parser = new Parser();
parser.setLanguage(Carve);

const measured = [];
let terminated = 0;
let withTerminator = [];
for (const file of readdirSync(corpusDir).filter((f) => f.endsWith('.crv')).sort()) {
  const raw = readFileSync(path.join(corpusDir, file), 'utf8');
  const withNewline = raw.endsWith('\n') ? raw : `${raw}\n`;
  const stripped = withNewline.replace(/\n$/, '');
  // A document that already fails WITH its terminator is a different defect and
  // belongs to the no-error sweep, not here.
  if (parser.parse(withNewline).rootNode.hasError) {
    withTerminator.push(file);
    continue;
  }
  terminated++;
  if (parser.parse(stripped).rootNode.hasError) measured.push(file);
}

const now = measured.sort();
console.log(
  `eof-without-newline: ${terminated} document(s) parse cleanly with a final newline; `
  + `${now.length} still ERROR without one.`,
);
if (withTerminator.length) {
  console.log(`  (${withTerminator.length} already ERROR with the newline, owned by the no-error sweep: ${withTerminator.join(', ')})`);
}

if (process.env.UPDATE_LEDGER === '1') {
  writeFileSync(LEDGER, `${JSON.stringify(now, null, 2)}\n`);
  console.log(`  (wrote ${now.length} entries to test/eof-without-newline-ledger.json)`);
} else {
  const recorded = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const recordedSet = new Set(recorded);
  const nowSet = new Set(now);
  const added = now.filter((f) => !recordedSet.has(f));
  const gone = recorded.filter((f) => !nowSet.has(f));
  assert.deepStrictEqual(
    { added }, { added: [] },
    'documents started failing without their final newline:\n  '
    + `${added.join('\n  ')}\n`
    + 'Each one is a terminator a block stopped tolerating at EOF.',
  );
  if (gone.length) {
    console.log(`  ${gone.length} fewer than recorded; refresh with UPDATE_LEDGER=1:\n    ${gone.join('\n    ')}`);
  }
  console.log('eof-without-newline: OK (no document regressed).');
}
