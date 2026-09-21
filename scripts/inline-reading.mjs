#!/usr/bin/env node
// THE INLINE COUNTERPART OF THE OVER-ACCEPTANCE SCAN.
//
// `corpus-conformance` asserts that a covered document builds no ERROR and no
// MISSING node, and `under-acceptance` asks whether the BLOCK the language
// builds is there. Between them sits every question about inline structure,
// and nothing asked one: a category whose every document parses to the wrong
// spans reports as `covered`, because a wrong reading is a perfectly clean
// tree. Corpus 471 is eight such documents (tree-sitter-carve#307), and it was
// not alone - 46 covered categories were in that state when this was written.
//
// The corpus carries the oracle already. The expected fixture names each
// inline construct the language builds, so counting those tags and counting
// the nodes that produce them is a reading comparison the grammar can be held
// to. It is a COUNT, not a shape: a tree that nests `strong > strong` where
// the language builds one strong over literal text differs here, while one
// that swaps two siblings does not. So this is a floor on the divergence, and
// the recorded list below is a floor on the work.
//
// Known gaps are RECORDED rather than tolerated, in the same three directions
// `overAcceptance` uses: a NEW divergence fails, a recorded one that has been
// FIXED fails, and a recorded one whose counts MOVE fails.

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

// One occurrence of the node contributes these tags to the render.
//
// `tag` and `mention` earn their entries: both render their own text in bold,
// so a document holding one has a `<strong>` with no strong span behind it.
// The same reasoning would put `sup` on `footnote_reference`, and it is left
// out below instead - see SKIPPED_TAGS.
const NODE_TO_TAGS = {
  strong: ['strong'],
  emphasis: ['em'],
  underline: ['u'],
  strikethrough: ['s'],
  highlighted: ['mark'],
  insert: ['ins'],
  delete: ['del'],
  bold_italic: ['strong', 'em'],
  substitution: ['del', 'ins'],
  verbatim: ['code'],
  tag: ['strong'],
  mention: ['strong'],
};

const TAGS = ['strong', 'em', 'u', 's', 'mark', 'ins', 'del', 'code'];

// `sup` and `sub` are NOT compared, and saying why is the point of the entry.
// A footnote reference renders `<sup>` only once it RESOLVES, and resolution
// is a document-wide pass a grammar does not run: the same
// `footnote_reference` node renders a superscript in one document and literal
// text in another. 44 documents differ on that alone, none of them a grammar
// defect. Adding the pair back needs resolution modeled here first, not a
// wider node map.
const SKIPPED_TAGS = ['sup', 'sub'];

function tagCounts(html) {
  // A fenced code block renders `<pre><code>`, and no `verbatim` node stands
  // behind that `<code>`. Drop every `<pre>` subtree before counting.
  const stripped = html.replace(/<pre[\s\S]*?<\/pre>/g, '');
  const counts = Object.fromEntries(TAGS.map((t) => [t, 0]));
  for (const tag of TAGS) {
    const found = stripped.match(new RegExp(`<${tag}[\\s>]`, 'g'));
    counts[tag] = found ? found.length : 0;
  }
  return counts;
}

function nodeCounts(tree) {
  const counts = Object.fromEntries(TAGS.map((t) => [t, 0]));
  for (const match of tree.matchAll(/\(([a-z_]+) \[/g)) {
    const tags = NODE_TO_TAGS[match[1]];
    if (tags) for (const tag of tags) counts[tag] += 1;
  }
  return counts;
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
  const html = readFileSync(file.replace(/\.crv$/, '.html'), 'utf8');
  const want = tagCounts(html);
  const got = nodeCounts(trees[i]);
  const diff = TAGS.filter((t) => want[t] !== got[t]).map(
    (t) => `${t} html=${want[t]} tree=${got[t]}`,
  );
  if (diff.length) found[slugOf(path.basename(file, '.crv'))] = diff.join(', ');
});

console.log(
  `inline-reading: compared ${targets.length} covered document(s) on ` +
    `${TAGS.length} inline tag(s), ${SKIPPED_TAGS.join('/')} excluded; ` +
    `${Object.keys(found).length} divergent, ${Object.keys(recorded).length} recorded.`,
);

const newly = Object.keys(found).filter((k) => !(k in recorded));
const fixed = Object.keys(recorded).filter((k) => !(k in found));
const moved = Object.keys(found)
  .filter((k) => k in recorded && recorded[k].counts !== found[k])
  .map((k) => `${k}: recorded ${recorded[k].counts}, now ${found[k]}`);

if (newly.length || fixed.length || moved.length) {
  if (newly.length) {
    console.error(
      '\nInline reading divergence (the language builds these spans, the grammar does not):',
    );
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
      '\nRecorded divergence whose counts MOVED - the grammar changed, so ' +
        'update `counts` and the reason in test/coverage.json:',
    );
    for (const k of moved) console.error(`  - ${k}`);
  }
  process.exit(1);
}

console.log('inline-reading: OK (every divergence is exactly the set recorded).');
