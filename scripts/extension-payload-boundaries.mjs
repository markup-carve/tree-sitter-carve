import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { parse } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
parser.setTimeoutMicros(2_000_000);
const hosts = [s => `${s}\n`, s => `# ${s}\n`, s => `| h |\n^ ${s}\n`,
  s => `^ ${s}\n`, s => `- ${s.replaceAll('\n', '\n  ')}\n`,
  s => `> ${s.replaceAll('\n', '\n> ')}\n`,
  s => `> | h |\n> ^ ${s.replaceAll('\n', '\n> ')}\n`,
  s => `- | h |\n  ^ ${s.replaceAll('\n', '\n  ')}\n`,
  s => `[^n]: ${s.replaceAll('\n', '\n  ')}\n\nSee[^n].\n`,
  s => `| ${s} |\n`, s => `*a ${s} b*\n`,
  s => `{*a ${s} b*}\n`, s => `/*a ${s} b*/\n`,
  s => `{/a ${s} b/}\n`, s => `[a ${s} b](u)\n`,
  s => `[a ${s} b]{.c}\n`, s => `| h |\n^ *a ${s} b*\n`];
const bodies = ['a :x[b] c', 'a `b] c` d', 'a ``b] c`` d', 'a ```b] c``` d', 'a ````b] c```` d', 'a !`b] c` d',
  'a $`b] c` d', 'a `] c`', 'a \\] c', 'a \\] c\\] d', 'a [b] c',
  'a [[b] c]', 'a [@k] c', 'a [^n] c', 'a ^[b] c', 'a ![b](u) c',
  'a [b](u) c', 'a [b]{.c} d', 'a {% c ] %} d', 'a {# c ] #} d',
  'a {*b] c*}', 'a {/b] c/}', 'a {~b~>c] d~}', 'a *b] c*',
  'a <http://b]c> d', 'a </#b]c> d', 'a {{ p] q }} d',
  'a *b*', 'a /b/', 'a {_b_}', 'a {~b~>c~}', 'a {% c %} d',
  'a {# c #} d', 'a `b` c', 'a <http://b> c', 'a :smile: c',
  'a *b*{title=\"c]d\"} e', 'a *b*{key=c]d} e',
  'a `b`{key=\"c]d\"} e', 'a {*b*}{key=\"c]d\"} e',
  'a :x[b', '*a*', '', 'a /*b*/ c', 'a /*b] c*/',
  'a *b \n] c*', 'a %% b] c', 'a {*b %% c] d*}',
  'a {{ p }} c', 'a {{ \"p]q\" }} c', 'a [b\\] c] d',
  'a {% \\] %} d', 'a {# \\] #} d', 'é 😀 :x[z] c', 'a\nb :x[z]', 'a\nb `z] c` d',
  'a\nb {% z ] %} d', 'a\nb \\] c', 'a\nb [@k] c'];
