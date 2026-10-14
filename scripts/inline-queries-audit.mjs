// Inline and caption readings measured against the pinned carve-js, plus the
// injections and highlights these readings feed. Each case states the node
// counts the grammar must build and the HTML element it must agree with.
import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { carveToHtml } from '@markup-carve/carve';

const require = createRequire(import.meta.url);
const language = require('../bindings/node');
const parser = new Parser();
parser.setLanguage(language);

// node type -> the HTML it renders as, counted on both sides.
const PAIRS = {
  autolink: /<a href="/g,
  caption: /<figcaption>/g,
  extension_inline: /class="ext-/g,
  table_cell: /<t[dh][ >]/g,
};

const CASES = [
  ['an email autolink', 'mail <a@b.com> now\n', { autolink: 1 }],
  ['email autolinks beside non-autolinks', '<a@b> <a@b.com> <x@y:z>\n', { autolink: 1 }],
  ['a body with no scheme or address', 'a <ab.com> b\n', { autolink: 0 }],
  ['a format character breaks the autolink', 'x <https://e\u{FEFF}.com/> y\n', { autolink: 0 }],
  ['a non-ASCII host is an autolink', 'x <https://bücher.de/> y\n', { autolink: 1 }],
  ['an unclosed autolink is text', 'a <https://x y\n', { autolink: 0 }],
  ['one blank line keeps an image caption', '![G](g.jpg)\n\n^ Figure: moon\n', { caption: 1 }],
  ['two blank lines detach an image caption', '![G](g.jpg)\n\n\n^ Figure: moon\n', { caption: 0, paragraph: 2 }],
  ['two blank lines detach a listing caption', '```lua\nx\n```\n\n\n^ Listing: x\n', { caption: 0 }],
  ['a whitespace-only line counts as blank', '![a](a.png)\n\n \n^ cap\n', { caption: 0 }],
  ['blank lines before the host do not detach', 'p\n\n\n![a](a.png)\n^ cap\n', { caption: 1 }],
  ['an admonition takes no caption', '::: note\nBody.\n:::\n^ Not a caption\n', { caption: 0 }],
  ['a fenced quote takes a caption', '::: >\nq\n:::\n^ cap\n', { caption: 1 }],
  ['a figure group takes a caption', '::: figure\n![a](a.png)\n:::\n^ cap\n', { caption: 1 }],
  ['a detached group caption', '::: figure\n![a](a.png)\n:::\n\n\n^ cap\n', { caption: 0 }],
  ['a reference definition needs a destination', '[r]:   \n', { link_reference_definition: 0, paragraph: 1 }],
  ['an underscore extension name', ':_[x] a:_[y]\n', { extension_inline: 2 }],
  ['a tab is no inline attribute padding', '[x]{\t}\n', { span: 0 }],
  ['a tab does not separate inline attributes', '*x*{.a\t.b}\n', { inline_attribute: 0 }],
  ['a tab still pads a block attribute line', '{.a\t.b}\n# h\n', { block_attribute: 1 }],
  ['an empty block attribute line is text', '{}\n\n{ }\n', { block_attribute: 0, paragraph: 2 }],
  ['an abbreviation definition interrupts a paragraph', 'The HTML spec.\n*[HTML]: HyperText\n', { abbreviation_definition: 1 }],
  ['an indented abbreviation does not', 'a\n *[H]: x\n', { abbreviation_definition: 0 }],
  ['an indented colon fence stays one paragraph', ' ::: note\n Body.\n :::\n', { paragraph: 1 }],
  ['a tab-padded cell attribute is cell content', '|{.a\t.b} a | b |\n', { table_cell: 2, table_cell_attributes: 0 }],
  ['a malformed cell attribute is cell content', '|{???} a | b |\n', { table_cell: 2, table_cell_attributes: 0 }],
  ['a space-padded cell attribute', '|{.a .b} a | b |\n', { table_cell: 2, table_cell_attributes: 1 }],
  ['a malformed row attribute is no table', '| a | b |{.a:b}\n', { table_cell: 0, paragraph: 1 }],
  ['an inline attribute stays on its line', '[x]{.a\n.b}\n', { span: 0, inline_attribute: 0 }],
  ['an attribute after code stays on its line', '`c`{.a\n.b}\n', { inline_attribute: 0 }],
  ['a block attribute line may wrap', '{.a\n .b}\n# h\n', { block_attribute: 1 }],
  ['a percent comment is no inline attribute item', '[x]{.c %c%}\n', { span: 0, inline_attribute: 0 }],
  ['a percent comment is no block attribute item', '{.c %c%}\n# h\n', { block_attribute: 0 }],
  ['a braced comment line is still a comment', '{% c %}\n', { braced_comment: 1 }],
  ['a citation key cannot label a reference link', '[t][@a]\n', { citation_group: 0 }],
  ['nor an image reference', '![t][@a]\n', { citation_group: 0 }],
  ['a bracketed citation stays a citation', 'x [@doe] y\n', { citation_group: 1 }],
  ['a citation behind a stray bracket', 'a][@a]\n', { citation_group: 1 }],
  ['Djot quote braces are text', 'say {"hi"} and {\'x\'}\n', { quotation_marks: 0 }],
];

