#!/usr/bin/env node
// A DOCUMENT WHOSE LAST LINE HAS NO TERMINATOR, READ THE WAY A CONSUMER READS IT.
//
// `scripts/final-terminator.mjs` asks the same question through the tree-sitter
// CLI, and the CLI cannot answer it. Measured on the same commit, the same 2134
// pinned documents and the same strip (one trailing newline removed), the pinned
// CLI 0.22.6 counted 27 documents whose tree carries an error and this binding
// counted 316. The gap is not the definition, it is the reader:
//
//   1. The CLI's core completes a construct that has to unwind containers at
//      the end of input; the core an editor links does not. Measured against
//      upstream cores compiled directly, `- a\n\n  ---` with no terminator is
//      clean under 0.22.6 and an ERROR under 0.25.1.
//   2. `_newline` is hidden, so a MISSING `_newline` never reaches the CLI's
//      error report. `*[HTML]: HyperText` with no terminator printed the same
//      tree and exit 0 before and after the grammar started accepting it.
//
// So this check reads through the Node binding, which is what carve-lsp and
// every npm consumer load. An editor links a core of its own rather than this
// binding, and upstream 0.25.1 compiled directly reads the class the same way,
// so the binding is the closest reader here to what a consumer has. It is also
// the only gate here that can see the class at all.
//
// The ledger is keyed on the corpus commit and the runtime version, because
// both of them move the reading. A key that no longer matches is refused rather
// than compared, so the recorded population can never describe a reading that
// has since changed. Refresh with UPDATE_LEDGER=1 and read the diff: an added
// document is a regression, a removed one is progress.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Parser from 'tree-sitter';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Carve = (await import(path.join(repoRoot, 'bindings/node/index.js'))).default;
const LEDGER = path.join(repoRoot, 'test/eof-without-newline-ledger.json');
const corpusDir = path.join(repoRoot, 'spec/tests/corpus');

const parser = new Parser();
parser.setLanguage(Carve);
const shape = (source) => parser.parse(source).rootNode.toString().replace(/\s+/g, ' ');

// One case per site that a document can legally end on. The terminated reading
// is the oracle: a site is right when removing the terminator changes nothing.
const INDEPENDENT = [
  ['div opener', '::: note'],
  ['div closer', '::: note\nx\n:::'],
  ['div closer in a quote', '> ::: note\n> x\n> :::'],
  ['code_block opener', '```'],
  ['code_block closer', '```\nx\n```'],
  ['code_block closer, tilde fence', '~~~\nx\n~~~'],
  ['raw_block opener', '```=html'],
  ['raw_block closer', '```=html\n<p>\n```'],
  ['fenced_comment_block opener', '%%% todo'],
  ['fenced_comment_block closer', '%%%\nx\n%%%'],
  ['comment_line', '%% n'],
  ['comment_line in a footnote body', '[^1]: %% n'],
  ['thematic_break', '---'],
  ['link_reference_definition', '[r]: /u'],
  ['citation_definition', '[@k]: An entry'],
  ['caption', '![i](x)\n^ cap'],
  ['block attribute line', '{.c}'],
  ['abbreviation_definition', '*[HTML]: HyperText'],
  ['abbreviation_definition after a paragraph', 'text\n\n*[HTML]: HyperText'],
  // Containers unwound at the end of input, the residual #458 named. Each one
  // stands for a container the last line has to leave, not for the construct
  // that happens to sit on it.
  ['thematic_break in a list item', '- a\n\n  ---'],
  ['div closer in a list item', '- ::: note\n  x\n  :::'],
  ['link_reference_definition in a list item', '- item\n\n  [r]: /u'],
  ['a quoted fence closer', '> ```\nx\n```'],
  ['link_reference_definition in a footnote body', '[^1]: t\n\n  [r]: /u'],
  ['thematic_break in a description body', ':: t\n: d\n\n  ---'],
  // An unterminated construct ending the document, rather than a container.
  ['a continuation row', '| a |\n+ b |'],
  ['an unclosed fence body', '```\nx'],
  ['an unclosed fence body in a div', '::: note\n```\nx'],
  ['an unclosed verbatim run on a lazy line', 'x\n```'],
];

