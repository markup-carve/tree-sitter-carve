import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';
import { carveToHtml, parse } from '@markup-carve/carve';

const parser = new Parser();
parser.setLanguage(Carve);
parser.setTimeoutMicros(2_000_000);
const spans = [[':x[', ']'], ['[', '](u)'], ['[', ']{.c}'], ['![', '](u)'],
  ['{*', '*}'], ['{/', '/}'], ['{_', '_}'], ['{~', '~}'], ['{=', '=}'],
  ['{+', '+}'], ['{-', '-}'], ['{^', '^}'], ['{,', ',}'], ['/*', '*/'],
  ['*', '*'], ['/', '/'], ['_', '_'], ['~', '~'], ['=', '='], ['`', '`'],
  ['{# ', ' #}'], ['{% ', ' %}'], ['{~a~>', '~}'], ['[a](u "', '")']];
const hosts = [s => `| h |\n^ ${s}\n`,
  s => `- | h |\n  ^ ${s.replaceAll('\n', '\n  ')}\n`,
  s => `> | h |\n> ^ ${s.replaceAll('\n', '\n> ')}\n`,
  s => `::: note\n| h |\n^ ${s}\n:::\n`,
  s => `^ ${s}\n`, s => `![h](u)\n^ ${s}\n`,
  s => `> > | h |\n> > ^ ${s.replaceAll('\n', '\n> > ')}\n`,
  s => `- > | h |\n  > ^ ${s.replaceAll('\n', '\n  > ')}\n`,
  s => `> - | h |\n>   ^ ${s.replaceAll('\n', '\n>   ')}\n`,
  s => `[^n]: | h |\n  ^ ${s.replaceAll('\n', '\n  ')}\n\nSee[^n].\n`,
  s => `> ::: note\n> | h |\n> ^ ${s.replaceAll('\n', '\n> ')}\n> :::\n`,
  s => `> [^n]: | h |\n>   ^ ${s.replaceAll('\n', '\n>   ')}\n\nSee[^n].\n`];
const types = { strong: ['strong', 'bold_italic', 'tag', 'mention'],
  em: ['emphasis', 'bold_italic'], u: ['underline'], s: ['strikethrough'],
  mark: ['highlighted'], code: ['verbatim'], a: ['inline_link'] };
