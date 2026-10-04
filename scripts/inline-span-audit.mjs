import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { carveToHtml } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
parser.setTimeoutMicros(2_000_000);
const markers = [['*', '*'], ['/', '/'], ['_', '_'], ['^', '^'], [',', ','],
  ['~', '~'], ['/*', '*/'], ['{*', '*}'], ['{/', '/}'], ['{_', '_}'],
  ['{^', '^}'], ['{,', ',}'], ['{~', '~}']];
const bodies = ['a', ' a', 'a ', 'a\tb', 'a\nb', '[x]', '[x](/u)', '[x]{.c}',
  '![x](x.png)', '`x`', '`x', '\\x', '{% x %}', '{# x #}', '{x}', 'x %% c',
  'x &amp; y', 'ž', '😀', 'a*b', 'a/b', 'a_b', 'a^b', 'a,b', 'a~b',
  'a /*b*/ c', 'a {+b+} c'];
const suffixes = ['', ' y', '.y', '{.c}', '{#i}', '{???}', '*z*', '/z/', ' [x](/u)'];
const types = {
  strong: ['strong', 'bold_italic', 'tag', 'mention'], em: ['emphasis', 'bold_italic'],
  u: ['underline'], sup: ['superscript', 'inline_note', 'footnote_reference'],
  sub: ['subscript'], s: ['strikethrough'], code: ['verbatim'], mark: ['highlighted'],
};
function check(source) {
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, JSON.stringify(source));
  const html = carveToHtml(source);
  for (const [tag, kinds] of Object.entries(types)) {
    const wanted = [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = kinds.reduce((n, kind) => n + root.descendantsOfType(kind).length, 0);
    assert.equal(actual, wanted, `${JSON.stringify(source)}: ${tag}\n${root.toString()}`);
  }
  return root;
}
let generated = 0;
for (const [open, close] of markers) for (const body of bodies) for (const suffix of suffixes) {
  check(open + body + close + suffix + '\n');
  ++generated;
}
const controls = ['*`x`*', '_`x`_', '/{% x %}/', '*{x}*', '*{# x #}*', '*{% x %}*',
  '~{% x %}~', '{^a^b^}', '{,a,b,}', '/* a*/', '/*a */*z*', '/*`x*/',
  '/*[x]*/*z*', '/*a /*b*/ c*/*z*', '^[x]^', '{^ a^}', '/*a/*/', '/*a/b/*/', '{/a/*b*/}', '{//*a*/}',
  '{//*a/ b*/}', '{*/*a /*b*/ c*/*}', '{*/*a*//b/*}', '/*`x */', '/*` */',
  '{*/*`x*}*/', '/*`x*/ y `z`', '/*a `b*/ c` d*/', '/*`x*/ /*`y*/',
  '*/* a*/*', '^[n', 'x ^[n', '*a /*`x*/ b*', '/a /b /*c d/', '*{% x*\n y %}', '*{% x*\n y %}*',
  '*{# x*\n y #}', '*{# x*\n y #}*', 'a/*/`', '/*/a`', '//*/`',
  '/***`', '/*`*/', '/*a`*/', '*a{*', '/a{/', '_/{_', '/{_a_', '/{*a*',
  '_*_*', '_a *_*', '_}*_*', '_*/_*/', '/***', '*a*/***', 'x *%%*', '*_/*_*',
  '[/*]/', 'x/*\n|/|', '/*a{*/', '/*{a*/', '*{//a/', '__{{_', '*{_}_',
  '*a/*a/**', '/a *//*/', '/**{*', 'a/**{*', '/*a_{_', '{*/**}', '[a *b`c` d*]', '[a *`b*`]', 'a/*\n /*c/', 'a/*b* c/',
  '[/*a* b]/', '/*a {/b/}*', '/*a {/b/} c*', '/*a {*b*} c*/',
  '/*a {/b/} c*/', '*[](`*', '[/*]*/', 'x /** b*', 'a /*** b* c', '/a/*`*/', '/*{/a', '/{_/_}', '{~a {~b~} c~}', '{*a {*b*} c*}', '{/a {/b/} c/}', '{_a {_b_} c_}',
  '#a/*/', '@a/*/', '#a/{/', '#a*{*', '/~~a~', '~~**~', '/*a__a_', '/a/**a*',
  '=/=/+', '={*=*', '/**{*}/', '*/{/*/}', '/*a{*/}', '/*{_*}/', '{/*[*',
  '/*{[}/', '/**/{[', '*{{_ _}', '#a-*b*', '@a-/*/', '#a_/*a*/', '#a.-*b*',
  '*a\\ %% b*', '*a\\ * b', '/a\\ / b', '_a\\ _ b', '~a\\ ~ b', 'a#a*{*', 'a#a/*/', 'a#a/{/', '/*{a#a', 'x@a/*/',
  'x#a-*b*', 'x@a_/*a*/', '/=', '/a/=', '/=/=', 'x /=/=', '=a=/=', '=a= /=',
  '~=~', '~=~=', '=/=/=', '==/=/=', '{{_a_', '{//*/', '{_/*/', '{/_{_', '{**{*'];
