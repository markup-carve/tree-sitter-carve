import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { parse } from '@markup-carve/carve';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const parser = new Parser();
parser.setLanguage(require('../bindings/node'));
const directory = new URL('../spec/tests/corpus/', import.meta.url);
const names = readdirSync(directory);
const examples = [
  "a-bare-colon-opener-in-a-description-body-is-an-opener-2",
  "a-closer-does-not-rescue-a-marker-line-colon-opener-whose-body-folded-in-7",
  "a-closer-does-not-rescue-a-marker-line-colon-opener-whose-body-folded-in-8",
  "a-form-feed-or-a-no-break-space-is-content-wherever-whitespace-is-tested-9",
  "generic-divs-4",
  "the-continuation-marker-attaches-one-block-in-every-container-4",
  "an-opener-at-or-past-a-description-body-s-column-closes-its-paragraph-5",
  "an-opener-at-or-past-a-description-body-s-column-closes-its-paragraph-6",
  "an-empty-unterminated-container-ends-at-a-flush-left-line-3",
  "a-blank-line-before-a-sibling-marker-separates-the-items-whatever-consumed-it",
  "a-column-0-line-after-a-container-s-last-block-when-that-block-left-no-paragraph-open-4",
  "a-continuation-marker-attaches-one-block-and-the-boundary-is-that-block-s-extent-9",
  "a-continuation-row-s-open-run-and-an-escaped-closing-pipe-2",
  "a-frontmatter-opener-takes-exactly-one-space",
  "a-tab-after-a-fence-or-a-frontmatter-opener-depends-on-where-it-sits-3",
  "a-task-item-s-checkbox-is-not-decided-by-its-first-block",
  "an-unterminated-container-does-not-extend-the-item-past-a-blank-line",
  "an-unterminated-container-does-not-extend-the-item-past-a-blank-line-2",
  "an-unterminated-container-does-not-extend-the-item-past-a-blank-line-3",
  "an-unterminated-container-does-not-extend-the-item-past-a-blank-line-4",
  "fence-opener-with-a-nested-list-body-inside-a-list-item",
  "fence-opener-with-a-nested-list-body-inside-a-list-item-2",
  "fence-opener-with-a-nested-list-body-inside-a-list-item-3",
  "fence-opener-with-a-nested-list-body-inside-a-list-item-4",
  "fence-opener-with-a-nested-list-body-inside-a-list-item-7",
  "fence-opener-with-a-nested-list-body-inside-a-list-item-5",
  "fence-opener-with-a-nested-list-body-inside-a-list-item-6",
  "list-lazy-continuation-8",
  "only-lazy-folding-demotes-a-marker-line-colon-opener",
  "paragraph-interruption-3",
  "paragraph-interruption-8",
  "table-as-a-block-opener-in-a-list-item",
  "table-row-closing-pipe-3",
  "thematic-break-requires-contiguous-markers",
  "a-comment-span-opened-below-every-content-column-is-located-there-8",
  "a-definition-body-s-open-code-fence-ends-at-a-line-below-its-column-3",
  "a-definition-body-s-open-code-fence-ends-at-a-line-below-its-column-5",
  "a-definition-body-s-open-code-fence-ends-at-a-line-below-its-column",
  "a-bare-colon-opener-in-a-description-body-is-an-opener-7",
  "a-fence-closer-below-a-nested-item-s-column-ends-containers-down-to-its-owner-12"
];
const kinds = new Set(['list', 'definition_list', 'div', 'block_quote', 'heading',
  'code_block', 'raw_block', 'table', 'thematic_break', 'comment']);
function canonical(node) {
  if (node.type === 'admonition' || node.type === 'directive') return 'div';
  if (node.type === 'fenced_comment_block') return 'comment';
  if (node.type === 'comment' && !node.block) return null;
  return kinds.has(node.type) ? node.type : null;
}
function summary(node, source, native = false, parents = [], result = []) {
  const type = canonical(node);
  if (type) {
    const row = native ? source.slice(0, node.startIndex).split(/\r\n|\r|\n/).length - 1
      : node.pos.startLine - 1;
    result.push([type, row, parents.join('/')]);
  }
  const children = native ? node.namedChildren : Object.values(node).flatMap(value =>
    Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []);
  for (const child of children) summary(child, source, native,
    type ? [...parents, type] : parents, result);
  return result;
}
function check(source, label) {
  const oracle = summary(parse(source, { sourcePositions: true }), source);
  const reference = parser.parse(source);
  assert.equal(reference.rootNode.hasError, false, label);
  assert.deepEqual(summary(reference.rootNode, source, true), oracle, label);
  for (const newline of ['\r\n', '\r']) {
    const variant = source.replace(/\r\n|\r|\n/g, newline);
    const alternate = parser.parse(variant);
    assert.equal(alternate.rootNode.hasError, false, label);
    assert.deepEqual(summary(alternate.rootNode, variant, true), oracle, label);
    assert.equal(alternate.rootNode.toString(), reference.rootNode.toString(), label);
  }
}
for (const example of examples) {
  const files = names.filter(name => name.replace(/^\d+-/, '') === example + '.crv');
  assert.equal(files.length, 1, example);
  check(readFileSync(new URL(files[0], directory), 'utf8'), example);
}
const controls = [
  '- item\n %%%\n hidden\n  %%%\n  ```\ntail\n',
  '- item\n %%%\n hidden\n  %%%\n  ```\n\ntail\n',
  '- item\n %%%\n hidden\n  %%%\n  ```\ntail\n  ```\n',
  '- item\n %%%\n hidden\n  %%%\n  # H\n  ```\ntail\n',
  '- item\n %%%\n hidden\n  %%%\n  ```\ntail\n- sibling\n',
  '- item\n  | a |\n  | b |\n  | malformed\n',
  '- item\n  | a |\n  | b |\ntail\n',
  '> a\n+\n> q\n> q2\n',
  'text\n___\n',
  '> a\n+\n>b\n> c\n',
  '> a\n+\n   > b\n> c\n',
  '- # H\n %x\n',
  '- # H\n %% note\n',
  '- item\n %%%\n hidden\n  %%%\n  ```\n--flag\n',
  '- item\n %%%\n hidden\n  %%%\n  ```\n: literal\n',
  ':: t\n: desc\n %%%\n c\n %%%\n  ```\n x\n  ```\n',
];
controls.forEach((source, index) => check(source, 'boundary control ' + index));
const escaped = parser.parse('| a b \\|\n').rootNode;
assert.equal(escaped.descendantsOfType('table_cell')[0].text, ' a b \\|');
assert.equal(escaped.descendantsOfType('backslash_escape').length, 1);
console.log('Block boundaries: ' + examples.length + ' corpus controls and ' + controls.length
  + ' boundary controls match engine ownership across LF, CRLF, and CR.');
