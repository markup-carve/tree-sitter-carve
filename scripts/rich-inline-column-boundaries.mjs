import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { carveToHtml } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
const cases = [];
for (const host of ['- ', '> ']) for (const tail of ['{.c}', ' ']) {
  cases.push(`${host}| /*a |${tail}\n${host === '- ' ? '  ' : '> '}| /b/ |\n`);
}
for (const rich of ['[x]', '{x}', '`x`', '\\x', '[ž]', '`x\ny`', '{x\ny}']) {
  cases.push(`/*a ${rich} /*b z\n\n# Next\n`);
}
cases.push('/*a %% comment\n# Next\n', '> /*a b\\\n> next\n', '- /*a b\\\n  next\n');
const types = { p: ['paragraph'], table: ['table'], tr: ['table_row'],
  blockquote: ['block_quote'], ul: ['list'], em: ['emphasis', 'bold_italic'],
  strong: ['strong', 'bold_italic'], code: ['verbatim'], h1: ['heading'] };
function snapshot(tree) {
  const nodes = [];
  const visit = node => {
    nodes.push([node.type, node.startIndex, node.endIndex]);
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return JSON.stringify(nodes);
}
function point(source, index) {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1).length };
}
function edit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) ++start;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { --oldEnd; --newEnd; }
  const old = parser.parse(before);
  old.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
    startPosition: point(before, start), oldEndPosition: point(before, oldEnd), newEndPosition: point(after, newEnd) });
  assert.equal(snapshot(parser.parse(after, old)), snapshot(parser.parse(after)), JSON.stringify(after));
}
let controls = 0, edits = 0;
for (const body of cases) for (const ending of ['\n', '\r\n', '\r']) {
  const source = body.replaceAll('\n', ending);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, JSON.stringify(source));
  const html = carveToHtml(source);
  for (const [tag, kinds] of Object.entries(types)) {
    // Tight lists omit paragraph tags while retaining paragraph CST nodes.
    if (tag === 'p' && tree.rootNode.descendantsOfType('list').length) continue;
    const wanted = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = kinds.reduce((sum, kind) => sum + tree.rootNode.descendantsOfType(kind).length, 0);
    assert.equal(actual, wanted, `${JSON.stringify(source)}: ${tag}`);
  }
  const plain = source.replace('/*a', 'a');
  edit(plain, source);
  edit(source, plain);
  const wrapped = source.replace('`x`', '`x' + ending + 'y`');
  if (wrapped !== source) { edit(source, wrapped); edit(wrapped, source); edits += 2; }
  ++controls;
  edits += 2;
}
console.log(`Rich inline columns: ${controls} engine controls and ${edits} incremental edits pass.`);
