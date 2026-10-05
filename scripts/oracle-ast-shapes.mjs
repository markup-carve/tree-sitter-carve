#!/usr/bin/env node
// The oracle's AST against a tracked record of its own shape.
//
// `oracle-goldens.mjs` holds the engine's HTML to the corpus goldens, and
// `under-acceptance.mjs` holds the grammar to the engine's PART 12 AST. Between
// them sits the gap #499 narrowed to: the first gate reads HTML, the second
// compares grammar against oracle, so a ruling that moves the AST without
// moving any rendered element is invisible to both - the HTML golden still
// matches and the two lagging trees still agree.
//
// The corpus ships no AST sidecar, so there is nothing engine-independent to
// compare against. This records the shape in-tree instead and holds the engine
// to it, the way the `.html` goldens hold its rendering: any AST movement
// between pins has to be read and written down rather than passing silently.
//
// THE CASE THIS IS KEYED TO is corpus `108-security-hardening-8` and `-10`:
// `[danger]{onclick="steal()"}` and `[danger]{srcdoc="<script>"}` both render
// `<p>A <span>danger</span> span.</p>`, byte for byte, because the renderer
// drops the refused attribute. The AST keeps it. Swap one source for the other
// and every HTML golden still matches while the tree has changed.
//
// WHAT THE SHAPE RECORDS is what HTML can drop, and only that:
//   - `parent>type`, so a node re-parented inside a container that collapses in
//     HTML moves the record.
//   - `type@key` for each attribute slot, so an attribute landing on a
//     different node moves it, and so does one the renderer refuses to emit.
//   - the count of each, so a node kind HTML has no element for is visible.
// Positions and text values are left out on purpose: a position carries no
// ruling, and text that reaches the reader is already `oracle-goldens`' job.
// `attrs.order` is left out for the second reason - the renderer emits the slots
// in that order, so moving it moves the HTML. Anything this does not read stays
// that gate's to catch.
//
// THE WALK DOES NOT DESCEND INTO `attrs`, and that is load-bearing rather than
// an optimization: an attribute name is an ordinary identifier, so
// `[x](/u){type=widget}` puts an object literally shaped `{"type":"widget"}` in
// the tree. A generic walk that entered `keyValues` would count that value as a
// node of type `widget`. The slots are read from `attrs` directly instead.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const recordPath = path.join(repoRoot, 'test', 'ast-shapes.json');
const write = process.argv.includes('--write');

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
// shadow the pinned one, and a shape read off the wrong engine is worse than
// no shape at all.
const entry = import.meta.resolve('@markup-carve/carve');
const { version } = createRequire(entry)('../package.json');
const { parse } = await import(entry);
console.log(`oracle-ast-shapes: @markup-carve/carve ${version} from ${fileURLToPath(entry)}`);

const POSITION_KEYS = new Set(['pos', 'position', 'span', 'offset', 'loc']);

function census(node, out, parent) {
  if (!node || typeof node !== 'object') return out;
  let type = parent;
  if (typeof node.type === 'string') {
    type = node.type;
    const key = `${parent}>${type}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  const attrs = node.attrs;
  if (attrs && typeof attrs === 'object') {
    const slots = Object.keys(attrs.keyValues ?? {});
    if (Array.isArray(attrs.classes) && attrs.classes.length) slots.push('class');
    if (attrs.id) slots.push('id');
    for (const slot of slots) {
      const key = `${type}@${slot}`;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (POSITION_KEYS.has(key) || key === 'attrs') continue;
    if (Array.isArray(value)) value.forEach((v) => census(v, out, type));
    else if (value && typeof value === 'object') census(value, out, type);
  }
  return out;
}

const shapeOf = (source) => {
  let ast;
  try {
    ast = parse(source);
  } catch (e) {
    return `threw: ${e.message}`;
  }
  return [...census(ast, new Map(), '.')]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, n]) => (n === 1 ? key : `${key}*${n}`))
    .join(' ');
};

// Keyed without the corpus order number, as every record here is: the leading
// digits are the spec's document order and an upstream insertion renumbers
// everything after it. That makes a collision possible in principle, so say so
// rather than letting one document's shape silently stand in for another's.
const live = {};
const collisions = [];
for (const f of files) {
  const key = f.replace(/\.crv$/, '').replace(/^[0-9]+-/, '');
  if (key in live) collisions.push(key);
  live[key] = shapeOf(readFileSync(path.join(corpusDir, f), 'utf8'));
}

if (collisions.length) {
  console.error('\nTwo corpus documents share a record key once the order number is dropped:');
  for (const key of [...new Set(collisions)].sort()) console.error(`  - ${key}`);
  process.exit(1);
}

if (write) {
  writeFileSync(recordPath, `${JSON.stringify(live, null, 1)}\n`);
  console.log(
    `oracle-ast-shapes: wrote ${Object.keys(live).length} shape(s) to ${path.relative(repoRoot, recordPath)}; ` +
      'read the diff before committing it.',
  );
  process.exit(0);
}

const recorded = JSON.parse(readFileSync(recordPath, 'utf8'));

const missing = Object.keys(live).filter((k) => !(k in recorded));
const stale = Object.keys(recorded).filter((k) => !(k in live));
const moved = Object.keys(live).filter((k) => k in recorded && recorded[k] !== live[k]);

console.log(
  `oracle-ast-shapes: checked ${files.length} document(s) against ` +
    `${Object.keys(recorded).length} recorded shape(s); ${moved.length} moved.`,
);

if (missing.length || stale.length || moved.length) {
  if (moved.length) {
    console.error(
      "\nThe oracle's AST moved for these documents while their HTML golden still " +
        'matches. Read each one, then re-record with ' +
        '`node scripts/oracle-ast-shapes.mjs --write`:',
    );
    for (const k of moved) {
      console.error(`  - ${k}:`);
      console.error(`      recorded ${JSON.stringify(recorded[k])}`);
      console.error(`      now      ${JSON.stringify(live[k])}`);
    }
  }
  if (missing.length) {
    console.error('\nCorpus document with no recorded shape:');
    for (const k of missing) console.error(`  - ${k}`);
  }
  if (stale.length) {
    console.error('\nRecorded shape for a document the corpus no longer ships:');
    for (const k of stale) console.error(`  - ${k}`);
  }
  process.exit(1);
}
console.log('oracle-ast-shapes: OK (every shape matches the record).');
