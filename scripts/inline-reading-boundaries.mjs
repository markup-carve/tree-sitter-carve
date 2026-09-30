import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import { carveToHtml } from '@markup-carve/carve';

const require = createRequire(import.meta.url);
const parser = new Parser();
parser.setLanguage(require('../bindings/node'));
const cases = [
  '`c`{#a .k}{#b k=1}{.k k=2}\n',
  '*b*{.k}{???}\n',
  '*c*{.k}{*d*}\n',
  '[x]{.a}{#b}\n',
  '_*x* q\n',
  '_*x*_ q\n',
  '/_x_ q\n',
  '/*a<b*/ y\n',
  '/*a\t*/ y\n',
  '/**/\n',
  '/* */\n',
  '/***/\n',
  '/*a %% secret*/ b\n',
  '/*a ` */ ` b*/\n',
  '/*a [ */ ](/u) b*/\n',
  '/*a {% */ %} b*/\n',
  '/*[a] */ b/ c\n',
  '/*a {x} */ b/ c\n',
  '/*a \\a */ b/ c\n',
  '/*`x` */ b/ c\n',
  '/*a */ b*/\n',
  '/*a */y z/\n',
  '/*a *b* q\n',
  '*x /*a /* c\n',
  '*x /*a. /* c\n',
  'x /*a ...\n',
  '/*a ...\n',
  '*x /*a b /* c* d\n',
  '/*a #-b q\n',
  '/*a [/*b*/] q\n',
  '/*a [x]() /*b*/ c\n',
  '/*a [x](y z /*b*/ c\n',
  '/*a [x](y \"t\" z /*b*/ c\n',
  '/a /*x* y/ b/\n',
  '/*a b* d/ e\n',
  '*x /*a*/ b*\n',
  '*x /*a/ b*\n',
  '[/*a b]{.c} d/\n',
  'x [/*a]{.c} y/ z\n',
  '*x /*a b* d/ e\n',
  '> /*a/ b\n>\n> /*x*/\n',
  '::: note\n/*a/ b\n:::\n/*x*/\n',
  '/*a {/q/} q\n',
  '/*a b/ c\n',
  '/*[a] b/ c\n',
  '/*a\n*/ b\n',
  '> /*a\n> */ b\n',
  '#-a #_a @-a @_a\n',
  'a#-a a#_a a@-a a@_a\n',
  '![p](p.png)\n^ Figure #-a q\n',
];
const types = { strong: ['strong', 'bold_italic', 'tag', 'mention'],
  em: ['emphasis', 'bold_italic'], u: ['underline'] };
for (const source of cases) {
  const html = carveToHtml(source);
  const reference = parser.parse(source).rootNode;
  for (const newline of ['\n', '\r\n', '\r']) {
    const root = parser.parse(source.replace(/\n/g, newline)).rootNode;
    assert.equal(root.hasError, false, JSON.stringify(source));
    assert.equal(root.toString(), reference.toString(), 'Line endings preserve inline structure.');
    for (const [tag, nodes] of Object.entries(types)) {
      const wanted = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
      const actual = nodes.reduce((n, type) => n + root.descendantsOfType(type).length, 0);
      assert.equal(actual, wanted, `${JSON.stringify(source)}: ${tag}`);
    }
  }
}
const merged = parser.parse(cases[0]).rootNode.descendantsOfType('inline_attribute');
assert.equal(merged.length, 1);
assert.equal(merged[0].text, '{#a .k}{#b k=1}{.k k=2}');
assert.equal(merged[0].descendantsOfType('args').length, 3);
console.log(`Inline boundaries: ${cases.length} engine controls pass across LF, CRLF and CR.`);

for (const newline of ['\n', '\r\n', '\r', '']) {
  const oldSource = '/*a '.repeat(32) + 'z' + newline;
  const oldTree = parser.parse(oldSource);
  const at = oldSource.length - newline.length;
  oldTree.edit({ startIndex: at, oldEndIndex: at, newEndIndex: at + 2,
    startPosition: { row: 0, column: at }, oldEndPosition: { row: 0, column: at },
    newEndPosition: { row: 0, column: at + 2 } });
  const changed = oldSource.slice(0, at) + '*/' + newline;
  const incremental = parser.parse(changed, oldTree);
  const fresh = parser.parse(changed);
  assert.equal(incremental.rootNode.hasError, false);
  assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString(),
    'Adding a closer invalidates the cached negative lookahead.');
  assert.equal(fresh.rootNode.descendantsOfType('bold_italic').length, 1);
  incremental.edit({ startIndex: at, oldEndIndex: at + 2, newEndIndex: at,
    startPosition: { row: 0, column: at }, oldEndPosition: { row: 0, column: at + 2 },
    newEndPosition: { row: 0, column: at } });
  assert.equal(parser.parse(oldSource, incremental).rootNode.toString(),
    parser.parse(oldSource).rootNode.toString(), 'Removing the closer restores literal text.');
}

for (const source of ['x /*a ...\n', '/*a ...\n']) {
  assert.equal(parser.parse(source).rootNode.descendantsOfType('ellipsis').length, 1);
}

for (const newline of ['\n', '\r\n', '\r']) {
  const root = parser.parse('> /*a/ b\n>   \n> /*x*/\n'.replace(/\n/g, newline)).rootNode;
  assert.equal(root.hasError, false);
  assert.equal(root.descendantsOfType('emphasis').length, 1);
  assert.equal(root.descendantsOfType('bold_italic').length, 1);
}
console.log('Quoted whitespace-only lines keep the following paragraph outside combined lookahead.');
