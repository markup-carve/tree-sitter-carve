#!/usr/bin/env node
// The mirror of the over-acceptance check in corpus-conformance.mjs.
//
// That check asks: the language renders one paragraph, does the grammar build a
// block anyway? This one asks the opposite: the LANGUAGE builds a block and the
// grammar builds none. That is not an ERROR - the input falls back to a
// paragraph, the tree is clean, and a conformance run stays green with the
// construct silently unhighlighted. tree-sitter-carve#49 hid exactly that way:
// `___` is one of three thematic-break spellings and the file containing all
// three parsed clean with the third folded into a paragraph.
//
// THE ORACLE IS THE AST, NOT THE HTML. Counting rendered elements does not
// work - a footnote section renders `<hr>` and `<h2>` with no source construct
// behind them, so the count is wrong in the safe direction for some documents
// and the unsafe direction for others. The PART 12 tree has no renderer-invented
// nodes: a `thematic_break` in it is one the language actually built.
//
// AN UNMAPPED AST TYPE IS A HARD ERROR, not a silent zero. Measured before this
// script existed: 74 raw candidates, of which the largest group - 15 `figure`
// entries - was not a gap at all, because this grammar has no `figure` node and
// models an image-with-caption differently. A count-based check reports a
// missing node for every concept the two models spell differently, so the map
// below is exhaustive by construction and a new spec node kind fails the run
// until someone classifies it.
import { readFileSync, readdirSync } from 'node:fs';
import { refuseShortRun } from './participants.mjs';
import { parseTrees } from './parse-batched.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);

// AST block type -> the node this grammar builds for it.
//
// `null` means DELIBERATELY UNCOMPARABLE: the grammar models the construct
// differently, so a count comparison is meaningless rather than a gap. Each
// null carries its reason.
const NODE_FOR = {
  thematic_break: 'thematic_break',
  block_quote: 'block_quote',
  table: 'table',
  heading: 'heading',
  code_block: 'code_block',
  list: 'list',
  definition_list: 'definition_list',
  line_block: 'line_block',
  div: 'div',
  raw_block: 'raw_block',
  // No `figure` node: an image with a caption is an image plus a caption here,
  // so a figure count has nothing to compare against.
  figure: null,
  // Sections wrap headings in the AST; the grammar nests content under the
  // heading itself and builds no separate node.
  section: null,
  // Paragraphs are the fallback every gap falls INTO, so comparing them would
  // report every gap twice and mask nothing.
  paragraph: null,
  // Definitions and comments render nothing and are already the subject of the
  // over-acceptance check's RENDERS_NOTHING set.
  footnote: null,
  abbreviation_def: null,
  comment: null,
  // Same family, and it joined the engine's block vocabulary with the pin bump
  // that fixed the oracle (carve-js #839 anchored the definition at end of
  // line, which is what put the node in `CANONICAL_BLOCK_TYPES`). Counting it
  // here would double-report what the RENDERS_NOTHING scan already asks, and
  // ask it worse: that scan checks whether the definition's own source text
  // survived into the render, which is the question that matters for a node
  // producing no output of its own.
  link_reference_definition: null,
  admonition: 'div',
  list_item: null,
  definition_term: null,
  definition_description: null,
  table_row: null,
  table_cell: null,
  caption: null,
  frontmatter: null,
};

const slugOf = (stem) => stem.replace(/^[0-9]+-/, '').replace(/-[0-9]+$/, '');
const covered = new Set(coverage.covered);
const skip = coverage.skip ?? {};
const recorded = coverage.underAcceptance ?? {};

// Measured before this line existed: with the corpus emptied AND
// `underAcceptance` emptied, this printed "checked 0 document(s); 0 with gaps,
// 0 recorded" and exited 0. The reconciliation against the record is the only
// thing that catches an empty corpus today, and an empty record is the state
// this ledger is trying to reach - 25 gaps now, zero being the goal. A gate that
// stops working once its subject is healthy is not a gate
// (markup-carve/carve#755).
refuseShortRun({
  label: 'CORPUS',
  actual: readdirSync(corpusDir).filter((f) => f.endsWith('.crv')).length,
  atLeast: 400,
  of: `document(s) under ${corpusDir}`,
  hint: 'the spec corpus has ~650; run `git submodule update --init`.',
});

