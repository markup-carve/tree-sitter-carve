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
const tags = query('tags');

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
has(fold, '{table}\n```csv\na,b\n```\n', 'fold', 'table', '```csv\na,b\n```\n');

has(objects, ':: term\n: body\n', 'block.inner', 'term', 'term\n');
has(objects, ':: term\n: body\n', 'block.inner', 'definition', 'body\n');
has(objects, ':: term\n: body\n', 'function.outer', 'definition_list', ':: term\n: body\n');
for (const text of [':: term\n', ': body\n']) {
  has(objects, ':: term\n: body\n', 'function.inner', 'list_item', text);
  has(objects, ':: term\n: body\n', 'block.outer', 'list_item', text);
}
has(objects, ':abbr[word]\n', 'attribute.inner', 'content', 'word');
has(objects, ':abbr[word]\n', 'attribute.outer', 'extension_inline', ':abbr[word]');
const csvTable = '{table}\n```csv\na,b\n```\n';
has(objects, csvTable, 'function.inner', 'code', 'a,b\n');
const tableCaptures = objects.captures(parser.parse(csvTable).rootNode);
assert.equal(tableCaptures.filter(c => c.name === 'function.inner').length, 1,
  'a delimited table has exactly one inner textobject');
const captionedCsv = '{table}\n```csv\na,b\n```\n^ Caption\n';
const captionedCaptures = objects.captures(parser.parse(captionedCsv).rootNode);
assert.equal(captionedCaptures.filter(c => c.name === 'function.inner').length, 1,
  'a delimited table caption does not add a second inner textobject');
const pipeTable = '| a | b |\n|---|---|\n| 1 | 2 |\n^ Caption\n';
has(objects, pipeTable, 'function.inner', 'table_row', '| 1 | 2 |\n');
has(objects, pipeTable, 'function.inner', 'table_caption', '^ Caption\n');
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
function tag(source, kind, type, name) {
  const tree = parser.parse(source);
  assert.equal(tree.rootNode.hasError, false, source);
  const found = tags.matches(tree.rootNode).some(m =>
    m.captures.some(c => c.name === kind && c.node.type === type)
    && m.captures.some(c => c.name === 'name' && c.node.text === name));
  assert.ok(found, `${kind}/${type}: missing name ${JSON.stringify(name)}`);
}
tag('= Title\n', 'definition.section', 'heading', 'Title\n');
tag('# Hash title', 'definition.section', 'heading', 'Hash title');
tag('{#sec}\n= Title\n', 'definition.field', 'block_attribute', '#sec');
tag('A [word]{#w} here.\n', 'definition.field', 'inline_attribute', '#w');
tag('[ref]: https://a.b\n', 'definition.constant', 'link_reference_definition', 'ref');
tag('[^f]: note\n', 'definition.constant', 'footnote', 'f');
tag('A [text][ref].\n', 'reference.class', 'full_reference_link', 'ref');
tag('A ![alt][img].\n', 'reference.class', 'full_reference_image', 'img');
tag('A note[^f].\n', 'reference.class', 'footnote_reference', 'f');
console.log('Editor query captures cover folds, definition bodies, comments, extensions, context and tags.');
