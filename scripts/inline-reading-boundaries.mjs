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
