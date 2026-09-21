#!/usr/bin/env node
// THE INLINE COUNTERPART OF THE OVER-ACCEPTANCE SCAN.
//
// `corpus-conformance` asserts that a covered document builds no ERROR and no
// MISSING node, and `under-acceptance` asks whether the BLOCK the language
// builds is there. Neither asks about inline structure, so a category whose
// every document builds the wrong spans reported as `covered`: a wrong reading
// is a perfectly clean tree (tree-sitter-carve#307).
//
// The expected fixture names each inline construct the language builds and the
// text it covers. Each tracked tag is paired, in document order, with the node
// of the matching type, and two things are compared: how many there are, and
// the alphanumeric SKELETON of what each covers. Markers, smart typography,
// dashes, escapes and entities are all non-alphanumeric, so they drop out; a
// span that stops early, runs long or swallows its neighbour does not.
//
// The skeleton is what makes this more than a count. A count-only version of
// this check dropped `01-emphasis-13` as fixed once its span count matched,
// while its first emphasis still stopped at the wrong slash, and could not see
// a delete that grew to swallow the word beside it.
//
// What it still cannot see: the ORDER of two sibling spans of different kinds,
// and any shape the corpus does not contain. `sup` and `sub` are left out: a
// footnote reference renders a superscript only once it resolves, which no
// grammar models (#322).
//
// Known gaps are RECORDED, exact in three directions: a NEW divergence fails, a
// recorded one that has been FIXED fails, and one whose reading MOVES fails.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';
import { parseTrees } from './parse-batched.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);

const slugOf = (name) => name.replace(/^\d+-/, '');
const covered = new Set(coverage.covered.map(slugOf));
const skip = new Set(Object.keys(coverage.skip).map(slugOf));
const baseCategory = (file) => path.basename(file, '.crv').replace(/-[0-9]+$/, '');

// One occurrence of the node renders as this tag. `tag` and `mention` render
// their own text in bold. `bold_italic` and `substitution` are handled below,
// because each renders as two containers.
const NODE_TAG = {
  strong: 'strong',
  emphasis: 'em',
  underline: 'u',
  strikethrough: 's',
  highlighted: 'mark',
  insert: 'ins',
  delete: 'del',
  verbatim: 'code',
  tag: 'strong',
  mention: 'strong',
};
const TAGS = ['strong', 'em', 'u', 's', 'mark', 'ins', 'del', 'code'];

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
const skeleton = (s) =>
  decode(s).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

// Source a reader never sees inside a non-code span: comments, link
// destinations, a reference link's label and attribute blocks. Inside a code
// span every one of those is literal text, so code spans keep them.
const visible = (s) =>
  s
    .replace(/\{%[\s\S]*?%\}/g, '')
    .replace(/\{#[\s\S]*?#\}/g, '')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(/\]\[[^\]]*\]/g, ']')
    .replace(/\{[.#:][^}]*\}/g, '')
    .replace(/\{[A-Za-z_][\w-]*=[^}]*\}/g, '');

function htmlSpans(html) {
  // A fenced code block renders <pre><code>, with no `verbatim` node behind it.
  const s = html.replace(/<pre[\s\S]*?<\/pre>/g, '');
  const out = [];
  const stack = [];
  const text = [];
  const re = /<(\/?)([a-z0-9]+)([^>]*)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    text.push(s.slice(last, m.index));
    last = re.lastIndex;
    const [, close, tag, rest] = m;
    if (!TAGS.includes(tag) || rest.endsWith('/')) continue;
    const at = text.join('').length;
    if (close) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tag === tag) {
          const open = stack.splice(k, 1)[0];
          out[open.index].text = text.join('').slice(open.at, at);
          break;
        }
      }
    } else {
      out.push({ tag, text: '' });
      stack.push({ tag, at, index: out.length - 1 });
    }
  }
  return out;
}

