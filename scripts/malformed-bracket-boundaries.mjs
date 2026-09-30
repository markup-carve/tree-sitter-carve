import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { carveToHtml } from '@markup-carve/carve';
import { createRequire } from 'node:module';
const parser = new Parser();
parser.setLanguage(createRequire(import.meta.url)('../bindings/node'));
const cases = [
  ['x [[a. [[b, [[c; [[d?', {}],
  ['x [[a.\n\nnext', { paragraph: 2 }],
  ['x [[a.\n \t\nnext', { paragraph: 2 }],
  ['# x [[a.\nb', { heading: 1, paragraph: 1 }],
  ['## x [[a,\nb\nc', { heading: 1, paragraph: 1 }],
  ['- x [[a.\n- b', { list: 1, list_item: 2 }],
  ['1. x [[a.\n2. b', { list: 1, list_item: 2 }],
  ['x [[a.\n# heading', { heading: 1, paragraph: 1 }],
  ['x [[a. ...', { ellipsis: 1 }],
  ['x [[a. --', { en_dash: 1 }],
  ['x [[a. ---', { em_dash: 1 }],
  ['x [[a.\nb]]', {}],
  ['> x [[a.\n>\n> next', { block_quote: 1, paragraph: 2 }],
  ['- x [[a.\n\n  more', { list: 1, list_item: 1, paragraph: 2 }],
  ['x [[a.\nnext', { paragraph: 1 }],
  ['x [[a. b]] c', { paragraph: 1 }],
  ['é x [[a. ž', { paragraph: 1 }],
  ['x [ \t[a. b', { paragraph: 1 }],
  ['x [[a. *b* ]]', { strong: 1 }],
  ['x [[a, /b/ ]]', { emphasis: 1 }],
  ['x [[a. `b`', { verbatim: 1 }],
  ['x [[a. <https://a.b/>', { autolink: 1 }],
  ['x [[a. ](u)', { inline_link: 1 }],
  ['[b]: /u\n\nx [[a. ][b]', { full_reference_link: 1 }],
  ['[b]: /u\n\nx [[b.][]', { collapsed_reference_link: 1 }],
  ['x [[a. ]{.c}', { span: 1 }],
  ['| x [[a. |\n| b |', { table: 1, table_row: 2 }],
];
for (const ending of ['\n', '\r\n', '\r']) {
  for (const [template, counts] of cases) {
    const source = template.replace(/\n/g, ending) + ending;
    const tree = parser.parse(source);
    assert.equal(tree.rootNode.hasError, false, source);
    for (const [type, count] of Object.entries(counts)) {
      assert.equal(tree.rootNode.descendantsOfType(type).length, count, source);
    }
    if (template === 'x [[a. b]] c') assert.equal(tree.rootNode.namedChildren[0].namedChildCount, 0);
    const html = carveToHtml(source);
    for (const [type, tag] of [['strong', 'strong'], ['emphasis', 'em'], ['inline_link', 'a'], ['full_reference_link', 'a'], ['span', 'span']]) {
      if (!(type in counts)) continue;
      assert.equal([...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length, counts[type], source);
    }
  }
}
for (const fragment of ['[[a. ', '[[a,b ', '[[a; ', '[[a? ']) {
  const before = 'x ' + fragment.repeat(64) + 'z\n';
  const after = before.slice(0, -1) + ']'.repeat(128) + '\n';
  const old = parser.parse(before);
  old.edit({ startIndex: before.length - 1, oldEndIndex: before.length - 1, newEndIndex: after.length - 1,
    startPosition: { row: 0, column: before.length - 1 }, oldEndPosition: { row: 0, column: before.length - 1 }, newEndPosition: { row: 0, column: after.length - 1 } });
  assert.equal(parser.parse(after, old).rootNode.toString(), parser.parse(after).rootNode.toString());
  const closed = parser.parse(after);
  closed.edit({ startIndex: before.length - 1, oldEndIndex: after.length - 1, newEndIndex: before.length - 1,
    startPosition: { row: 0, column: before.length - 1 }, oldEndPosition: { row: 0, column: after.length - 1 }, newEndPosition: { row: 0, column: before.length - 1 } });
  assert.equal(parser.parse(before, closed).rootNode.toString(), parser.parse(before).rootNode.toString());
}
for (const ending of ['\n', '\r\n', '\r']) {
  const before = `x [[a.${ending}${ending}next${ending}`;
  const index = before.indexOf(ending) + ending.length;
  const after = before.slice(0, index) + 'b' + before.slice(index);
  const old = parser.parse(before);
  old.edit({ startIndex: index, oldEndIndex: index, newEndIndex: index + 1,
    startPosition: { row: ending === '\r' ? 0 : 1, column: ending === '\r' ? index : 0 }, oldEndPosition: { row: ending === '\r' ? 0 : 1, column: ending === '\r' ? index : 0 }, newEndPosition: { row: ending === '\r' ? 0 : 1, column: ending === '\r' ? index + 1 : 1 } });
  const incremental = parser.parse(after, old);
  assert.equal(incremental.rootNode.hasError, false);
  assert.equal(incremental.rootNode.toString(), parser.parse(after).rootNode.toString());
  const joined = parser.parse(after);
  joined.edit({ startIndex: index, oldEndIndex: index + 1, newEndIndex: index,
    startPosition: { row: ending === '\r' ? 0 : 1, column: ending === '\r' ? index : 0 }, oldEndPosition: { row: ending === '\r' ? 0 : 1, column: ending === '\r' ? index + 1 : 1 }, newEndPosition: { row: ending === '\r' ? 0 : 1, column: ending === '\r' ? index : 0 } });
  assert.equal(parser.parse(before, joined).rootNode.toString(), parser.parse(before).rootNode.toString());
}
for (const source of ['# x [[a.', 'x [[a.']) {
  assert.equal(parser.parse(source).rootNode.hasError, false, source);
}
const beforeShift = 'x [[a.\n';
const afterShift = 'xy [[a.\n';
const shifted = parser.parse(beforeShift);
shifted.edit({ startIndex: 1, oldEndIndex: 1, newEndIndex: 2,
  startPosition: { row: 0, column: 1 }, oldEndPosition: { row: 0, column: 1 }, newEndPosition: { row: 0, column: 2 } });
assert.equal(parser.parse(afterShift, shifted).rootNode.toString(), parser.parse(afterShift).rootNode.toString());
const restored = parser.parse(afterShift);
restored.edit({ startIndex: 1, oldEndIndex: 2, newEndIndex: 1,
  startPosition: { row: 0, column: 1 }, oldEndPosition: { row: 0, column: 2 }, newEndPosition: { row: 0, column: 1 } });
assert.equal(parser.parse(beforeShift, restored).rootNode.toString(), parser.parse(beforeShift).rootNode.toString());
console.log('Malformed brackets: 27 boundary controls across LF/CRLF/CR and 16 incremental edits.');