let cases = 0, edits = 0;
function nodes(value, kind, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.type === kind) out.push(value);
  for (const [key, child] of Object.entries(value)) if (key !== 'pos') nodes(child, kind, out);
  return out;
}
function check(source) {
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, JSON.stringify(source));
  const ast = parse(source);
  const offsets = [0];
  for (const character of source) offsets.push(offsets.at(-1) + character.length);
  const attributes = root.descendantsOfType('inline_attribute');
  for (const [native, engine] of [['extension_inline', 'inline_extension'],
    ['verbatim', 'code'], ['inline_link', 'link'], ['inline_literal', 'literal_inline'], ['math', 'math']]) {
    const wanted = nodes(ast, engine).map(n => [offsets[n.pos.startOffset], offsets[n.pos.endOffset]]);
    const actual = root.descendantsOfType(native).map(n => {
      let end = attributes.find(a => a.startIndex === n.endIndex)?.endIndex ?? n.endIndex;
      const marker = n.childForFieldName('end_marker');
      if (native === 'verbatim' && marker && marker.startIndex === marker.endIndex) {
        let host = n.parent;
        while (host && host.type !== 'table_cell') host = host.parent;
        if (host) while (end > n.startIndex && /[ \t]/.test(source[end - 1])) --end;
      }
      return [n.startIndex, end];
    });
    assert.deepEqual(actual, wanted, `${JSON.stringify(source)}: ${native} extents\n${root}`);
  }
  for (const [native, engine] of [['verbatim', 'code'], ['strong', 'strong'],
    ['emphasis', 'emphasis'], ['substitution', 'substitution'],
    ['editorial_comment', 'critic_comment'], ['hard_line_break', 'hard_break']]) {
    const kinds = native === 'strong' || native === 'emphasis' ? [native, 'bold_italic'] : [native];
    assert.equal(kinds.reduce((count, kind) => count + root.descendantsOfType(kind).length, 0), nodes(ast, engine).length,
      `${JSON.stringify(source)}: ${native}\n${root}`);
  }
  ++cases;
}
function point(source, index) {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1).length };
}
function snapshot(tree) {
  const out = [];
  (function walk(n) { out.push([n.type, n.startIndex, n.endIndex, n.isMissing]); n.children.forEach(walk); })(tree.rootNode);
  return out;
}
function edit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) ++start;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { --oldEnd; --newEnd; }
  const tree = parser.parse(before);
  tree.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
    startPosition: point(before, start), oldEndPosition: point(before, oldEnd), newEndPosition: point(after, newEnd) });
  assert.deepEqual(snapshot(parser.parse(after, tree)), snapshot(parser.parse(after)), JSON.stringify({before, after}));
  ++edits;
}
for (const body of bodies) for (const host of hosts.slice(0, 10)) for (const ending of ['\n', '\r\n', '\r']) {
  const source = host(`:x[${body}]`).replaceAll('\n', ending);
  check(source);
  for (const [beforeBody, afterBody] of [[body, body.replaceAll(']', '')],
    [body, `]${body}`], [body, `${body}] *z*`]]) {
    const before = host(`:x[${beforeBody}]`).replaceAll('\n', ending);
    const after = host(`:x[${afterBody}]`).replaceAll('\n', ending);
    check(after); edit(before, after); edit(after, before);
  }
  if (edits % 120 === 0) await new Promise(setImmediate);
}
for (const body of ['a :x[b] c', 'a `b] c` d', 'a ``b] c`` d', 'a ```b] c``` d', 'a ````b] c```` d', 'a \\] c',
  'a [b] c', 'a [[b] c]', 'a [b](u) c', 'a [b]{.c} d',
  'a <http://b]c> d', 'a {{ p] q }} d', 'a *b*{key="c]d"} e']) {
  for (const host of hosts.slice(10)) for (const ending of ['\n', '\r\n', '\r']) {
    const before = host(`:x[${body}]`).replaceAll('\n', ending);
    check(before);
    for (const next of [body.replaceAll(']', ''), `]${body}`, `${body}] *z*`]) {
      const after = host(`:x[${next}]`).replaceAll('\n', ending);
      check(after); edit(before, after); edit(after, before);
    }
    if (edits % 126 === 0) await new Promise(setImmediate);
  }
}
for (const source of ['*a :x[b] `c* d` e*', '[a :x[b] `c] d` e](u)',
  '*a :x[a [b] c] `d* e` f*', '[a :x[a [b] c] `d] e` f](u)',
  '*a :x[a `b] c` d] b* zz`', '*a :x[b\\] `c* d` e*',
  '*a :x[a [b] `c* d` e] f*', '[a :x[a [b] `c] d` e] f](u)',
  '[*a :x[a [b] c] d*](u)', '*a :x[a [b] `c] * d` e] f*',
  '[*a :x[a `b] c` d] b*](u)',
  '*a :x[{# ] #} `d* e` f*', '*a :x[{% ] %} `d* e` f*',
  '[a :x[{# ] #} `d] e` f](u)', ':x[{{ a *b* c]',
  '[a [b] c [d] e]{.c}', '[a [b] c %% d]{.c}']) {
  for (const ending of ['\n', '\r\n', '\r']) {
    const before = `${source}${ending}`;
    check(before);
    const after = before.replace(':x[b]', ':x[a :x[b] c]');
    check(after); edit(before, after); edit(after, before);
  }
}
for (const depth of [254, 255, 256, 300]) for (const ending of ['\n', '\r\n', '\r']) {
  const before = `*a :x[a ${'['.repeat(depth)}\`b] c\` ${']'.repeat(50)}x* y${']'.repeat(depth - 49)}z*${ending}`;
  check(before);
  const after = before.replace('x* y', 'x y');
  check(after); edit(before, after); edit(after, before);
}
console.log(`Extension payloads: ${cases} engine comparisons, ${edits} incremental edits`);
