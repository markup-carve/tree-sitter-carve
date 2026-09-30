import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const parser = new Parser();
parser.setLanguage(require('../bindings/node'));
const directory = new URL('../spec/tests/corpus/', import.meta.url);
const files = readdirSync(directory).filter(name => name.startsWith('535-') && name.endsWith('.crv'));
assert.equal(files.length, 36);
for (const file of files) {
  const source = readFileSync(new URL(file, directory), 'utf8');
  const reference = parser.parse(source).rootNode;
  assert.equal(reference.hasError, false, file);
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
