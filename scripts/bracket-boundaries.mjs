import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const parser = new Parser();
parser.setLanguage(require('../bindings/node'));
const directory = new URL('../spec/tests/corpus/', import.meta.url);
const family = 'a-braced-span-cannot-close-beyond-its-bracket-run';
const types = { strong: 'strong', em: 'emphasis', u: 'underline', s: 'strikethrough',
  mark: 'highlighted', ins: 'insert', del: 'delete', sup: 'superscript', sub: 'subscript' };
const files = readdirSync(directory).filter(f => f.includes(family) && f.endsWith('.crv')).sort();
assert.equal(files.length, 13, 'Review new boundary fixtures before changing this population.');
const measured = {};
for (const file of files) {
  const source = readFileSync(new URL(file, directory), 'utf8');
  const html = readFileSync(new URL(file.replace(/\.crv$/, '.html'), directory), 'utf8');
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, file);
  const differences = [];
  for (const [tag, type] of Object.entries(types)) {
    const expected = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = tree.rootNode.descendantsOfType(type).length +
      (['ins', 'del'].includes(tag) ? tree.rootNode.descendantsOfType('substitution').length : 0);
    if (actual !== expected) differences.push(`${tag} html=${expected} tree=${actual}`);
  }
  // These controls check content extent as well as the gap ledger's counts.
  for (const [tag, type] of [['sup', 'superscript'], ['sub', 'subscript']]) {
    const expected = [...html.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, 'g'))].map(m => m[1]);
    if (expected.length) assert.deepEqual(tree.rootNode.descendantsOfType(type)
      .map(n => n.namedChildren.find(c => c.type === 'content')?.text), expected, `${file}: ${tag} extent`);
  }
  const comments = [...html.matchAll(/<span class="critic-comment">(.*?)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(tree.rootNode.descendantsOfType('editorial_comment')
    .map(n => n.namedChildren.find(c => c.type === 'content')?.text), comments, `${file}: editorial comment extent`);
  if (differences.length) measured[file.replace(/^\d+-/, '').replace(/\.crv$/, '')] = differences.join(', ');
}
const recorded = JSON.parse(readFileSync(new URL('../test/bracket-boundaries.json', import.meta.url), 'utf8'));
assert.deepEqual(measured, recorded, 'Bracket-boundary debt changed; fix new gaps or retire resolved entries.');
console.log(`Bracket boundaries: ${files.length} fixtures, ${Object.keys(measured).length} recorded gaps; superscript and subscript included.`);