let checks = 0;
for (const [name, source, want] of CASES) {
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, `${name}: ${root.toString()}`);
  const html = carveToHtml(source);
  for (const [type, count] of Object.entries(want)) {
    const got = root.descendantsOfType(type).length;
    assert.equal(got, count, `${name}: ${type} ${got}, expected ${count}\n${root.toString()}`);
    if (PAIRS[type]) {
      const rendered = (html.match(PAIRS[type]) || []).length;
      assert.equal(count, rendered, `${name}: carve-js renders ${rendered} for ${type}\n${html}`);
    }
    ++checks;
  }
}

// The cap counts every container kind together, as carve-js does.
for (const [source, want] of [
  [':::: note\n'.repeat(150) + '> '.repeat(60) + 'x\n', { div: 150, block_quote: 50 }],
  [':::: note\n'.repeat(199) + '- - - x\n', { div: 199, list_item: 1 }],
  [':::: note\n'.repeat(199) + '> > > x\n', { div: 199, block_quote: 1 }],
]) {
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, 'mixed nesting cap');
  for (const [type, count] of Object.entries(want)) {
    assert.equal(root.descendantsOfType(type).length, count, `mixed nesting cap: ${type}`);
    ++checks;
  }
}

// 203 openers past MAX_NESTING_DEPTH = 200: the last three join the paragraph.
{
  const source = ':::: note\n'.repeat(203) + 'x\n';
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, 'nesting cap');
  assert.equal(root.descendantsOfType('div').length, 200, 'nesting cap: divs');
  assert.equal(root.descendantsOfType('paragraph').length, 1, 'nesting cap: paragraphs');
  ++checks;
}

const strip = (text) => text.replace(/\(#offset![^)]*\)/g, '');
const query = (name) => new Parser.Query(language,
  strip(readFileSync(new URL(`../queries/${name}.scm`, import.meta.url), 'utf8')));
const injections = query('injections');
const highlights = query('highlights');

function injected(source) {
  const tree = parser.parse(source);
  return injections.matches(tree.rootNode).flatMap((match) => {
    const content = match.captures.find((c) => c.name === 'injection.content');
    const lang = match.captures.find((c) => c.name === 'injection.language')?.node.text
      ?? injections.setProperties?.[match.pattern]?.['injection.language'];
    return content ? [[lang, content.node.type]] : [];
  });
}

for (const [source, lang, type] of [
  ['---\ntitle: x\n---\n', 'yaml', 'frontmatter_content'],
  ['---toml\na = 1\n---\n', 'toml', 'frontmatter_content'],
  ['%% TODO here\n', 'comment', 'comment_line'],
  ['a %% FIXME tail\n', 'comment', 'trailing_comment'],
  ['%%%\nTODO x\n%%%\n', 'comment', 'content'],
  ['a {% NOTE x %} b\n', 'comment', 'content'],
]) {
  const found = injected(source);
  assert.ok(found.some(([l, t]) => l === lang && t === type),
    `${JSON.stringify(source)}: no ${lang} injection on ${type}, got ${JSON.stringify(found)}`);
  ++checks;
}
assert.equal(injected('---toml\na = 1\n---\n').filter(([l]) => l === 'yaml').length, 0,
  'a languaged frontmatter is not also YAML');
++checks;

function capturesOn(source, type) {
  const tree = parser.parse(source);
  return highlights.captures(tree.rootNode)
    .filter((c) => c.node.type === type).map((c) => c.name);
}
assert.ok(!capturesOn(':: term\n: body\n', 'definition').includes('markup.italic'),
  'a description body is not italic');
assert.ok(capturesOn(':: term\n: body\n', 'term').includes('type.definition'),
  'the term keeps its capture');
assert.deepEqual(capturesOn('a TODO b\n', 'todo'), [], 'prose TODO is a word');
checks += 3;

console.log(`inline queries audit: ${checks} checks pass`);
