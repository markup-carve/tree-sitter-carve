#!/usr/bin/env node
// Shared-corpus conformance check.
//
// For every `.crv` input in the shared Carve spec corpus (spec/tests/corpus)
// that belongs to a COVERED category (see test/coverage.json), parse it with
// the generated tree-sitter grammar and assert the resulting tree contains no
// ERROR and no MISSING node. A spec construct the grammar chokes on fails CI.
//
// Files in SKIP categories are not asserted here (they have a recorded grammar
// gap), and a skip key may also name a single EXAMPLE (`NN-slug-2`) so one
// unparsable example does not drop assertion for its whole category. The
// coverage-matrix check is what guards the skip list itself.
//
// Parsing is delegated to the `tree-sitter parse` CLI so this script does not
// depend on the compiled native node binding being loadable in CI. All covered
// files are parsed in a single `--quiet` invocation: in quiet mode the CLI
// prints exactly one line per file whose tree has an error (ERROR or MISSING)
// and stays silent for clean files, so any output line is a conformance
// failure.

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = path.join(repoRoot, 'spec', 'tests', 'corpus');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);

// A category's identity is its SLUG, not its numbered filename: the numeric
// prefix is a position in the spec's document order, so one inserted example
// renumbers every category after it. Same note as coverage-matrix.mjs.
const slugOf = (name) => name.replace(/^\d+-/, '');

const covered = new Set(coverage.covered.map(slugOf));
const skip = new Set(Object.keys(coverage.skip).map(slugOf));

function baseCategory(file) {
  return path.basename(file, '.crv').replace(/-[0-9]+$/, '');
}

const allFiles = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.crv'))
  .sort();

const coveredFiles = [];
// Every file a skip entry covers, so the entry can be re-checked below. A skip
// is a statement about the grammar TODAY; nothing re-asked it.
const skippedFilesByKey = new Map();
let skippedCount = 0;
for (const file of allFiles) {
  const category = slugOf(baseCategory(file));
  const stem = slugOf(path.basename(file, '.crv'));
  if (skip.has(category) || skip.has(stem)) {
    skippedCount += 1;
    const key = skip.has(stem) ? stem : category;
    if (!skippedFilesByKey.has(key)) skippedFilesByKey.set(key, []);
    skippedFilesByKey.get(key).push(path.join(corpusDir, file));
    continue;
  }
  // Unknown categories are reported by the coverage-matrix check; conformance
  // only asserts on categories explicitly marked covered.
  if (covered.has(category)) {
    coveredFiles.push(path.join(corpusDir, file));
  }
}

// `tree-sitter parse --quiet FILES...` prints one line per file whose parse
// tree contains an error and is silent otherwise; exit status is non-zero when
// any tree had an error. We rely on stdout: each printed line names a failing
// covered file.
const result = spawnSync(
  'npx',
  ['tree-sitter', 'parse', '--quiet', ...coveredFiles],
  { cwd: repoRoot, encoding: 'utf8' },
);

if (result.error) {
  console.error(`Failed to run tree-sitter parse: ${result.error.message}`);
  process.exit(2);
}