function treeSpans(tree, source) {
  // Tree positions are BYTE columns, so slice a Buffer rather than a string.
  const buf = Buffer.from(source, 'utf8');
  const lineStart = [0];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a || (buf[i] === 0x0d && buf[i + 1] !== 0x0a)) lineStart.push(i + 1);
  }
  const at = (row, col) => (lineStart[row] ?? buf.length) + col;
  const slice = (r1, c1, r2, c2) => buf.slice(at(+r1, +c1), at(+r2, +c2)).toString('utf8');
  const out = [];
  const re = /(?:(from|to): )?\(([a-z_]+) \[(\d+), (\d+)\] - \[(\d+), (\d+)\]/g;
  for (const [, field, node, r1, c1, r2, c2] of tree.matchAll(re)) {
    // A substitution renders two SIBLING containers, one per half. An empty
    // half has no field in the tree, so both slots are reserved up front.
    if (node === 'substitution') {
      out.push({ tag: 'del', text: '', half: true }, { tag: 'ins', text: '', half: true });
      continue;
    }
    if (node === 'content' && field) {
      const tag = field === 'from' ? 'del' : 'ins';
      for (let k = out.length - 1; k >= 0; k--) {
        if (out[k].half && out[k].tag === tag) {
          out[k].text = slice(r1, c1, r2, c2);
          delete out[k].half;
          break;
        }
      }
      continue;
    }
    if (node === 'bold_italic') {
      const text = slice(r1, c1, r2, c2);
      out.push({ tag: 'strong', text }, { tag: 'em', text });
      continue;
    }
    const tag = NODE_TAG[node];
    if (tag) out.push({ tag, text: slice(r1, c1, r2, c2) });
  }
  return out;
}

function reading(html, tree, source) {
  const want = htmlSpans(html);
  const got = treeSpans(tree, source);
  const problems = [];
  for (const tag of TAGS) {
    const w = want.filter((x) => x.tag === tag);
    const g = got.filter((x) => x.tag === tag);
    if (w.length !== g.length) problems.push(`${tag} html=${w.length} tree=${g.length}`);
    for (let k = 0; k < Math.min(w.length, g.length); k++) {
      const a = skeleton(w[k].text);
      const b = skeleton(tag === 'code' ? g[k].text : visible(g[k].text));
      if (a !== b) problems.push(`${tag}#${k + 1} html="${a}" tree="${b}"`);
    }
  }
  return problems.join(', ');
}

const allFiles = readdirSync(corpusDir).filter((f) => f.endsWith('.crv')).sort();

refuseShortRun({
  label: 'CORPUS',
  actual: allFiles.length,
  atLeast: 1000,
  of: `document(s) under ${corpusDir}`,
  hint: 'the spec corpus has ~1740; run `git submodule update --init`.',
});

const targets = [];
for (const file of allFiles) {
  const category = slugOf(baseCategory(file));
  const stem = slugOf(path.basename(file, '.crv'));
  if (skip.has(category) || skip.has(stem)) continue;
  if (covered.has(category)) targets.push(path.join(corpusDir, file));
}

const recorded = coverage.inlineReadingGaps ?? {};
const trees = parseTrees(targets, repoRoot);

const found = {};
targets.forEach((file, i) => {
  const r = reading(
    readFileSync(file.replace(/\.crv$/, '.html'), 'utf8'),
    trees[i],
    readFileSync(file, 'utf8'),
  );
  if (r) found[slugOf(path.basename(file, '.crv'))] = r;
});

if (process.argv.includes('--dump')) {
  process.stdout.write(JSON.stringify(found, null, 1));
  process.exit(0);
}

console.log(
  `inline-reading: compared ${targets.length} covered document(s) by span count and ` +
    `covered text on ${TAGS.length} inline tag(s), sup/sub excluded; ` +
    `${Object.keys(found).length} divergent, ${Object.keys(recorded).length} recorded.`,
);

const newly = Object.keys(found).filter((k) => !(k in recorded));
const fixed = Object.keys(recorded).filter((k) => !(k in found));
const moved = Object.keys(found)
  .filter((k) => k in recorded && recorded[k].reading !== found[k])
  .map((k) => `${k}: recorded ${recorded[k].reading}, now ${found[k]}`);

if (newly.length || fixed.length || moved.length) {
  if (newly.length) {
    console.error('\nInline reading divergence (the tree reads these spans differently):');
    for (const k of newly) console.error(`  - ${k}: ${found[k]}`);
  }
  if (fixed.length) {
    console.error(
      '\nRecorded divergence that no longer happens - remove these from ' +
        '`inlineReadingGaps` in test/coverage.json:',
    );
    for (const k of fixed) console.error(`  - ${k}`);
  }
  if (moved.length) {
    console.error(
      '\nRecorded divergence whose reading MOVED - the grammar changed, so ' +
        'update `reading` and the reason in test/coverage.json:',
    );
    for (const k of moved) console.error(`  - ${k}`);
  }
  process.exit(1);
}

console.log('inline-reading: OK (every divergence is exactly the set recorded).');