// The residual of #458, and this check's positive control: the comparison above
// is worth nothing unless it can fail, and this proves it still can.
const RESIDUAL = [
  // A `+`-attached table whose LAST ROW ends at the input. One row degrades to a
  // paragraph without erroring; two rows leave the second `|` line read as a
  // line block and the item in ERROR. Unrelated to the columns above: the
  // attached run sits flush left, so nothing has to unwind.
  ['a plus-attached table of two rows', '- x\n+\n| a |\n| b |'],
  // A ROW THAT IS NOT READ AS A ROW. The same class seen without an ERROR: a
  // row line with no terminator falls back to a paragraph, so the document is
  // clean and the table is gone. The ledger counts errors and cannot see it.
  ['a table row', '| a |\n| b |'],
];

const broken = [];
for (const [site, input] of INDEPENDENT) {
  if (shape(`${input}\n`) !== shape(input)) broken.push(site);
}
const fixed = [];
for (const [site, input] of RESIDUAL) {
  if (shape(`${input}\n`) === shape(input)) fixed.push(site);
}

if (broken.length) {
  console.error('A terminator changed the tree at these sites:\n  ' + broken.join('\n  '));
  console.error('\nEach one is a line ending the grammar spells `_newline` where the'
    + ' document may simply end. `choice($._newline, $._eof_or_newline)` is the fix.');
  process.exit(1);
}
if (fixed.length) {
  console.error('These #458 residual shapes no longer need their terminator:\n  '
    + fixed.join('\n  '));
  console.error('\nThat is progress. Move each one into INDEPENDENT so it stays fixed.');
  process.exit(1);
}

const corpus = spawnSync('git', ['-C', path.join(repoRoot, 'spec'), 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
});
if (corpus.status !== 0) {
  console.error('Cannot read the corpus commit; the ledger key would be a guess.');
  process.exit(2);
}
const key = {
  corpus: corpus.stdout.trim(),
  runtime: require('tree-sitter/package.json').version,
};

const files = readdirSync(corpusDir).filter((file) => file.endsWith('.crv')).sort();
assert.ok(files.length > 2000, `only ${files.length} corpus document(s); run git submodule update --init`);

const withTerminator = [];
const residual = [];
for (const file of files) {
  const raw = readFileSync(path.join(corpusDir, file), 'utf8');
  const terminated = raw.endsWith('\n') ? raw : `${raw}\n`;
  // A document that already fails WITH its terminator is the no-ERROR sweep's,
  // not this one.
  if (parser.parse(terminated).rootNode.hasError) {
    withTerminator.push(file);
    continue;
  }
  if (parser.parse(terminated.replace(/\n$/, '')).rootNode.hasError) residual.push(file);
}

console.log(`eof-without-newline: ${files.length - withTerminator.length} document(s) parse`
  + ` cleanly with a final terminator; ${residual.length} do not without one.`);

if (process.env.UPDATE_LEDGER === '1') {
  writeFileSync(LEDGER, `${JSON.stringify({ ...key, documents: residual }, null, 2)}\n`);
  console.log(`  (wrote ${residual.length} entries for corpus ${key.corpus.slice(0, 10)},`
    + ` runtime ${key.runtime})`);
  process.exit(0);
}

const recorded = JSON.parse(readFileSync(LEDGER, 'utf8'));
if (recorded.corpus !== key.corpus || recorded.runtime !== key.runtime) {
  console.error('The ledger was measured against a different reading:');
  console.error(`  recorded: corpus ${recorded.corpus}, tree-sitter ${recorded.runtime}`);
  console.error(`  present:  corpus ${key.corpus}, tree-sitter ${key.runtime}`);
  console.error('\nBoth move which documents fail, so the population cannot be compared'
    + ' across them. Re-measure with UPDATE_LEDGER=1 and review the diff (#458).');
  process.exit(1);
}

const recordedSet = new Set(recorded.documents);
const residualSet = new Set(residual);
const added = residual.filter((file) => !recordedSet.has(file));
const gone = recorded.documents.filter((file) => !residualSet.has(file));
if (added.length || gone.length) {
  if (added.length) {
    console.error(`${added.length} document(s) started failing without their final`
      + ` terminator:\n  ${added.join('\n  ')}`);
    console.error('\nEach one is a line ending a block stopped accepting at the end of input.');
  }
  if (gone.length) {
    console.error(`${gone.length} document(s) no longer fail:\n  ${gone.join('\n  ')}`);
    console.error('\nThat is progress. Refresh with UPDATE_LEDGER=1 so the ledger keeps'
      + ' naming the ones that remain.');
  }
  process.exit(1);
}
console.log(`eof-without-newline: OK (${residual.length} recorded residual, none added).`);
