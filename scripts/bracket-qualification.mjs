import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { carveToHtml } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
const cases = [
  '[s `a]b`]{.k}',
  '| {% a`b %} [x|y]{.k} |', '| {# a`b #} [x|y]{.k} |',
  '| [a]{title="`"} [x|y]{.k} |', '| [x](/a`b) [c | d]{.k} |',
  '| a \\` [b | c]{.k} |', '| \\` [x]{title="a|b"} |',
  '| {% ` %} x |\n+ [b | c]{.k} |',

  '| [a _b [c | d] e_]{.k} | f |',
  '| [x]{title="a|b"} |',
  '[s [t](/a`b) c]{.k}',
  '[s [b]{title="a`b"} c]{.k}',
  '[s `a[b]c`]{.k}', '[s ``a]b``]{.k}', '[s ```a]b```]{.k}',
  '[s ````a]b````]{.k}', '[s `a]b]{.k}',
  '[s `a\\]b`]{.k}', '[s a\\]b]{.k}', '[s \\`a]{.k}',
  '[a [s `a]b`]{.i} c]{.k}', '[a [b]{.i} c]{.k}',
  '[s {% a`b %} c]{.k}', '[s {# a`b #} c]{.k}',
  '[s {% a]b %} c]{.k}', '[s {# a]b #} c]{.k}',
  '[s {% a\n]b %} c]{.k}', '[s {# a\n]b #} c]{.k}',
  '[s {% a c]{.k}', '[s {# a c]{.k}',
  '[s {% a` c]{.k}', '[s {# a` c]{.k}',
  '[s {% a\nc]{.k}', '[s {# a\nc]{.k}',
  '[s {% a\n\n]b %} c]{.k}',
  '[s [t](/a`b`) c]{.k}', '[s [b]{title="a`b`"} c]{.k}',
  '/*x [s `a]b`]{.k} y*/', '*x [s `a]b`]{.k} y*', '{/x [s `a]b`]{.k} y/}',
  '> [s `a]b`]{.k}', '- [s `a]b`]{.k}',
  '| [s `a]b`]{.k} |', '| [s `a|b`]{.k} |',
  '| a | [s a\\|b]{.k} |', '| a | [s `a|b`]{.k} |',
  '| [s a\\|b]{.k} |', '| [x]{title="a\\|b"} |',
  "| [x]{title='a|b'} |", '| [x]{title="a`|`b"} |',
  '| [s {% a`b %} c]{.k} |', '| [s {# a`b #} c]{.k} |',
  '| [s {% a`b %} c|d]{.k} |',
  '| [a _b |\n+ c_]{.k} |', '| [a `b |\n+ c`]{.k} |',
  '| [a _b |\n|+ c_]{.k} |',
  '> | [s `a|b`]{.k} |', '> | [a `b |\n> + c`]{.k} |',
  '[ž {% α\nβ]{.k}', '[ž {# α\nβ]{.k}',
  '*a [x b*', '/a [x b/', '*a [x {% b %} c [d {% e f*',
  '| [a \\`b | c]{.k} |', '| [x]{title="a\\\\|b"} |',
  '   *a [x \\\r y\nz*', '😀 *a [x \\\r y\nz*',
];
const kinds = { p: ['paragraph'], span: ['span', 'editorial_comment'],
  code: ['verbatim'], a: ['inline_link'], strong: ['strong', 'bold_italic'],
  em: ['emphasis', 'bold_italic'], u: ['underline'], table: ['table'],
  tr: ['table_row'], td: ['table_cell'], blockquote: ['block_quote'], ul: ['list'] };