const files = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.crv'))
  .sort()
  .map((f) => path.join(corpusDir, f))
  .filter((f) => {
    const stem = path.basename(f, '.crv');
    // A skip key is a CATEGORY (`slug`) or a single EXAMPLE (`slug-2`), both
    // written WITHOUT the corpus order number - so the example form matches
    // neither the raw stem nor the category slug, and those files were still
    // being checked here. They are skipped because they parse as ERROR, which
    // is exactly the state that makes a block count meaningless.
    const exampleKey = stem.replace(/^[0-9]+-/, '');
    return (
      covered.has(slugOf(stem)) &&
      !(stem in skip) &&
      !(exampleKey in skip) &&
      !(slugOf(stem) in skip)
    );
  });

const { parse, CANONICAL_BLOCK_TYPES } = await import('@markup-carve/carve');

// The map has to cover the whole BLOCK vocabulary. Inline types are out of
// scope - they are not blocks and cannot be "a block the grammar did not
// build" - so the universe is the engine's own list rather than every type
// seen in a tree, and a new block kind fails the run until it is classified.
const blockTypes = new Set(CANONICAL_BLOCK_TYPES);
const unmapped = new Set(
  [...blockTypes].filter((t) => !(t in NODE_FOR) && t !== 'document'),
);

function countAst(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (typeof node.type === 'string' && blockTypes.has(node.type)) {
    const target = NODE_FOR[node.type];
    if (target) acc.set(target, (acc.get(target) ?? 0) + 1);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => countAst(v, acc));
    else if (value && typeof value === 'object') countAst(value, acc);
  }
  return acc;
}

const perFile = parseTrees(files, repoRoot);

const found = {};
files.forEach((file, i) => {
  const want = countAst(parse(readFileSync(file, 'utf8')), new Map());
  const tree = perFile[i];
  const gaps = [];
  for (const [node, n] of [...want].sort()) {
    const have = (tree.match(new RegExp(`\\(${node}[\\s[]`, 'g')) ?? []).length;
    if (n > have) gaps.push(`${node}: want ${n} have ${have}`);
  }
  // Keyed WITHOUT the corpus order number. The leading digits are the spec's
  // document order, not an identity: an example inserted upstream renumbers
  // everything after it, and keying on the number would report every unchanged
  // gap as both removed and newly added. The `-N` example suffix stays - it
  // distinguishes the variants within a category.
  if (gaps.length) {
    found[path.basename(file, '.crv').replace(/^[0-9]+-/, '')] = gaps.join('; ');
  }
});

if (unmapped.size) {
  console.error(
    '\nBlock types with no entry in NODE_FOR - classify each as a node name ' +
      'or as null with the reason it is uncomparable:',
  );
  for (const t of [...unmapped].sort()) console.error(`  - ${t}`);
  process.exit(1);
}

const isNew = Object.keys(found).filter((k) => !(k in recorded));
const nowFixed = Object.keys(recorded).filter((k) => !(k in found));
const changed = Object.keys(found)
  .filter((k) => k in recorded && recorded[k].gaps !== found[k])
  .map((k) => `${k}: recorded "${recorded[k].gaps}", now "${found[k]}"`);

console.log(
  `under-acceptance: checked ${files.length} document(s); ` +
    `${Object.keys(found).length} with gaps, ${Object.keys(recorded).length} recorded.`,
);

if (isNew.length || nowFixed.length || changed.length) {
  if (isNew.length) {
    console.error('\nUnder-acceptance (the language builds a block, the grammar does not):');
    for (const k of isNew) console.error(`  - ${k}: ${found[k]}`);
  }
  if (nowFixed.length) {
    console.error(
      '\nRecorded under-acceptance that no longer happens - remove these from ' +
        '`underAcceptance` in test/coverage.json:',
    );
    for (const k of nowFixed) console.error(`  - ${k}`);
  }
  if (changed.length) {
    console.error('\nRecorded under-acceptance whose gap changed:');
    for (const c of changed) console.error(`  - ${c}`);
  }
  process.exit(1);
}
console.log('under-acceptance: OK (every gap is recorded exactly).');
