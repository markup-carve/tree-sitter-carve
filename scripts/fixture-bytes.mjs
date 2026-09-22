#!/usr/bin/env node
// The corpus fixtures carry bytes a text tool will silently rewrite: lone
// carriage returns, which are the whole input of the lone-CR cases, and a NUL
// in a control-character case. Rewritten, those cases still pass - they just
// stop testing anything. #330 normalized every lone CR in carve.txt to LF and
// nothing noticed for a day; a scanner that treated `\r` as ordinary text then
// passed the entire suite.
//
// So the counts are recorded here and a drop below them FAILS. Raise a minimum
// when you add a case that needs one; never lower it to make this pass.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MINIMUMS = {
  'test/corpus/carve.txt': { loneCR: 36, nul: 1 },
};

const count = (bytes) => {
  let loneCR = 0;
  let nul = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] !== 0x0a) loneCR++;
    if (bytes[i] === 0x00) nul++;
  }
  return { loneCR, nul };
};

const failures = [];
for (const [file, min] of Object.entries(MINIMUMS)) {
  const found = count(readFileSync(path.join(repoRoot, file)));
  for (const [kind, floor] of Object.entries(min)) {
    const label = `${file}: ${kind} ${found[kind]} (minimum ${floor})`;
    if (found[kind] < floor) failures.push(label);
    else console.log(`fixture-bytes: ${label}`);
  }
}

if (failures.length > 0) {
  console.error('fixture-bytes: a fixture lost bytes its cases depend on:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('Restore them from the commit that added the case; do not lower the minimum.');
  process.exit(1);
}
