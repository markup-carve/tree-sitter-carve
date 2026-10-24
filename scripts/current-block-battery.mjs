#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARSE_TIMEOUT_US, TIMEOUT_ARGS, spawnBudgetMs } from './parse-limits.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shapes = JSON.parse(readFileSync(path.join(root, 'tests/lib/block-battery-0.1.19.json'))).shapes;
const known = JSON.parse(readFileSync(path.join(root, 'tests/lib/block-battery-0.1.19-disagreements.json')));
if (shapes.length < 30) throw new Error(`current block battery has only ${shapes.length} shapes`);

const cli = path.join(root, 'node_modules/.bin/tree-sitter');
const work = mkdtempSync(path.join(tmpdir(), 'carve-current-battery-'));
const classes = [
  [/^section$|^heading$/, 'heading'],
  [/^caption$/, 'caption'],
  [/^block_quote$/, 'quote'],
  [/^definition_list$/, 'deflist'],
  [/^list$/, 'list'],
];
const seen = new Set();
const failures = [];
for (const { src, want } of shapes) {
  const file = path.join(work, 'shape.crv');
  writeFileSync(file, `${src}\nafter\n`);
  let output;
  try {
    output = execFileSync(cli, ['parse', ...TIMEOUT_ARGS, file], {
      encoding: 'utf8', timeout: spawnBudgetMs(1),
    });
  } catch (error) {
    output = error.stdout ?? '';
    if (!output.trim()) throw new Error(`no parse tree for ${JSON.stringify(src)} within ${PARSE_TIMEOUT_US / 1_000_000}s`);
  }
  const node = (output.split('\n')[1] ?? '').trim().replace(/^\(/, '').split(/[\s[]/)[0];
  const got = classes.find(([pattern]) => pattern.test(node))?.[1] ?? 'none';
  const record = known[src];
  if (record) {
    seen.add(src);
    if (got === want || got !== record.got) failures.push(`${JSON.stringify(src)}: recorded ${record.got}, now ${got}, expected ${want}`);
  } else if (got !== want) {
    failures.push(`${JSON.stringify(src)}: expected ${want}, got ${got}`);
  }
}
for (const src of Object.keys(known)) if (!seen.has(src)) failures.push(`${JSON.stringify(src)} is not in the battery`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`current block battery: ${shapes.length} shapes, ${seen.size} recorded disagreement(s)`);
