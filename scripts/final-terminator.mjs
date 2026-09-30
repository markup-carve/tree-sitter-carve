#!/usr/bin/env node
// A DOCUMENT WHOSE LAST LINE CARRIES NO TERMINATOR PARSES TO THE SAME TREE.
//
// `newline = '\n' | '\r\n' | '\r'` terminates a line, and a document's last line
// may simply end at the input. Every block rule that spells a line ending has to
// accept that, or the construct on the last line cannot complete: the grammar
// carries `_eof_or_newline` next to `_newline` for exactly this, and thirteen
// line endings were spelled `_newline` alone. The shapes below are one per site.
//
// Nineteen of the twenty fail without the terminator on the commit before the
// fix; `fenced_comment_block closer` is the one site that already spelled
// `_eof_or_newline`, and its case is here to keep it that way.
//
// WHY NO OTHER CHECK SEES THIS. `scripts/no-error-sweep.mjs` writes every
// document it generates as `` `${lines.join('\n')}\n` ``, and every corpus file
// on disk ends with a terminator, so the whole family sits outside both. The
// terminator sweep next door re-spells the terminators a document HAS; this one
// is about the one it does not have. Measured over the pinned corpus when this
// landed, 2134 documents parsed with 8 ERROR trees as committed and 235 with the
// final terminator stripped (#458).
//
// THOSE NUMBERS ARE THIS CLI'S READING, NOT THE CLASS. Through the Node binding
// the same commit and the same strip count 316 rather than 27, because the CLI's
// core completes a construct that unwinds containers at the end of input and its
// error report cannot see a MISSING hidden token. `scripts/eof-without-newline.mjs`
// asks the question through the binding for that reason; keep both.
//
// WHY SHAPES AND NOT JUST "NO ERROR". A construct can complete without an ERROR
// node and still complete WRONGLY - the marker line read as a paragraph, the
// body swallowed. Comparing the terminated reading against the unterminated one
// asks whether the terminator is structural, which is the actual claim.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARSE_TIMEOUT_US, TIMEOUT_ARGS, spawnBudgetMs } from './parse-limits.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One case per grammar site that spells a line ending on a line which can be the
// document's last. `site` names it so a failure points at the rule to look at.
const CASES = [
  { site: 'div opener', input: '::: note' },
  { site: 'div closer', input: '::: note\nx\n:::' },
  { site: 'div closer in a list item', input: '- ::: note\n  x\n  :::' },
  { site: 'code_block opener', input: '```' },
  { site: 'code_block closer', input: '```\nx\n```' },
  { site: 'code_block closer, tilde fence', input: '~~~\nx\n~~~' },
  { site: 'raw_block opener', input: '```=html' },
  { site: 'raw_block closer', input: '```=html\n<p>\n```' },
  { site: 'fenced_comment_block opener', input: '%%% todo' },
  { site: 'fenced_comment_block closer', input: '%%%\nx\n%%%' },
  { site: 'comment_line in a list item', input: '- a\n\n  %% n' },
  { site: 'comment_line in a footnote body', input: '[^1]: %% n' },
  { site: 'thematic_break in a list item, dashes', input: '- a\n\n  ---' },
  { site: 'thematic_break in a list item, stars', input: '- a\n\n  ***' },
  { site: 'thematic_break in a list item, underscores', input: '- a\n\n  ___' },
  { site: 'link_reference_definition in a list item', input: '- item\n\n  [r]: /u' },
  { site: 'link_reference_definition in a description body', input: '- item\n\n  :: c\n    [r]: /u' },
  { site: 'citation_definition in a list item', input: '- a\n\n  [@k]: An entry' },
  { site: 'caption in a list item', input: '- a\n\n  ^ cap' },
  { site: 'block attribute line in a list item', input: '- a\n\n  {.c}' },
];

const localCli = path.join(repoRoot, 'node_modules', '.bin', 'tree-sitter');
const [cli, cliArgs] = existsSync(localCli)
  ? [localCli, []]
  : ['npx', ['tree-sitter']];

const work = mkdtempSync(path.join(tmpdir(), 'final-terminator-'));
const cleanup = () => rmSync(work, { recursive: true, force: true });

let seq = 0;
function parse(source) {
  const file = path.join(work, `s${seq++}.crv`);
  writeFileSync(file, source);
  const run = spawnSync(cli, [...cliArgs, 'parse', ...TIMEOUT_ARGS, file], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: spawnBudgetMs(1),
  });
  if (run.error) {
    console.error(`Failed to run tree-sitter parse: ${run.error.message}`);
    cleanup();
    process.exit(2);
  }
  // An abandoned parse prints nothing, which would compare equal to another
  // empty reading and pass.
  if (!(run.stdout || '').trim()) {
    console.error(
      `FINAL TERMINATOR: ${JSON.stringify(source)} produced no tree within ` +
        `${PARSE_TIMEOUT_US / 1_000_000}s. An input that cannot be parsed is ` +
        'not an input that agrees.',
    );
    if (run.stderr) console.error(run.stderr.toString().trim());
    cleanup();
    process.exit(2);
  }
  return run.stdout;
}

// Node types only: the two readings end on different rows by construction, and
// the per-file summary tree-sitter appends carries a path and a duration. That
// an ERROR was there at all survives, because the node type does.
const shape = (tree) =>
  tree
    .replace(/\s*\[\d+, \d+\] - \[\d+, \d+\]/g, '')
    .replace(/\S*\.crv\s+[\d.]+ ms\s+[\d.]+ bytes\/ms/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const failures = [];
for (const { site, input } of CASES) {
  const terminated = shape(parse(`${input}\n`));
  const bare = shape(parse(input));
  if (/ERROR|MISSING/.test(terminated)) {
    failures.push(
      `${site}: the TERMINATED reading already carries an ERROR, so this case ` +
        `measures nothing about the terminator.\n    ${terminated}`,
    );
    continue;
  }
  if (terminated !== bare) {
    failures.push(
      `${site}: ${JSON.stringify(input)}\n` +
        `    with a terminator: ${terminated}\n` +
        `    without one:       ${bare}`,
    );
  }
}

// THE CHECK HAS TO BE ABLE TO FIRE. Every assertion above is an equality, and an
// equality over a comparison that silently stopped working passes every time. Two
// controls, because there are two ways for it to stop working.
//
// One: `shape` could erase everything it is handed. Two trees that must not
// compare equal prove it still carries the tree.
if (shape(parse('x\n')) === shape(parse('# x\n'))) {
  console.error(
    'FINAL TERMINATOR: a paragraph and a heading reduce to the same shape. ' +
      'Either the parse output format moved or `shape` now erases the tree; ' +
      'the equalities above cannot be trusted.',
  );
  cleanup();
  process.exit(2);
}

// Two: the two arms could be the same input. Every case above is parsed twice,
// and nothing else here would notice if both reads were terminated.
for (const { site, input } of CASES) {
  if (input.endsWith('\n') || !`${input}\n`.endsWith('\n')) {
    console.error(
      `FINAL TERMINATOR: the two arms of "${site}" are not a terminated and an ` +
        'unterminated reading of one document.',
    );
    cleanup();
    process.exit(2);
  }
}

cleanup();

if (failures.length) {
  console.error(
    `final-terminator: ${failures.length} of ${CASES.length} shape(s) parse ` +
      'differently with and without a final terminator:\n',
  );
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `final-terminator: ${CASES.length} shape(s) parse to the same tree with and ` +
    'without a final line terminator.',
);
