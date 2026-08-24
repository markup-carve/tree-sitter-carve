#!/usr/bin/env node
// EVERY OTHER GATE IN THIS REPOSITORY IS BLIND TO A CORRUPTED HEAP.
//
// `corpus-conformance.mjs`, `line-terminators.mjs` and the batteries drive the
// tree-sitter CLI, which compiles `src/scanner.c` with `gcc -O2` into its own
// cached shared object. node-gyp compiles the SAME file with `-O3`, and that is
// the build an editor, a language server or `binding-parity.mjs` loads. When an
// optimization only the second build applies writes past an allocation, the
// first build parses the document happily and every gate stays green - which is
// exactly what tree-sitter-carve#266 was: eleven nested `:::: note` openers
// aborted the Node binding with `realloc(): invalid next size`, while a corpus
// document carrying 203 of them passed conformance.
//
// So this gate drives the ADDON, not the CLI, and it drives it past the depth
// at which the scanner's open-block stack has to grow. Each case runs in its own
// child process: a smashed heap kills the process, and a child lets the run say
// WHICH construct at WHICH depth killed it instead of dying itself.
import { spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';

const here = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(here), '..');

// One line per level, and the node the tree should hold once per level. The
// `node` column is what keeps this battery from measuring nothing: a unit that
// stopped nesting would still survive every depth, and the run would report a
// pass over documents that never reached the growth at all.
const CONSTRUCTS = [
  { name: 'div', unit: ':::: note\n', node: 'div' },
  { name: 'figure-div', unit: '::: figure\n', node: 'div' },
  { name: 'block-quote', unit: '> ', node: 'block_quote' },
  { name: 'dash-list', unit: '- ', node: 'list' },
  { name: 'star-list', unit: '* ', node: 'list' },
];

// 8 is the stack's initial capacity, so 9 is the first level that reallocates
// and 11 is the depth the ticket reported. 50 and 200 are well past both: an
// off-by-one reintroduced in the same place has to be caught here rather than
// merely moved one level along.
const DEPTHS = [9, 11, 12, 50, 200];

// The depth every construct must genuinely reach, checked against `node`.
const SHAPE_DEPTH = 11;

if (process.argv[2] === '--case') {
  const [, , , unit, depth, node] = process.argv;
  const { createRequire } = await import('node:module');
  const require = createRequire(here);
  const Parser = require('tree-sitter');
  const carve = require(path.join(repoRoot, 'bindings', 'node'));
  const parser = new Parser();
  parser.setLanguage(carve);
  const source = JSON.parse(unit).repeat(Number(depth)) + 'x\n';
  const tree = parser.parse(source).rootNode.toString();
  const found = tree.split('(' + node + ' ').length - 1;
  // writeSync, not process.stdout.write: stdout is a pipe here, the write is
  // asynchronous on a pipe, and an immediate exit would drop the report - which
  // this gate would then read as a failed case with no diagnostic.
  writeSync(1, JSON.stringify({ found }));
  process.exit(0);
}

const findings = [];
let cases = 0;

for (const { name, unit, node } of CONSTRUCTS) {
  for (const depth of DEPTHS) {
    cases += 1;
    const label = name + ' x ' + depth;
    const run = spawnSync(
      process.execPath,
      [here, '--case', JSON.stringify(unit), String(depth), node],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    const firstLine = (run.stderr || '').trim().split('\n')[0];
    if (run.signal) {
      findings.push(
        label + ': the parse killed the process with ' + run.signal + '. ' +
          (firstLine || 'no diagnostic'),
      );
      continue;
    }
    if (run.status !== 0) {
      findings.push(label + ': exited ' + run.status + '. ' + firstLine);
      continue;
    }
    let report;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      findings.push(label + ': no report on stdout, got ' + JSON.stringify(run.stdout.slice(0, 120)));
      continue;
    }
    if (depth === SHAPE_DEPTH && report.found !== depth) {
      findings.push(
        label + ': the tree holds ' + report.found + ' ' + node + ' node(s), not ' + depth +
          '. This case no longer nests, so it no longer reaches the growth it is here to exercise.',
      );
    }
  }
}

refuseShortRun({
  label: 'NESTING DEPTH BATTERY',
  actual: cases,
  atLeast: CONSTRUCTS.length * DEPTHS.length,
  of: 'construct/depth case(s)',
  hint: 'every construct has to be driven at every depth for the run to mean anything.',
});

if (findings.length) {
  console.error('Nesting depth: ' + findings.length + ' case(s) failed.');
  findings.forEach((finding) => console.error('  - ' + finding));
  process.exit(1);
}
console.log('nesting depth: ' + cases + ' case(s) parsed through the Node binding, deepest ' + Math.max(...DEPTHS) + '.');
