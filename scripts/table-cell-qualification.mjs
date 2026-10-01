import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { carveToHtml } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
let controls = 0, edits = 0;
function check(source) {
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, source.slice(0, 100));
  const html = carveToHtml(source);
  const tags = pattern => [...html.matchAll(pattern)].length;
  assert.equal(root.descendantsOfType('table_cell').length, tags(/<t[dh](?:>|\s)/g), source);
  assert.equal(root.descendantsOfType('span').length + root.descendantsOfType('editorial_comment').length,
    tags(/<span(?:>|\s)/g), source);
  ++controls;
}
for (const n of [255, 256, 257, 512]) for (const ending of ['\n', '\r\n', '\r', '']) {
  const row = '|' + '[x]{.k}|'.repeat(n);
  check(row + ending);
  check(row + (ending || '\n') + '|' + '-|'.repeat(n) + ending);
}
for (const body of [
  '| a | [x]{title="a}b"} | [s]{.k} |',
  "| a | [x]{title='a}b'} | [s]{.k} |",
  '| [x]{title="{%"} | [s]{.k} |',
  '| (x){.k} | [s]{.k} |',
  '| <https://example.org/x> | [s]{.k} |',
  '| ^[x] | [s]{.k} |',
  '| {% x %} [s]{.k} | [t]{.k} |',
  '| {# x #} [s]{.k} | [t]{.k} |',
  '| x [s]{.k} | [t]{.k} |',
  '| *x [s]{.k}* | [t]{.k} |',
  '| [s `x|y`]{.k} | [t]{.k} |',
  '| [s x\\|y]{.k} | [t]{.k} |',
  '> | [s]{.k} | [t]{.k} |',
  '- | [s]{.k} | [t]{.k} |',
  '| [ž😀]{title="(x)"} | [t]{.k} |',
]) for (const ending of ['\n', '\r\n', '\r', '']) check(body + ending);

for (const [body, cells, spans] of [
  ["| <https://e.org/a|b> [s]{.k} | [t]{.k} |", 2, 2],
  ["| [l](u|v) [s]{.k} | [t]{.k} |", 2, 2],
  ["| {% a|b %} [s]{.k} | [t]{.k} |", 2, 2],
  ["| {# a|b #} [s]{.k} | [t]{.k} |", 2, 3],
  ["| ^[a|b] [s]{.k} | [t]{.k} |", 2, 2],
  ["| [a]{.k} | {% a|b %} [s]{.k} | [t]{.k} |", 3, 3],
  ["| [a]{.k} | (x|y){.k} [s]{.k} | [t]{.k} |", 4, 3],
  ["| [a][b|c] [s]{.k} | [t]{.k} |", 2, 2],
  ["| $x|y$ [s]{.k} | t |", 3, 1],
  ["| :a|b: [s]{.k} | t |", 3, 1],
  ["| *a | b* [s]{.k} | t |", 3, 1],
  ["| [a | b]{.k} | t |", 3, 0],
  ["| *a |\n> b\n- c", 1, 0],
  ["| [a |\n  b", 1, 0],
  [": term\n  | [a]{.k} | [b]{.k} |\n  folded", 0, 2],
]) for (const ending of ['\n', '\r\n', '\r', '']) {
  const root = parser.parse(body + ending).rootNode;
  assert.equal(root.hasError, false, body);
  assert.equal(root.descendantsOfType('table_cell').length, cells, body);
  assert.equal(root.descendantsOfType('span').length + root.descendantsOfType('editorial_comment').length, spans, body);
  ++controls;
}

function point(source, index) {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1).length };
}
for (const gap of ['DROP\nHIDDEN`|', 'DROP\r\nHIDDEN`|', 'DROP\rHIDDEN`|']) {
  const head = '| [s ', tail = 'c]{.k} |\n', source = head + gap + tail;
  const includedRanges = [[0, head.length], [head.length + gap.length, source.length]].map(([startIndex, endIndex]) => ({
    startIndex, endIndex, startPosition: point(source, startIndex), endPosition: point(source, endIndex),
  }));
  const root = parser.parse(source, null, { includedRanges }).rootNode;
  assert.equal(root.hasError, false, source);
  assert.equal(root.descendantsOfType('table_cell').length, 1);
  assert.equal(root.descendantsOfType('span').length, 1);
  ++controls;
}
function snapshot(tree) {
  const entries = [];
  function visit(node) {
    entries.push([node.type, node.startIndex, node.endIndex, node.startPosition, node.endPosition]);
    for (const child of node.children) visit(child);
  }
  visit(tree.rootNode);
  return JSON.stringify(entries);
}
function incremental(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) ++start;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { --oldEnd; --newEnd; }
  const old = parser.parse(before);
  old.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
    startPosition: point(before, start), oldEndPosition: point(before, oldEnd), newEndPosition: point(after, newEnd) });
  assert.equal(snapshot(parser.parse(after, old)), snapshot(parser.parse(after)), after);
  ++edits;
}
for (const ending of ['\n', '\r\n', '\r', '']) for (const firstCell of [
  '[s `a|b`]{.k}', '[s a\\|b]{.k}', '{% x %} [s]{.k}', '(s){.k}',
  '^[s]', '[s]{title="(x)"}', '[ž😀]{.k}',
  '<https://e.org/a|b> [s]{.k}', '[l](u|v) [s]{.k}',
  '{% a|b %} [s]{.k}', '{# a|b #} [s]{.k}', '^[a|b] [s]{.k}',
  '[a][b|c] [s]{.k}', '*a | b* [s]{.k}', '[a | b]{.k}',
]) {
  const before = '| [s]{.k} | [t]{.k} |' + ending;
  const after = '| ' + firstCell + ' | [t]{.k} |' + ending;
  incremental(before, after); incremental(after, before);
}
console.log(`Table-cell qualification: ${controls} engine and range controls and ${edits} incremental edits pass.`);