function snapshot(tree) {
  const entries = [];
  const visit = node => {
    entries.push([node.type, node.startIndex, node.endIndex, node.startPosition, node.endPosition]);
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return JSON.stringify(entries);
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
for (const body of cases) for (const ending of ['\n', '\r\n', '\r']) for (const terminated of [true, false]) {
  const source = body.replaceAll('\n', ending) + (terminated ? ending : '');
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, JSON.stringify(source));
  const html = carveToHtml(source);
  for (const [tag, types] of Object.entries(kinds)) {
    if (tag === 'p' && root.descendantsOfType('list').length) continue;
    const expected = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = types.reduce((count, type) => count + root.descendantsOfType(type).length, 0);
    assert.equal(actual, expected, `${JSON.stringify(source)}: ${tag}`);
  }
  if (body === cases[0]) {
    const span = root.descendantsOfType('span')[0];
    assert.equal(span.text, body);
    assert.equal(span.childForFieldName('attribute').text, '{.k}');
    assert.equal(span.descendantsOfType('verbatim')[0].childForFieldName('content').text, 'a]b');
  }
  const changes = [source.replace('{.k}', '{.q}'), source.replace('{.k}', '')];
  const tick = source.lastIndexOf('`');
  if (tick >= 0) changes.push(source.slice(0, tick) + source.slice(tick + 1));
  for (const change of new Set(changes)) if (change !== source) {
    edit(source, change); edit(change, source); edits += 2;
  }
  ++controls;
}
for (const [head, tail] of [['[s {% a ', 'c]{.k}'], ['[s {% a\n', 'c]{.k}'],
  ['[s {% a ', 'b %} c]{.k}']]) for (const ending of ['\n', '\r\n', '\r'])
  for (const terminated of [true, false]) {
    const first = head.replaceAll('\n', ending), last = tail + (terminated ? ending : '');
    function parseParts(gap, previous) {
      const source = 'XX' + first + gap + last;
      const starts = [2, 2 + first.length + gap.length], ends = [2 + first.length, source.length];
      const includedRanges = starts.map((startIndex, i) => ({ startIndex, endIndex: ends[i],
        startPosition: point(source, startIndex), endPosition: point(source, ends[i]) }));
      return parser.parse(source, previous, { includedRanges });
    }
    const old = parseParts('DROP');
    const span = old.rootNode.descendantsOfType('span')[0];
    assert.equal(old.rootNode.hasError, false);
    assert.equal(old.rootNode.descendantsOfType('span').length, 1);
    assert.equal(span.startIndex, 2);
    assert.equal(span.endIndex, 2 + first.length + 4 + tail.length);
    assert.equal(span.childForFieldName('attribute').text, '{.k}');
    const html = carveToHtml(first + last);
    assert.equal([...html.matchAll(/<span(?:>|\s)/g)].length, 1);
    const before = 'XX' + first + 'DROP' + last, after = 'XX' + first + 'DROP_MORE' + last;
    const start = 2 + first.length, oldEnd = start + 4, newEnd = start + 9;
    old.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
      startPosition: point(before, start), oldEndPosition: point(before, oldEnd), newEndPosition: point(after, newEnd) });
    assert.equal(snapshot(parseParts('DROP_MORE', old)), snapshot(parseParts('DROP_MORE')));
    const reverse = parseParts('DROP_MORE');
    reverse.edit({ startIndex: start, oldEndIndex: newEnd, newEndIndex: oldEnd,
      startPosition: point(after, start), oldEndPosition: point(after, newEnd), newEndPosition: point(before, oldEnd) });
    assert.equal(snapshot(parseParts('DROP', reverse)), snapshot(parseParts('DROP')));
    ++controls; edits += 2;
  }
for (const head of ['| [s ', '| {% ` %} [s ']) for (const ending of ['\n', '\r\n', '\r']) {
  const tail = 'c]{.k} |' + ending;
  const excluded = 'DROP`|';
  const source = head + excluded + tail;
  const ranges = [[0, head.length], [head.length + excluded.length, source.length]].map(([startIndex, endIndex]) => ({
    startIndex, endIndex, startPosition: point(source, startIndex), endPosition: point(source, endIndex),
  }));
  const tree = parser.parse(source, null, { includedRanges: ranges });
  assert.equal(tree.rootNode.hasError, false, source);
  assert.equal(tree.rootNode.descendantsOfType('table_cell').length, 1, source);
  assert.equal(tree.rootNode.descendantsOfType('span').length, 1, source);
  assert.equal(tree.rootNode.descendantsOfType('span')[0].childForFieldName('attribute').text, '{.k}');
  ++controls;
}
// These existing raw-splitting differences must not shift qualification's boundary.
for (const body of ['| a\\\\| [s | t]{.k} |', '| a \\` | [s | t]{.k} ` |',
  '| a\\\\| [s `a|b`]{.k} |']) for (const ending of ['\n', '\r\n', '\r'])
  for (const terminated of [true, false]) {
    const source = body + (terminated ? ending : '');
    const root = parser.parse(source).rootNode;
    assert.equal(root.hasError, false, source);
    assert.equal(root.descendantsOfType('span').length,
      [...carveToHtml(source).matchAll(/<span(?:>|\s)/g)].length, source);
    ++controls;
  }
console.log(`Bracket qualification: ${controls} engine controls and ${edits} incremental edits pass.`);
