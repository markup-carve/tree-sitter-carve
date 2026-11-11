#!/usr/bin/env node
// An unclosed code run in a table cell ends where the cell content ends: the
// spaces before the closing pipe are padding (`data_cell` ends in `{space}`),
// a tab there is content (CARVE-P7-001). Compares each run's extent with
// carve-js (#647).

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@markup-carve/carve';
import { parseTrees } from './parse-batched.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pads = ['', ' ', '  ', '   ', '\t', ' \t', '\t '];
const leads = ['z ', '', 'z  ', 'a b ', '*x* '];
const bodies = ['a z', 'a', 'a  z', 'a | b', 'a `` b', 'a\tz', 'x*y'];
const ticks = ['`', '``'];
const shapes = [
  (c) => `| ${c}|`,
  (c) => `| ${c}| q |`,
  (c) => `| q | ${c}|`,
  (c) => `|= ${c}|`,
  (c) => `| ${c}|\n| r |`,
];
const inputs = [];
for (const shape of shapes) for (const lead of leads) for (const tick of ticks) for (const body of bodies) for (const pad of pads) {
  inputs.push(`${shape(`${lead}${tick}${body}${pad}`)}\n`);
}
for (const pad of pads) for (const body of bodies) inputs.push(`| z \`${body}\`${pad}|\n`);

const dir = mkdtempSync(path.join(tmpdir(), 'cell-code-padding-'));
const files = inputs.map((source, i) => {
  const file = path.join(dir, `${i}.crv`);
  writeFileSync(file, source);
  return file;
});

const expected = (source) => {
  const extents = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'code' && node.pos) extents.push(`${node.pos.startOffset}-${node.pos.endOffset}`);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object' && value.type) walk(value);
    }
  };
  walk(parse(source, { positions: true }));
  return extents;
};

const actual = (source, tree) => {
  const lines = source.split('\n');
  const offset = (row, column) => {
    let at = column;
    for (let i = 0; i < row; i++) at += lines[i].length + 1;
    return at;
  };
  return [...tree.matchAll(/\(verbatim \[(\d+), (\d+)\] - \[(\d+), (\d+)\]/g)]
    .map((m) => `${offset(+m[1], +m[2])}-${offset(+m[3], +m[4])}`);
};

const trees = parseTrees(files, repoRoot);
const differing = [];
inputs.forEach((source, i) => {
  const tree = trees[i];
  const got = /ERROR|MISSING/.test(tree) ? ['ERROR'] : actual(source, tree);
  const want = expected(source);
  if (JSON.stringify(got) !== JSON.stringify(want)) differing.push({ source, got, want });
});

// The reproduction from the ticket, pinned without carve-js in the loop.
assert.deepEqual(actual('| z `a z |\n', trees[inputs.indexOf('| z `a z |\n')]), ['4-8']);
assert.deepEqual(differing, []);
console.log(`table cell code padding: ${inputs.length} inputs agree with carve-js`);