const failures = (result.stdout || '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0);

// In `--quiet` mode the CLI is silent for clean files and prints one line per
// file with an error, so a clean run is empty stdout with exit 0 and a run with
// conformance failures is non-empty stdout with exit non-zero. A non-zero exit
// with no per-file output means the invocation itself failed (parser failed to
// load, bad path, etc.) - that must be a hard error, never a silent pass.
if (failures.length === 0 && result.status !== 0) {
  console.error(
    `tree-sitter parse exited with status ${result.status} but produced no ` +
      'per-file output; the parse invocation failed.',
  );
  if (result.stderr) console.error(result.stderr.toString().trim());
  process.exit(2);
}

console.log(
  `corpus-conformance: parsed ${coveredFiles.length} file(s) across ${covered.size} ` +
    `covered categories; ${skippedCount} file(s) skipped via ${skip.size} skip entr` +
    `${skip.size === 1 ? 'y' : 'ies'}.`,
);

if (failures.length) {
  console.error('\nConformance failures (covered category produced ERROR/MISSING):');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nA covered category must parse cleanly. Either fix the grammar or move the ' +
      'category to the skip list in test/coverage.json with a reason.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// A SKIP THAT NOW PARSES IS A SKIP THAT SHOULD BE COVERED.
//
// The over-acceptance record below is exact in three directions - a new one
// fails, a fixed one fails, a changed one fails - and the skip list was gated in
// one: a category with no entry fails, and an entry whose grammar gap has since
// been closed lives forever. That asymmetry is what turns a skip list into a
// list of excuses: the entry keeps a category out of the conformance run, and
// nothing re-asks the question it recorded.
//
// So every skipped file is re-parsed, and an entry whose files ALL parse cleanly
// fails the run. The reasons here are precise about which files they cover
// (`nested-containers-2` is example-level on purpose), and this is what keeps
// them that way.
const promotable = [];
for (const [key, skippedFiles] of skippedFilesByKey) {
  const check = spawnSync('npx', ['tree-sitter', 'parse', '--quiet', ...skippedFiles], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  // Same reading as above: output lines name files with an error, so no output
  // AND a zero exit is the only clean result. A non-zero exit with no output is
  // an invocation failure, not a clean parse, and must not read as promotable.
  const errored = (check.stdout || '').split('\n').filter((l) => l.trim().length > 0);
  if (errored.length === 0 && check.status === 0) {
    promotable.push([key, skippedFiles.length]);
  }
}

if (promotable.length) {
  console.error('\nSkip entries whose files now parse cleanly:');
  for (const [key, n] of promotable) {
    console.error(`  - ${key} (${n} file${n === 1 ? '' : 's'})`);
  }
  console.error(
    '\nThe grammar gap each of these records has been closed. Move the key to ' +
      '`covered` in test/coverage.json so the category is asserted again.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// The other side: OVER-ACCEPTANCE.
//
// The check above asserts that a covered document parses with no ERROR and no
// MISSING node. That is one-sided. It catches a construct the grammar CHOKES
// on, and it is structurally incapable of catching one the grammar ACCEPTS
// that the language declines - an over-permissive rule produces a perfectly
// clean tree.
//
// That direction is the more damaging one. Parsing an invalid construct as
// valid HIDES the author's mistake: an indented `:::` is prose, and a grammar
// that folds it as a container tells the author their fence worked.
//
// The corpus already carries the oracle. Where the expected HTML is a SINGLE
// paragraph, the language declined every block construct in the input, so the
// grammar must not have built a block node either - except the ones that
// legitimately render nothing (a reference definition, an abbreviation
// definition, frontmatter, a comment, an attribute line).
//
// Known gaps are RECORDED rather than tolerated, and the list is exact in
// THREE directions: a NEW over-acceptance fails, a recorded one that has been
// FIXED fails, and a recorded one that starts building a DIFFERENT block node
// fails. A subset check would let the first through as soon as the list had an
// entry, and comparing keys alone would let the third through - the grammar
// would still be wrong, just wrong in a way the record no longer describes.
// Each entry is `{ nodes, reason }`; `nodes` is the comma-joined sorted list.
const RENDERS_NOTHING = new Set([
  'link_reference_definition',
  'abbreviation_definition',
  'frontmatter',
  'comment_line',
  // `fenced_comment_block`, not `comment_block` - the latter is a name this
  // grammar has never produced, so the entry was dead and the check was blind
  // to comment fences. It only surfaced once a corpus document put one in a
  // single-paragraph file (189-a-definition-inside-a-comment-registers-nothing),
  // where a construct that renders NOTHING was reported as over-acceptance.
  'fenced_comment_block',
  'footnote_definition',
  'block_attribute',
]);

const overAcceptance = coverage.overAcceptance ?? {};

const singleParagraphFiles = coveredFiles.filter((file) => {
  const html = readFileSync(file.replace(/\.crv$/, '.html'), 'utf8').trim();
  return (
    /^<p[\s>]/.test(html) && /<\/p>$/.test(html) && html.split('<p').length === 2
  );
});

if (singleParagraphFiles.length) {
  const trees = spawnSync(
    'npx',
    ['tree-sitter', 'parse', ...singleParagraphFiles],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (trees.error) {
    console.error(`Failed to run tree-sitter parse: ${trees.error.message}`);
    process.exit(2);
  }

  // One `(document ...)` per input, in input order, each starting at column 0.
  const perFile = (trees.stdout || '').split(/^(?=\(document )/m).filter((t) => t.trim());
  if (perFile.length !== singleParagraphFiles.length) {
    console.error(
      `Expected ${singleParagraphFiles.length} parse trees, got ${perFile.length}; ` +
        'the tree-sitter output format changed and this check cannot be trusted.',
    );
    process.exit(2);
  }

  const found = {};
  perFile.forEach((tree, i) => {
    const stem = slugOf(path.basename(singleParagraphFiles[i], '.crv'));
    const blocks = tree
      .split('\n')
      .filter((l) => /^ {2}\(/.test(l))
      .map((l) => l.trim().match(/^\(([a-z_]+)/)?.[1])
      .filter(Boolean);
    const offending = [
      ...new Set(blocks.filter((n) => n !== 'paragraph' && !RENDERS_NOTHING.has(n))),
    ].sort();
    if (offending.length) found[stem] = offending.join(', ');
  });

  const newlyAccepting = Object.keys(found).filter((k) => !(k in overAcceptance));
  const nowFixed = Object.keys(overAcceptance).filter((k) => !(k in found));
  const changed = Object.keys(found)
    .filter((k) => k in overAcceptance && overAcceptance[k].nodes !== found[k])
    .map((k) => `${k}: recorded ${overAcceptance[k].nodes}, now ${found[k]}`);

  console.log(
    `corpus-conformance: checked ${singleParagraphFiles.length} single-paragraph ` +
      `document(s) for over-acceptance; ${Object.keys(found).length} found, ` +
      `${Object.keys(overAcceptance).length} recorded.`,
  );

  if (newlyAccepting.length || nowFixed.length || changed.length) {
    if (newlyAccepting.length) {
      console.error(
        '\nOver-acceptance (the language declines this, the grammar builds a block):',
      );
      for (const k of newlyAccepting) console.error(`  - ${k}: ${found[k]}`);
    }
    if (nowFixed.length) {
      console.error(
        '\nRecorded over-acceptance that no longer happens - remove these from ' +
          '`overAcceptance` in test/coverage.json:',
      );
      for (const k of nowFixed) console.error(`  - ${k}`);
    }
    if (changed.length) {
      console.error(
        '\nRecorded over-acceptance that now builds a DIFFERENT block - the ' +
          'grammar changed, so update `nodes` (and the reason) in ' +
          'test/coverage.json:',
      );
      for (const k of changed) console.error(`  - ${k}`);
    }
    process.exit(1);
  }
}

console.log('corpus-conformance: OK (no ERROR/MISSING in any covered category).');
