import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { carveToHtml } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
const tails = [' Bare title', ' "Unclosed', ' [Unclosed', ' "Valid" [broken',
  '\t"Tabbed"', ' “Curly”', '{.inline}', '[label]', ' %% comment',
  ' "Valid" %% comment', ' [label] %% comment', ' {% c %}', '\u2028x', '\u2029x',
  '\u0085"Title"', '\u00a0"Title"'];
let controls = 0;
for (const kind of ['note', 'widget', 'figure', '123']) for (const tail of tails) {
  for (const marker of ['', '- ', '- [x] ', '1. ']) for (const ending of ['\n', '\r\n', '\r']) {
    const indent = marker === '1. ' ? '   ' : marker ? '  ' : '';
    const source = `${marker}::: ${kind}${tail}${ending}${indent}# Heading${ending}${indent}:::${ending}`;
    const root = parser.parse(source).rootNode;
    const html = carveToHtml(source);
    // The pinned engine rejects list markers whose payload contains LS/PS.
    // Native recovery still follows the logical CR/LF row boundary.
    if (!marker || !/[\u2028\u2029]/.test(tail)) assert.ok(/<(?:aside|div)\b/.test(html), JSON.stringify(source));
    assert.equal(root.hasError, false, JSON.stringify(source));
    const types = root.descendantsOfType('admonition_type');
    assert.equal(types.length, 1, JSON.stringify(source));
    assert.equal(types[0].text, kind, JSON.stringify(source));
    const containers = root.descendantsOfType('div');
    assert.equal(containers.length, 1, JSON.stringify(source));
    const metadata = containers[0].childForFieldName('invalid_metadata');
    assert.ok(metadata, JSON.stringify(source));
    assert.equal(metadata.text, tail, JSON.stringify(source));
    assert.equal(metadata.namedChildCount, 0, JSON.stringify(source));
    assert.equal(root.descendantsOfType('heading').length, 1, JSON.stringify(source));
    ++controls;
  }
}
for (const tail of [' "Title"', ' [label]', ' "Title" [label]', '   ']) {
  const root = parser.parse(`::: note${tail}\nBody\n:::\n`).rootNode;
  assert.equal(root.hasError, false, tail);
  const container = root.descendantsOfType('div')[0];
  assert.ok(container, tail);
  assert.equal(container.childForFieldName('invalid_metadata'), null, tail);
}
for (const kind of ['note!', 'note=', 'note}', 'noteé']) {
  const root = parser.parse(`::: ${kind}\nBody\n:::\n`).rootNode;
  assert.equal(root.hasError, false, kind);
  assert.equal(root.descendantsOfType('admonition_type').length, 0, kind);
}
console.log(`Named metadata: ${controls} recovery controls, valid slots and kind boundaries pass.`);
