import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const language = require('../bindings/node');
const parser = new Parser();
parser.setLanguage(language);
const query = name => new Parser.Query(language,
  readFileSync(new URL(`../queries/${name}.scm`, import.meta.url), 'utf8')
    .replace(/\(#offset![^)]*\)/g, ''));
const fold = query('folds'), objects = query('textobjects'), context = query('context');

function has(query, source, name, type, text) {
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, source);
  const captures = query.captures(tree.rootNode);
  assert.ok(captures.some(c => c.name === name && c.node.type === type && c.node.text === text),
    `${name}/${type}: missing range ${JSON.stringify(text)}`);
}

for (const [source, type] of [
  ['> quote\n> more\n', 'block_quote'],
  [':: term\n: body\n', 'definition_list'],
  ['| a | b |\n| c | d |\n', 'table'],
  ['[^n]: note\n  more\n', 'footnote'],
  ['---\na: b\n---\n', 'frontmatter'],
  ['%%%\nhidden\n%%%\n', 'fenced_comment_block'],
]) has(fold, source, 'fold', type, source);

has(objects, ':: term\n: body\n', 'block.inner', 'term', 'term\n');
has(objects, ':: term\n: body\n', 'block.inner', 'definition', 'body\n');
has(objects, ':: term\n: body\n', 'function.outer', 'definition_list', ':: term\n: body\n');
for (const text of [':: term\n', ': body\n']) {
  has(objects, ':: term\n: body\n', 'function.inner', 'list_item', text);
  has(objects, ':: term\n: body\n', 'block.outer', 'list_item', text);
}
has(objects, ':abbr[word]\n', 'attribute.inner', 'content', 'word');
has(objects, ':abbr[word]\n', 'attribute.outer', 'extension_inline', ':abbr[word]');
for (const [source, type, body] of [
  ['{% hidden %}\n', 'braced_comment', ' hidden '],
  ['{# hidden #}\n', 'editorial_comment', ' hidden '],
  ['%%%\nhidden\n%%%\n', 'fenced_comment_block', 'hidden\n'],
]) {
  has(objects, source, 'comment.outer', type, type === 'fenced_comment_block' ? source : source.trimEnd());
  has(objects, source, 'comment.inner', 'content', body);
}
for (const [source, type] of [
  ['::: note\nbody\n:::\n', 'div'],
  ['> quote\n', 'block_quote'],
]) has(context, source, 'context', type, source);
console.log('Editor query captures cover folds, definition bodies, comments, extensions and context.');
