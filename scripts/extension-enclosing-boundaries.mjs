import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { parse } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
parser.setTimeoutMicros(2_000_000);
let comparisons = 0, edits = 0;
function nodes(value, kind, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.type === kind) out.push(value);
  for (const [key, child] of Object.entries(value)) if (key !== 'pos') nodes(child, kind, out);
  return out;
}
function check(source) {
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, JSON.stringify(source));
  const ast = parse(source);
  const offsets = [0];
  for (const character of source) offsets.push(offsets.at(-1) + character.length);
  const attributes = root.descendantsOfType('inline_attribute');
  for (const [native, engine] of [['extension_inline', 'inline_extension'], ['strong', 'strong'],
    ['emphasis', 'emphasis'], ['underline', 'underline'], ['strikethrough', 'strike'],
    ['highlighted', 'highlight'], ['superscript', 'superscript'], ['subscript', 'subscript'],
    ['insert', 'insert'], ['delete', 'delete'], ['verbatim', 'code']]) {
    const wanted = nodes(ast, engine).map(n => [offsets[n.pos.startOffset], offsets[n.pos.endOffset]]);
    const actual = root.descendantsOfType(native).map(n => [n.startIndex,
      attributes.find(a => a.startIndex === n.endIndex)?.endIndex ?? n.endIndex]);
    assert.deepEqual(actual, wanted, `${JSON.stringify(source)}: ${native} extents\n${root}`);
  }
  for (const kind of ['paragraph', 'list_item', 'block_quote', 'heading'])
    assert.equal(root.descendantsOfType(kind).length, nodes(ast, kind).length,
      `${JSON.stringify(source)}: ${kind} count\n${root}`);
  ++comparisons;
}
function point(source, index) {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1).length };
}
function snapshot(tree) {
  const out = [];
  (function walk(n) { out.push([n.type, n.startIndex, n.endIndex, n.isMissing]); n.children.forEach(walk); })(tree.rootNode);
  return out;
}
function edit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) ++start;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { --oldEnd; --newEnd; }
  const tree = parser.parse(before);
  tree.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
    startPosition: point(before, start), oldEndPosition: point(before, oldEnd), newEndPosition: point(after, newEnd) });
  assert.deepEqual(snapshot(parser.parse(after, tree)), snapshot(parser.parse(after)), JSON.stringify({before, after}));
  ++edits;
}
const pairs = [
  ['- :x[a\n- b]\n', '- :x[a\n  b]\n'],
  ['* :x[a\n* b]\n', '* :x[a\n  b]\n'],
  ['1. :x[a\n2. b]\n', '1. :x[a\n   b]\n'],
  ['- :x[a\n1. b]\n', '- :x[a\n  1. b]\n'],
  ['- :x[a\n- \nb]\n', '- :x[a\n- b]\n'],
  ['> :x[a\n>\n> b]\n', '> :x[a\n> b]\n'],
  ['> > :x[a\n> >\n> > b]\n', '> > :x[a\n> > b]\n'],
  ['> - :x[a\n> - b]\n', '> - :x[a\n>   b]\n'],
  ['- > :x[a\n  >\n  > b]\n', '- > :x[a\n  > b]\n'],
  ['[^n]: :x[a\nb]\n\nSee[^n].\n', '[^n]: :x[a\n  b]\n\nSee[^n].\n'],
  [':x[a\n# b]\n', ':x[a\n # b]\n'],
  [':x[a\n> b]\n', ':x[a\nb]\n'],
  [':x[a\n| b] |\n', ':x[a\n| b]\n'],
  [':x[a\n\nb]\n', ':x[a\nb]\n'],
  [':x[a\n- b]\n', ':x[a\nb]\n'],
  ['> :x[a\n  # b]\n', '> :x[a\n> # b]\n'],
  ['- :x[a\n  - b]\n', '- :x[a\n- b]\n'],
];
for (const marker of ['*', '/', '_', '~', '=', '^', ',', '+', '-']) {
  const wrap = body => `{${marker}a :x[${body}] b${marker}}\n`;
  pairs.push([wrap(`a {${marker}b c${marker}}`), wrap('a b')],
    [wrap(`a ${marker}}`), wrap(`a \\${marker}}`)],
    [wrap(`a \`b${marker}} c`), wrap(`a \`b${marker}} c\``)],
    [wrap(`${marker}}`), wrap('a')]);
  pairs.push([wrap(`a \`b\\${marker}} c\``), wrap(`a \\${marker}} b`)]);
  if (marker !== '+' && marker !== '-') pairs.push(
    [wrap(`a \`b\\${marker}} c`), wrap(`a \`b\\${marker}} c\``)],
    [wrap(`a \`b\n\\${marker}} c`), wrap(`a \`b\n\\${marker}} c\``)]);
  if (marker !== '/') pairs.push([wrap('a {/b ' + marker + '} c/}'), wrap('a b')]);
}
for (const [first, second] of pairs) for (const ending of ['\n', '\r\n', '\r']) {
  const before = first.replaceAll('\n', ending), after = second.replaceAll('\n', ending);
  check(before); check(after); edit(before, after); edit(after, before);
  await new Promise(setImmediate);
}
for (const n of [16, 64, 256]) for (const fragment of [':x[a `b*} c` d] ', ':x[a \\*} b] ']) {
  const before = `{*a ${fragment.repeat(n)}z*}\n`;
  const after = before.replace('z*}', 'zz*}');
  check(before); check(after); edit(before, after); edit(after, before);
  await new Promise(setImmediate);
}
console.log(`Extension scopes: ${comparisons} engine comparisons and ${edits} incremental edits pass.`);