let cases = 0, edits = 0;
function countAst(value, type, accepts = () => true) {
  if (!value || typeof value !== 'object') return 0;
  let count = value.type === type && accepts(value) ? 1 : 0;
  for (const [key, child] of Object.entries(value)) if (key !== 'pos') count += countAst(child, type, accepts);
  return count;
}
function check(source) {
  const root = parser.parse(source).rootNode;
  assert.equal(root.hasError, false, JSON.stringify(source));
  const html = carveToHtml(source);
  const ast = parse(source);
  for (const [tag, kinds] of Object.entries(types)) {
    const wanted = tag === 'a' ? countAst(ast, 'link') :
      [...html.matchAll(new RegExp(`<${tag}(?:>|\\s)`, 'g'))].length;
    const actual = kinds.reduce((n, kind) => n + root.descendantsOfType(kind).length, 0);
    assert.equal(actual, wanted, `${JSON.stringify(source)}: ${tag}\n${root.toString()}`);
  }
  assert.equal(root.descendantsOfType('extension_inline').length,
    [...html.matchAll(/class="ext-x"/g)].length, JSON.stringify(source));
  assert.equal(root.descendantsOfType('heading').length,
    [...html.matchAll(/<h[1-6](?:>|\s)/g)].length, JSON.stringify(source));
  assert.equal(root.descendantsOfType('substitution').length, countAst(ast, 'substitution'), JSON.stringify(source));
  for (const [nativeKind, engineKind] of [['extension_inline', 'inline_extension'], ['substitution', 'substitution'], ['editorial_comment', 'critic_comment']]) {
    const expected = [];
    countAst(ast, engineKind, node => { expected.push([node.pos.startOffset, node.pos.endOffset]); return true; });
    const actual = root.descendantsOfType(nativeKind).map(node => [node.startIndex, node.endIndex]);
    assert.deepEqual(actual, expected, `${JSON.stringify(source)}: ${nativeKind} extent`);
  }
  assert.equal(root.descendantsOfType('editorial_comment').length, countAst(ast, 'critic_comment'), JSON.stringify(source));
  assert.equal(root.descendantsOfType('braced_comment').length,
    countAst(ast, 'comment', node => source.slice(node.pos?.startOffset, node.pos?.startOffset + 2) === '{%'), JSON.stringify(source));
  ++cases;
}
function point(source, index) {
  const lines = source.slice(0, index).split('\n');
  return { row: lines.length - 1, column: lines.at(-1).length };
}
function snapshot(tree) {
  const nodes = [];
  (function visit(node) {
    nodes.push([node.type, node.startIndex, node.endIndex, node.isMissing]);
    node.children.forEach(visit);
  })(tree.rootNode);
  return JSON.stringify(nodes);
}
function edit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) ++start;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { --oldEnd; --newEnd; }
  const old = parser.parse(before);
  old.edit({ startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd,
    startPosition: point(before, start), oldEndPosition: point(before, oldEnd), newEndPosition: point(after, newEnd) });
  assert.equal(snapshot(parser.parse(after, old)), snapshot(parser.parse(after)), JSON.stringify({before, after}));
  ++edits;
}
for (const [open, close] of spans) for (const host of hosts) for (const ending of ['\n', '\r\n', '\r']) {
  const before = host(open + 'a\nb' + close).replaceAll('\n', ending);
  check(before);
  for (const next of ['# b', '## b', '> b', '---\nb', '| b |']) {
    const after = host(open + 'a\n' + next + close).replaceAll('\n', ending);
    check(after);
    edit(before, after);
    edit(after, before);
    if (edits % 128 === 0) await new Promise(setImmediate);
  }
}
for (const [open, close] of spans) for (const ending of ['\n', '\r\n', '\r']) {
  for (const next of [' # b', '  > b', '   ---\nb']) check(hosts[0](open + 'a\n' + next + close).replaceAll('\n', ending));
  for (const next of [' # b', '  ## b', '   ---\nb']) check(hosts[2](open + 'a\n' + next + close).replaceAll('\n', ending));
}
for (const body of ['{*a `c\n# b`*}', ':x[a `c\n# b`]', '{*a {# c\n# b #}*}', ':x[a {% c\n# b %}]', '/*a [c\n# b]*/', '*a {_b\n[c_} d*', '*a `b\n[c` d*', ':x[a [c\n# b]]', '*a {% c\n# b %}*', '_a {# c\n# b #}_', '*a `c\n# b`*', '/*a {% c\n# b %}*/', '{~a\n# b~>c~}', '{~a `x\n| y` ~> b~}']) {
  for (const host of hosts) for (const ending of ['\n', '\r\n', '\r']) check(host(body).replaceAll('\n', ending));
}
for (const body of ['a\n  %% b', '{*a\n  %% b*}\nc*}', ':x[a\n  %% b]\nc]', '`a\n  %% b`\nc`']) {
  for (const host of hosts) for (const ending of ['\n', '\r\n', '\r']) check(host(body).replaceAll('\n', ending));
}
for (const host of hosts) for (const ending of ['\n', '\r\n', '\r']) {
  const before = host('{*a\nb*}').replaceAll('\n', ending);
  for (const body of ['{*a\n# b*}\nz', '{*a\n\nb*}', '{*a b*}', '{*a\nb*}\nz']) {
    const after = host(body).replaceAll('\n', ending);
    check(after); edit(before, after); edit(after, before);
  }
}
for (const [open, close] of spans) for (const ending of ['\n', '\r\n', '\r']) {
  const before = hosts[2](open + 'a\nb' + close).replaceAll('\n', ending);
  for (const middle of ['>', '> ', '>\t# b', '># b']) {
    const after = `> | h |\n> ^ ${open}a\n${middle}\n> b${close}\n`.replaceAll('\n', ending);
    check(after); edit(before, after); edit(after, before);
  }
  for (const spaces of [' ', '  ']) check(`> > | h |\n> > ^ ${open}a\n>${spaces}b${close}\n`.replaceAll('\n', ending));
  check(`> | h |\n> ^ ${open}a\n^ b${close}\n`.replaceAll('\n', ending));
  check(`> > | h |\n> > ^ ${open}a\n> ^ b${close}\n`.replaceAll('\n', ending));
}
for (const [open, close] of spans) for (const ending of ['\n', '\r\n', '\r']) {
  for (const host of [hosts[10], hosts[11]]) check(host(open + 'a\n^ b' + close).replaceAll('\n', ending));
  for (const spaces of [' ', '  ', '   ']) check(hosts[1](open + 'a\n' + spaces + '^ b' + close).replaceAll('\n', ending));
  check(`[^n]: | h |\n  ^ ${open}a\n b${close}\n\nSee[^n].\n`.replaceAll('\n', ending));
}
for (const [open, close] of spans) for (const ending of ['\n', '\r\n', '\r']) {
  for (const noise of ['', '> child\n\n', '::: child\nx\n:::\n', '[^z]: note\n\n', '| c |\n\n']) {
    check(`- item\n+\n::: note\n${noise}| h |\n^ ${open}a\n  ^ b${close}\n:::\n`.replaceAll('\n', ending));
  }
}
console.log(`Caption boundaries: ${cases} engine controls and ${edits} incremental edits pass.`);
