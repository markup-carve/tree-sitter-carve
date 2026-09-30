import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { parse } from '@markup-carve/carve';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const parser = new Parser();
parser.setLanguage(require('../bindings/node'));
const directory = new URL('../spec/tests/corpus/', import.meta.url);
const files = readdirSync(directory).filter(name => /^\d+-a-marker-line-opaque-quote-keeps-overindented-markers-literal(?:-\d+)?\.crv$/.test(name));
assert.equal(files.length, 36);
const compared = new Set(['code_block', 'raw_block', 'paragraph', 'block_quote', 'heading', 'table']);
function astSummary(node, depth = 0, result = []) {
  if (compared.has(node.type)) result.push([node.type, node.pos.startLine - 1, depth]);
  for (const child of [...(node.children ?? []), ...(node.items ?? [])]) {
    astSummary(child, depth + (node.type === 'block_quote' ? 1 : 0), result);
  }
  return result;
}
function cstSummary(node, depth = 0, result = [], source = null) {
  const row = source === null ? node.startPosition.row : source.slice(0, node.startIndex).split(/\r\n|\r|\n/).length - 1;
  if (compared.has(node.type)) result.push([node.type, row, depth]);
  for (const child of node.namedChildren) {
    cstSummary(child, depth + (node.type === 'block_quote' ? 1 : 0), result, source);
  }
  return result;
}
for (const file of files) {
  const source = readFileSync(new URL(file, directory), 'utf8');
  const reference = parser.parse(source).rootNode;
  assert.equal(reference.hasError, false, file);
  assert.deepEqual(cstSummary(reference), astSummary(parse(source, { sourcePositions: true })), `${file}: block ownership`);
  for (const newline of ['\r\n', '\r']) {
    const alternate = parser.parse(source.replace(/\r\n|\r|\n/g, newline)).rootNode;
    assert.equal(alternate.hasError, false, `${file}: ${JSON.stringify(newline)}`);
    assert.equal(alternate.toString(), reference.toString(), `${file}: line-ending tree shape`);
    for (const type of ['code_block', 'raw_block', 'paragraph', 'block_quote_marker']) {
      assert.deepEqual(alternate.descendantsOfType(type).map(node => node.text.replace(/\r\n|\r/g, '\n')),
        reference.descendantsOfType(type).map(node => node.text), `${file}: ${type} extent`);
    }
  }
}
console.log('Opaque quote bands: 36 fixtures preserve tree shape and source extent across LF, CRLF, and CR.');

const tableControls = ['> | a |\n> | b\n', '> | a |\n> + b\n', '> | a |\n> ||\n', '> | a |\n> | |\n', '> | a |\n> | a |{bad!}\n', '> > | a |\n> # H\n> > + b |\ntail\n', '> | a |\n> | b |\n', '> | a |\n> y\n'];
for (const [index, source] of tableControls.entries()) {
  for (const newline of ['\n', '\r\n', '\r']) {
    const tree = parser.parse(source.replace(/\r\n|\r|\n/g, newline)).rootNode;
    assert.equal(tree.hasError, false, `table control ${index}`);
    assert.equal(tree.descendantsOfType('table').length, 1, `table control ${index}`);
    assert.equal(tree.descendantsOfType('table_row').length, index === 6 ? 2 : 1, `table control ${index}`);
    if (index < 5 || index === 7) assert.equal(tree.descendantsOfType('paragraph').length, 1, `table control ${index}`);
    if (index === 5) {
      assert.equal(tree.descendantsOfType('block_quote').length, 3);
      assert.equal(tree.descendantsOfType('heading').length, 1);
    }
  }
}
console.log('Quoted table boundaries: eight controls across LF, CRLF, and CR.');

for (const following of ['***', '| a |', '`c`']) {
  const source = '- > ```\n  > x\n  > ```\n  > ' + following + '\n    > y\n';
  for (const newline of ['\n', '\r\n', '\r']) {
    const variant = source.replace(/\n/g, newline);
    const tree = parser.parse(variant).rootNode;
    assert.equal(tree.hasError, false, following);
    assert.deepEqual(cstSummary(tree, 0, [], variant), astSummary(parse(source, { sourcePositions: true })), `${following}: ownership after opaque fence`);
  }
}

for (const following of ['y', '`c`', '[t](/u)']) {
  const source = '- > ```\n  > x\n  > ```\n  > ' + following + '\n    > y\n';
  const oracle = parse(source, { sourcePositions: true });
  const textValues = [];
  function collectText(node) {
    if (node.type === 'text') textValues.push(node.value);
    for (const child of [...(node.children ?? []), ...(node.items ?? [])]) collectText(child);
  }
  collectText(oracle);
  assert.ok(textValues.includes('> y'), `${following}: engine keeps the overindented marker literal`);
  for (const newline of ['\n', '\r\n', '\r']) {
    const variant = source.replace(/\n/g, newline);
    const tree = parser.parse(variant).rootNode;
    const literalMarker = variant.indexOf('    > y') + 4;
    assert.equal(tree.hasError, false, following);
    assert.deepEqual(cstSummary(tree, 0, [], variant), astSummary(oracle));
    assert.equal(tree.descendantsOfType('block_quote_marker').some(node =>
      node.startIndex <= literalMarker && node.endIndex > literalMarker), false, `${following}: literal marker ownership`);
    assert.ok(tree.descendantsOfType('paragraph').some(node => node.text.includes('> y')), `${following}: literal paragraph content`);
  }
}
