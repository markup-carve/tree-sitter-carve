#!/usr/bin/env node
// The oracle against the corpus goldens.
//
// Every gate that compares the grammar with `@markup-carve/carve` can only see
// where the two disagree. When the pinned engine lags a spec ruling the grammar
// also lags, both agree and those gates stay green. This asks the engine alone:
// does it render each corpus document to the golden HTML? A disagreement not in
// `oracleGoldenDisagreements` in test/coverage.json fails, and so does a
// recorded one that no longer happens.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);
const recorded = coverage.oracleGoldenDisagreements ?? {};

const files = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.crv'))
  .sort();
refuseShortRun({
  label: 'CORPUS',
  actual: files.length,
  atLeast: 1000,
  of: `document(s) under ${corpusDir}`,
  hint: 'the spec corpus has ~2200; run `git submodule update --init`.',
});

// Name the engine that actually loaded: a stray node_modules higher up can
// shadow the pinned one.
const entry = import.meta.resolve('@markup-carve/carve');
const { version } = createRequire(entry)('../package.json');
const { carveToHtml } = await import(entry);
console.log(`oracle-goldens: @markup-carve/carve ${version} from ${fileURLToPath(entry)}`);

const firstDifference = (got, want) => {
  const a = got.split('\n');
  const b = want.split('\n');
  const i = a.findIndex((line, k) => line !== b[k]);
  const at = i === -1 ? a.length : i;
  return `line ${at + 1}: got ${JSON.stringify(a[at] ?? '<end>')}, want ${JSON.stringify(b[at] ?? '<end>')}`;
};

// Keyed without the corpus order number, as every ledger in coverage.json is.
const found = {};
for (const f of files) {
  const source = readFileSync(path.join(corpusDir, f), 'utf8');
  const want = readFileSync(path.join(corpusDir, f.replace(/\.crv$/, '.html')), 'utf8').trim();
  let got;
  try {
    got = carveToHtml(source).trim();
  } catch (e) {
    found[f.replace(/\.crv$/, '').replace(/^[0-9]+-/, '')] = `threw: ${e.message}`;
    continue;
  }
  if (got !== want) {
    found[f.replace(/\.crv$/, '').replace(/^[0-9]+-/, '')] = firstDifference(got, want);
  }
}

const isNew = Object.keys(found).filter((k) => !(k in recorded));
const nowFixed = Object.keys(recorded).filter((k) => !(k in found));

console.log(
  `oracle-goldens: checked ${files.length} document(s); ` +
    `${Object.keys(found).length} disagree with their golden, ${Object.keys(recorded).length} recorded.`,
);

if (isNew.length || nowFixed.length) {
  if (isNew.length) {
    console.error('\nThe oracle renders these differently from their golden HTML:');
    for (const k of isNew) console.error(`  - ${k}: ${found[k]}`);
  }
  if (nowFixed.length) {
    console.error(
      '\nRecorded disagreement that no longer happens - remove these from ' +
        '`oracleGoldenDisagreements` in test/coverage.json:',
    );
    for (const k of nowFixed) console.error(`  - ${k}`);
  }
  process.exit(1);
}
console.log('oracle-goldens: OK (every disagreement is recorded exactly).');
