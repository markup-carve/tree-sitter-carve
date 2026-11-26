#!/usr/bin/env node
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCorpusCases } from './corpus-cases.mjs';
import { parseTrees } from './parse-batched.mjs';
import { refuseShortRun } from './participants.mjs';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
// CARVE_TS_BINDING lets the release gate point this at the PACKED tarball
// installed into a clean directory, rather than at the source tree. The whole
// value of this check at release time is that it measures the artifact a
// consumer receives - a source tree that agrees with the CLI says nothing about
// what npm actually shipped. Unset, it resolves the source tree as before.
const carve = require(process.env.CARVE_TS_BINDING || '../bindings/node');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = writeCorpusCases(mkdtempSync(path.join(tmpdir(), 'carve-binding-parity-')));

refuseShortRun({
  label: 'BINDING PARITY CORPUS',
  actual: files.length,
  atLeast: 150,
  of: 'case(s) in test/corpus',
});

const cliTrees = parseTrees(files, repoRoot).map((tree) =>
  tree.replace(/ \[\d+, \d+\] - \[\d+, \d+\]/g, '').replace(/\s+/g, ' ').trim(),
);
const parser = new Parser();
parser.setLanguage(carve);
const disagreements = [];

files.forEach((file, index) => {
  const addonTree = parser.parse(readFileSync(file, 'utf8')).rootNode.toString().replace(/\s+/g, ' ').trim();
  if (addonTree !== cliTrees[index]) disagreements.push(path.basename(file));
});

if (disagreements.length) {
  console.error(`Node binding and CLI disagree on ${disagreements.length} document(s):`);
  disagreements.slice(0, 30).forEach((file) => console.error(`  - ${file}`));
  process.exit(1);
}
console.log(`binding parity: ${files.length} corpus case(s) agree.`);
