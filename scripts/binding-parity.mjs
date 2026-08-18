#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrees } from './parse-batched.mjs';
import { refuseShortRun } from './participants.mjs';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const carve = require('../bindings/node');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
// One base document per original corpus category, matching the 178-document
// differential sample that exposed the runtime skew. Variants multiply the
// same question and later stress categories currently crash the old runtime
// before a tree can be compared; this population is stable and reviewable.
const files = readdirSync(corpusDir).filter((file) => {
  const match = /^(\d+)-.+\.crv$/.exec(file);
  return match && Number(match[1]) <= 178 && !/-\d+\.crv$/.test(file);
}).sort((a, b) => Number(a.split('-', 1)[0]) - Number(b.split('-', 1)[0]))
  .map((file) => path.join(corpusDir, file));

refuseShortRun({
  label: 'BINDING PARITY CORPUS',
  actual: files.length,
  atLeast: 170,
  of: `document(s) under ${corpusDir}`,
  hint: 'the pinned differential sample has 178; run `git submodule update --init`.',
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
console.log(`binding parity: ${files.length} document(s) agree.`);
