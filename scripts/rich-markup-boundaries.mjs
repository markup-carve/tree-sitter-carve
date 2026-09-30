import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { readFileSync } from 'node:fs';
import { endings, richMarkupInput } from './rich-markup-input.mjs';
import { carveToHtml } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
const families = JSON.parse(readFileSync(new URL('../tests/rich-markup-families.json', import.meta.url), 'utf8'));
const types = { p: ['paragraph'], span: ['span', 'editorial_comment'], em: ['emphasis', 'bold_italic'],
  strong: ['strong', 'bold_italic'], code: ['verbatim'], u: ['underline'],
  table: ['table'], tr: ['table_row'], td: ['table_cell'] };
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
for (const family of families) for (const ending of endings) {
  const source = richMarkupInput(family, 4, ending);
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, family.name + JSON.stringify(source));
  const html = carveToHtml(source);
  for (const [tag, kinds] of Object.entries(types)) {
    const wanted = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = kinds.reduce((sum, kind) => sum + tree.rootNode.descendantsOfType(kind).length, 0);
    assert.equal(actual, wanted, `${family.name}: ${tag}`);
  }
  const plain = source.replace('/*a', 'a');
  if (plain !== source) { edit(plain, source); edit(source, plain); edits += 2; }
  const shorter = richMarkupInput(family, 3, ending);
  edit(shorter, source); edit(source, shorter); edits += 2;
  const wrapped = source.replace('`y`', '`y' + ending + 'v`');
  if (wrapped !== source) { edit(source, wrapped); edit(wrapped, source); edits += 2; }
  ++controls;
}
for (const marker of ['_', '*', '/', '~', '=']) for (const ending of endings) {
  const first = `[${marker}]{.c}`;
  const source = first + marker + ']{.d}' + ending;
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, source);
  const spans = root.descendantsOfType('span');
  assert.equal(spans.length, 1, source);
  assert.equal(spans[0].text, first, source);
  assert.equal(spans[0].childForFieldName('content').text, marker, source);
  assert.equal(spans[0].childForFieldName('attribute').text, '{.c}', source);
  for (const kind of ['strong', 'emphasis', 'underline', 'strikethrough', 'highlighted']) {
    assert.equal(root.descendantsOfType(kind).length, 0, source);
  }
  assert.equal(carveToHtml(source), `<p><span class="c">${marker}</span>${marker}]{.d}</p>`);
  edit(first + ending, source); edit(source, first + ending);
  ++controls; edits += 2;
}
const qualified = ['[s *{x{y}}* z]{.k}', '[s /{x{y}}/ z]{.k}',
  '[s /a [x] b/ z]{.k}', '| [s /a [x] b/ z]{.k} |'];
for (const body of qualified) for (const ending of endings) {
  const source = body + ending;
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, source);
  const html = carveToHtml(source);
  for (const [tag, kinds] of Object.entries(types)) {
    if (tag === 'p' && body.startsWith('|')) continue;
    const wanted = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = kinds.reduce((sum, kind) => sum + root.descendantsOfType(kind).length, 0);
    assert.equal(actual, wanted, source);
  }
  const literal = source.replace('{x{y}}', '{x}');
  if (literal !== source) { edit(literal, source); edit(source, literal); edits += 2; }
  ++controls;
}
const cellBoundaries = [
  '| [s `a|b`]{.k} |', '| [s a\\|b]{.k} |',
  '| [a _b |\n+ c_]{.k} |',
  '[s {% a`b %} c]{.k}', '[s {# a`b #} c]{.k}',
  '[s {% a c]{.k}', '[s {# a c]{.k}',
  '| [_]{.c}_]{.d} |', '| [*]{.c}*]{.d} |', '| [/]{.c}/]{.d} |',
  '| [~]{.c}~]{.d} |', '| [=]{.c}=]{.d} |',
];
for (const body of cellBoundaries) for (const ending of endings) {
  const source = (body + '\n').replaceAll('\n', ending);
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, source);
  const html = carveToHtml(source);
  for (const [tag, kinds] of Object.entries(types)) {
    const wanted = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = kinds.reduce((sum, kind) => sum + root.descendantsOfType(kind).length, 0);
    assert.equal(actual, wanted, `${tag}: ${source}`);
  }
  const literal = source.replaceAll('_', '').replaceAll('`', '').replaceAll('%', '').replaceAll('#', '');
  edit(literal, source); edit(source, literal);
  ++controls; edits += 2;
}
console.log(`Rich markup boundaries: ${controls} engine controls and ${edits} incremental edits pass.`);
