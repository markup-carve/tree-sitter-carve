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
// depend on the compiled native node binding being loadable in CI. Covered
// files are parsed in `--quiet` batches (see scripts/parse-batched.mjs): in
// quiet mode the CLI prints exactly one line per file whose tree has an error
// (ERROR or MISSING) and stays silent for clean files, so any output line is a
// conformance failure.

import { readFileSync, readdirSync } from 'node:fs';
import { refuseShortRun } from './participants.mjs';
import { parseQuiet, parseTrees } from './parse-batched.mjs';
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

// The wiring guard scripts/line-terminators.mjs describes as "the same guard the
// other sweeps carry" - which they did not. Without it an empty corpus reaches
// the CLI with zero paths, and the run dies on `Must provide one or more paths`
// while reporting that the parse invocation failed. That is a true statement
// about the wrong thing: the invocation is fine, the population is missing
// (markup-carve/carve#755).
refuseShortRun({
  label: 'CORPUS',
  actual: allFiles.length,
  atLeast: 1000,
  of: `document(s) under ${corpusDir}`,
  hint: 'the spec corpus has ~1240; run `git submodule update --init`.',
});

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
const failures = parseQuiet(coveredFiles, repoRoot);

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
  // Same reading as above: output lines name files with an error. parseQuiet
  // exits hard on an invocation failure, so an empty return here is a clean
  // parse rather than a run that never happened.
  const errored = parseQuiet(skippedFiles, repoRoot);
  if (errored.length === 0) {
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
  // `footnote`, not `footnote_definition` - the same dead-name defect as
  // `comment_block` right above. This grammar's rule is named `footnote`, so
  // the allowlist entry matched nothing and the check was blind to a footnote
  // definition, which surfaced the moment a corpus document put an UNREFERENCED
  // one in a single-paragraph file
  // (314-a-footnote-in-an-unresolved-reference-is-not-a-reference): the
  // definition is never called on, so it renders nothing, and it was reported
  // as over-acceptance.
  'footnote',
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
  // One `(document ...)` per input, in input order, each starting at column 0.
  const perFile = parseTrees(singleParagraphFiles, repoRoot);

  // THE LINE IS RECORDED TOO, because the reason is free text and nothing
  // checked it. Four of the five entries here blamed a cause that had since been
  // fixed: they said the OPENER over-accepts (`::: {.sidebar}` taking an
  // attribute block for a type word), and every one of those opener lines parses
  // as a paragraph today. What remains is the TRAILING `:::`, three lines lower,
  // read as a fresh bare-div opener - a different defect with a different fix,
  // recorded under a reason that sent a reader to the wrong line
  // (markup-carve/carve#770).
  //
  // A start line cannot capture intent, but it does pin WHICH construct the
  // entry is about, so a record whose cause moves fails instead of quietly
  // describing the wrong one.
  const found = {};
  perFile.forEach((tree, i) => {
    const stem = slugOf(path.basename(singleParagraphFiles[i], '.crv'));
    const blocks = tree
      .split('\n')
      .filter((l) => /^ {2}\(/.test(l))
      .map((l) => {
        const match = l.trim().match(/^\(([a-z_]+) \[(\d+),/);
        return match ? { node: match[1], line: Number(match[2]) + 1 } : null;
      })
      .filter(Boolean);
    const offending = blocks.filter(
      (b) => b.node !== 'paragraph' && !RENDERS_NOTHING.has(b.node),
    );
    if (offending.length) {
      found[stem] = {
        nodes: [...new Set(offending.map((b) => b.node))].sort().join(', '),
        lines: [...new Set(offending.map((b) => b.line))].sort((a, b) => a - b).join(', '),
      };
    }
  });

  const newlyAccepting = Object.keys(found).filter((k) => !(k in overAcceptance));
  const nowFixed = Object.keys(overAcceptance).filter((k) => !(k in found));
  const changed = Object.keys(found)
    .filter(
      (k) =>
        k in overAcceptance &&
        (overAcceptance[k].nodes !== found[k].nodes ||
          String(overAcceptance[k].lines) !== found[k].lines),
    )
    .map(
      (k) =>
        `${k}: recorded ${overAcceptance[k].nodes} at line ${overAcceptance[k].lines}, ` +
        `now ${found[k].nodes} at line ${found[k].lines}`,
    );

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
      for (const k of newlyAccepting) {
        console.error(`  - ${k}: ${found[k].nodes} at line ${found[k].lines}`);
      }
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
          'grammar changed, so update `nodes`, `lines` and the reason in ' +
          'test/coverage.json:',
      );
      for (const k of changed) console.error(`  - ${k}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// INVISIBLE OVER-ACCEPTANCE: a RENDERS_NOTHING node whose own source text is
// still visible in the rendered fixture.
//
// The scan above only ever looks at a document whose ENTIRE fixture is a
// single `<p>`, so it is structurally blind to a RENDERS_NOTHING node built
// inside a container (a block quote, a list item, a div): the fixture there
// is never a single paragraph, so the file is never even examined. It is also
// blind BY DESIGN to a node the RENDERS_NOTHING allowlist itself names, on the
// reasoning that a node producing no output cannot corrupt a render - true at
// document level, and exactly wrong wherever the construct is not actually
// recognized as a definition and its source line survives as ordinary,
// visible text instead (tree-sitter-carve#60: `*[HTML]: Hyper Text` inside a
// block quote or a list item still built an `abbreviation_definition`, and
// neither hole above could see it).
//
// This asks the more direct question, of EVERY covered file: does a
// RENDERS_NOTHING node's own source text still show up as visible content in
// the fixture? If it does, the node was wrong to swallow it - "renders
// nothing" and "the line disappeared from the render" are the same claim, and
// this checks the claim instead of assuming it from the node's name.
//
// `footnote` is excluded from this set even though the allowlist above calls
// it RENDERS_NOTHING: a footnote definition IS hoisted and re-rendered, in its
// own footnotes section, holding the SAME body text - its text is SUPPOSED to
// reappear there, and flagging that would fail every correctly conforming
// footnote in the corpus. (Spelled `footnote_definition` here too until the
// allowlist above was corrected; against the real node name the exclusion had
// nothing to exclude.)
const INVISIBLE_ANYWHERE = new Set(
  [...RENDERS_NOTHING].filter((type) => type !== 'footnote'),
);

// Turns a fixture's HTML into the text a reader actually sees: strip every
// tag, decode the handful of named entities the corpus fixtures use, and
// collapse whitespace so a source line that the renderer wrapped or
// re-indented still compares equal.
function visibleTextOf(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpan(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// Slices `[startRow,startCol]` .. `[endRow,endCol]`, exactly as `tree-sitter
// parse` prints a node's range, out of the ORIGINAL source lines (already
// split on `\n`, so a line holds no trailing newline of its own). Columns are
// byte offsets within the line, as tree-sitter reports them; every corpus
// fixture line this check inspects is ASCII, so a byte offset and a character
// offset coincide.
function sliceSpan(lines, startRow, startCol, endRow, endCol) {
  if (startRow === endRow) return lines[startRow].slice(startCol, endCol);
  const parts = [lines[startRow].slice(startCol)];
  for (let r = startRow + 1; r < endRow; r++) parts.push(lines[r]);
  parts.push(lines[endRow].slice(0, endCol));
  return parts.join('\n');
}

// A minimum span length guards against a coincidental substring match: a
// one- or two-character span (a bare `%%` empty comment, say) is meaningless
// to search for in prose, since it is likely to appear by chance and would
// turn this check into noise rather than a signal.
const MIN_SPAN_LENGTH = 3;

// Returns the full printed block for the node whose header starts at
// `startIndex` (the index of its opening `(`) - not just the header line, but
// every nested child down to the matching closing paren. Safe to bracket-match
// on raw `(`/`)` count because plain (non `-x`) `tree-sitter parse` output
// never prints a node's own source text, only type names, field labels and
// positions - every paren in the string is a structural s-expression
// delimiter, never data that could itself contain an unbalanced paren (an
// unquoted link destination such as `/a(b)c` prints as `(link_destination
// [0, 5] - [0, 11])`, not as the literal text).
function extractBlock(text, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(startIndex, i + 1);
    }
  }
  return text.slice(startIndex);
}

// A `link_reference_definition` with NO `destination` field is a documented
// exception, not a bug: `[r]:` and `[r]:   ` are corpus-pinned (16-reference-link-8,
// 16-reference-link-9, see the note at `link_reference_definition` in
// grammar.js) to stay "definition-shaped" for parsing purposes while still
// rendering their literal source text - a destination-less reference is never
// usable, so unlike a complete definition it was never meant to disappear.
// Flagging it here would fail two corpus fixtures for behavior the grammar
// gets right on purpose.
function isExemptOccurrence(type, block) {
  if (type === 'link_reference_definition' && !block.includes('destination:')) {
    return true;
  }
  return false;
}

const invisibleOverAcceptance = coverage.invisibleOverAcceptance ?? {};

// The full (non `--quiet`) parse has to run over every COVERED file, not only
// the single-paragraph subset above - that subset is exactly the scope this
// check exists to get past.
const fullPerFile = parseTrees(coveredFiles, repoRoot);

const spanLineRe = /\(([a-z_]+) \[(\d+), (\d+)\] - \[(\d+), (\d+)\]/g;

const invisibleFound = {};
coveredFiles.forEach((file, i) => {
  const visible = visibleTextOf(readFileSync(file.replace(/\.crv$/, '.html'), 'utf8'));
  const sourceLines = readFileSync(file, 'utf8').split('\n');
  const stem = slugOf(path.basename(file, '.crv'));
  const offenders = new Set();
  for (const m of fullPerFile[i].matchAll(spanLineRe)) {
    const [, type, sr, sc, er, ec] = m;
    if (!INVISIBLE_ANYWHERE.has(type)) continue;
    if (isExemptOccurrence(type, extractBlock(fullPerFile[i], m.index))) continue;
    const span = normalizeSpan(
      sliceSpan(sourceLines, Number(sr), Number(sc), Number(er), Number(ec)),
    );
    if (span.length >= MIN_SPAN_LENGTH && visible.includes(span)) {
      offenders.add(`${type}: ${span}`);
    }
  }
  if (offenders.size) invisibleFound[stem] = [...offenders].sort().join('; ');
});

const invisibleNew = Object.keys(invisibleFound).filter((k) => !(k in invisibleOverAcceptance));
const invisibleFixed = Object.keys(invisibleOverAcceptance).filter(
  (k) => !(k in invisibleFound),
);
const invisibleChanged = Object.keys(invisibleFound)
  .filter((k) => k in invisibleOverAcceptance && invisibleOverAcceptance[k].nodes !== invisibleFound[k])
  .map((k) => `${k}: recorded ${invisibleOverAcceptance[k].nodes}, now ${invisibleFound[k]}`);

console.log(
  `corpus-conformance: checked ${coveredFiles.length} covered document(s) for ` +
    `invisible over-acceptance; ${Object.keys(invisibleFound).length} found, ` +
    `${Object.keys(invisibleOverAcceptance).length} recorded.`,
);

if (invisibleNew.length || invisibleFixed.length || invisibleChanged.length) {
  if (invisibleNew.length) {
    console.error(
      "\nInvisible over-acceptance (a RENDERS_NOTHING node's own text is still " +
        'visible in the fixture):',
    );
    for (const k of invisibleNew) console.error(`  - ${k}: ${invisibleFound[k]}`);
  }
  if (invisibleFixed.length) {
    console.error(
      '\nRecorded invisible over-acceptance that no longer happens - remove these ' +
        'from `invisibleOverAcceptance` in test/coverage.json:',
    );
    for (const k of invisibleFixed) console.error(`  - ${k}`);
  }
  if (invisibleChanged.length) {
    console.error(
      '\nRecorded invisible over-acceptance that now shows a DIFFERENT node - the ' +
        'grammar changed, so update `nodes` (and the reason) in test/coverage.json:',
    );
    for (const k of invisibleChanged) console.error(`  - ${k}`);
  }
  process.exit(1);
}

console.log('corpus-conformance: OK (no ERROR/MISSING in any covered category).');
