import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { parse } from '@markup-carve/carve';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const parser = new Parser();
parser.setLanguage(createRequire(import.meta.url)('../bindings/node'));
const corpus = new URL('../spec/tests/corpus/', import.meta.url);
const files = readdirSync(corpus).filter(f => /^\d+-a-link-inside-a-span-s-label-keeps-its-destination(?:-\d+)?\.crv$/.test(f));
assert.ok(files.length >= 9, 'All recorded attributed-span controls must participate.');
function links(node) {
  let count = ['link', 'autolink'].includes(node?.type) ? 1 : 0;
  for (const value of Object.values(node ?? {})) {
    if (Array.isArray(value)) for (const child of value) count += links(child);
  }
  return count;
}
const tags = { a: 'inline_link', span: 'span', em: 'emphasis', strong: 'strong', u: 'underline' };
for (const file of files) {
  const source = readFileSync(new URL(file, corpus), 'utf8');
  const html = readFileSync(new URL(file.replace(/\.crv$/, '.html'), corpus), 'utf8');
  for (const ending of ['\n', '\r\n', '\r']) {
    const root = parser.parse(source.replace(/\r\n|\r|\n/g, ending)).rootNode;
    assert.equal(root.hasError, false, file);
    for (const [tag, type] of Object.entries(tags)) {
      const expected = tag === 'a' ? links(parse(source)) : [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
      const actual = tag === 'a' ? root.descendantsOfType(['inline_link', 'full_reference_link', 'collapsed_reference_link', 'autolink']).length : root.descendantsOfType(type).length;
      assert.equal(actual, expected, `${file}: ${tag}`);
    }
    for (const node of root.descendantsOfType('inline_link_destination')) {
      assert.match(node.text, /^\([^\r\n]*\)$/);
    }
  }
}

for (const ending of ['\n', '\r\n', '\r']) {
  for (const [source, counts] of [
    ['*[b [a](/u)]{.x}*', { strong: 1, span: 1, inline_link: 1 }],
    ['[/[t](/v)/]{.c}', { emphasis: 1, span: 1, inline_link: 1 }],
    ['[a *b*]', { strong: 1, span: 0 }],
    ['[[a *b*]]', { strong: 1, span: 0 }],
    ['[Example][ex]{#b}' + ending + ending + '[ex]: /u', { full_reference_link: 1, span: 0 }],
    ['a ![t[z[q]]][r]{.c} b' + ending + ending + '[r]: /i.png', { full_reference_image: 1, span: 0 }],
    ['[t[z]](/u)', { inline_link: 1, span: 0 }],
    ['[x]: /u', { link_reference_definition: 1 }],
    ['[^x]: note', { footnote: 1 }],
    ['[[x' + ending + 'y]]', { span: 0 }],
    ['[[*x' + ending + 'y*]]', { strong: 1 }],
    ['x [[^1]] y' + ending + ending + '[^1]: note', { footnote_reference: 1 }],
    ['x *[[^1]]* y' + ending + ending + '[^1]: note', { strong: 1, footnote_reference: 1 }],
    ['x [[[^1]]] y' + ending + ending + '[^1]: note', { footnote_reference: 1 }],
    ['x [[@k]] y', { citation_group: 1 }],
    ['[ [ x ] ]', { span: 0 }],
    ['[[x](u)]', { inline_link: 1 }],
    ['x ^[a ^[b] /c/]', { inline_note: 1, emphasis: 1 }],
  ]) {
    const root = parser.parse(source + ending).rootNode;
    assert.equal(root.hasError, false, source);
    for (const [type, count] of Object.entries(counts)) assert.equal(root.descendantsOfType(type).length, count, source);
    if (source.startsWith('x ^[')) {
      assert.equal(root.descendantsOfType('inline_note')[0].descendantsOfType('emphasis').length, 1);
    }
  }
}
console.log('Attributed spans: 9 corpus controls and 18 boundary controls across all line endings.');