const hosts = [s => `${s}\n`, s => `# ${s}\n`, s => `- ${s}\n`,
  s => `> ${s}\n`, s => `::: note\n${s}\n:::\n`];
let boundaries = 0;
for (const body of controls) for (const host of hosts) for (const ending of ['\n', '\r\n', '\r']) {
  const source = host(body).replaceAll('\n', ending);
  check(source);
  ++boundaries;
}
function point(source, index) {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1).length };
}
function snapshot(tree) {
  const nodes = [];
  function visit(node) {
    nodes.push([node.type, node.startIndex, node.endIndex, node.isMissing]);
    node.children.forEach(visit);
  }
  visit(tree.rootNode);
  return JSON.stringify(nodes);
}
let edits = 0;
function compareEdit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) ++start;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { --oldEnd; --newEnd; }
  const old = parser.parse(before);
  old.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
    startPosition: point(before, start), oldEndPosition: point(before, oldEnd),
    newEndPosition: point(after, newEnd) });
  assert.equal(snapshot(parser.parse(after, old)), snapshot(parser.parse(after)), JSON.stringify(after));
  ++edits;
}
for (const body of controls) for (const ending of ['\n', '\r\n', '\r']) {
  const source = body + ending;
  for (let at = 0; at < body.length; ++at) {
    const shorter = source.slice(0, at) + source.slice(at + 1);
    compareEdit(source, shorter);
    compareEdit(shorter, source);
  }
}
for (const source of ['| *b * |\n', '| *a {*b |\n', '| {*b * |\n', '| *a\\ * b |\n', '| /a\\ / b |\n', '| _a\\ _ b |\n', '| ~a\\ ~ b |\n', '| *a /b* c/ |\n', '| /a *b/ c* |\n', '| */a*/ |\n', '| /**/* |\n', '| /{*/* |\n', '| /* */* |\n', '| ~=~= |\n', '| *[*] |\n', '| /[/] |\n',
  '| =[=] |\n', '| *a [b*] c |\n', '| *a [b*](u) |\n', '| *a [[b*]] |\n',
  '| *a :x[b*] |\n', '| *a {/b*/} |\n', '| *a {+b*+} |\n', '| *a {_b* c_} |\n',
  '| /a {*b/ c*} |\n', '| *a{*b [c*} d] |\n', '| *a ![b*](u) |\n']) check(source);
for (const body of controls) {
  compareEdit(body + '\n', 'x' + body + '\n');
  compareEdit('x' + body + '\n', body + '\n');
  compareEdit('a\n' + body + '\n', 'xa\n' + body + '\n');
  compareEdit('xa\n' + body + '\n', 'a\n' + body + '\n');
}
compareEdit('/a\n *\n', '/a *\n');
compareEdit('/a\n /a\n', '/a /a\n');
compareEdit('a\n/**/\n', 'xa\n/**/\n');
for (const marker of ['*', '/', '_', '~', '=']) {
  const before = (`{${marker}a `).repeat(8) + '\n';
  const after = before.slice(0, -1) + marker + '}\n';
  compareEdit(before, after);
  compareEdit(after, before);
  const bareBefore = (marker + 'a ').repeat(8) + '\n';
  const bareAfter = bareBefore.slice(0, -1) + marker + '\n';
  compareEdit(bareBefore, bareAfter);
  compareEdit(bareAfter, bareBefore);
}
console.log(`Inline span audit: ${generated} generated inputs, ${boundaries} block controls and ${edits} incremental edits pass.`);
