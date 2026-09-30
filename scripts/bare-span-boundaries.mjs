import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { carveToHtml } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
const cases = [
  ['*a *b*', 'strong', '<strong>a *b</strong>'],
  ['/a /b/', 'emphasis', '<em>a /b</em>'],
  ['_a _b_', 'underline', '<u>a _b</u>'],
  ['~a ~b~', 'strikethrough', '<s>a ~b</s>'],
  ['=a =b=', 'highlighted', '<mark>a =b</mark>'],
  ['*a *b *c*', 'strong', '<strong>a *b *c</strong>'],
  ['/a /b /c/', 'emphasis', '<em>a /b /c</em>'],
  ['/a /b /*c d/', 'emphasis', '<em>a /b /*c d</em>'],
];
for (const [body, type, html] of cases) for (const ending of ['\n', '\r\n', '\r']) {
  const source = body + ending;
  assert.equal(carveToHtml(source), `<p>${html}</p>`, source);
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, source);
  const nodes = root.descendantsOfType(type);
  assert.equal(nodes.length, 1, source);
  assert.equal(nodes[0].startIndex, 0, source);
  assert.equal(nodes[0].endIndex, body.length, source);
  assert.equal(nodes[0].text, body, source);
}
const tails = [
  ['/[a](/u "t', 'v")/', null, '/[a](/u “t', 'v”)/'],
  ['/[a](u/ "t', 'v")/', 7, '<em>[a](u</em> “t', 'v”)/'],
  ['/[a](x "/u', 'v")/', null, '/[a](x “/u', 'v”)/'],
  ['/[a](x "u/', 'v")/', 10, '<em>[a](x “u</em>', 'v”)/'],
];
for (const [first, last, end, firstHtml, lastHtml] of tails) for (const ending of ['\n', '\r\n', '\r']) {
  const source = first + ending + ending + last + ending;
  assert.equal(carveToHtml(source), `<p>${firstHtml}</p>\n<p>${lastHtml}</p>`, source);
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, source);
  assert.equal(root.descendantsOfType('paragraph').length, 2, source);
  assert.equal(root.descendantsOfType('inline_link').length, 0, source);
  const spans = root.descendantsOfType('emphasis');
  assert.equal(spans.length, end === null ? 0 : 1, source);
  if (end !== null) {
    assert.equal(spans[0].startIndex, 0, source);
    assert.equal(spans[0].endIndex, end, source);
  }
}
const before = '/a /b/\n', after = '/a /b /*c d/\n';
const old = parser.parse(before);
old.edit({ startIndex: 5, oldEndIndex: 5, newEndIndex: 11,
  startPosition: { row: 0, column: 5 }, oldEndPosition: { row: 0, column: 5 }, newEndPosition: { row: 0, column: 11 } });
assert.equal(parser.parse(after, old).rootNode.toString(), parser.parse(after).rootNode.toString());
const changed = parser.parse(after);
changed.edit({ startIndex: 5, oldEndIndex: 11, newEndIndex: 5,
  startPosition: { row: 0, column: 5 }, oldEndPosition: { row: 0, column: 11 }, newEndPosition: { row: 0, column: 5 } });
assert.equal(parser.parse(before, changed).rootNode.toString(), parser.parse(before).rootNode.toString());
console.log('Bare spans: 36 engine range controls and two incremental edits pass.');
