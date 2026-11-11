import assert from 'node:assert/strict';
import test from 'node:test';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';

const parser = new Parser();
parser.setLanguage(Carve);
const tree = (source) => parser.parse(source).rootNode.toString();

// A `]` right before a CR notes that a `{` or `(` behind the CR is no
// attribute list. That note must not outlive the line end and refuse a
// comment, span or link opener on a later line.
const ends = ['x[^n]', 'x [^n]', '[a](u) [^n]', '[t]', '[t]{.c} [^n]', '*a* [^n]', '[a [^n]'];
const laters = ['b {% a %}', '{# a #} b', '{*a*} b', 'b {=a=}', 'b [c](u)', 'b (x) [d]{.e}', '{.c}', '{% a', '[^n]: {% a %}'];
const gaps = ['\n', '\n\n'];
const hosts = [
  (s) => s,
  (s) => `- ${s.replaceAll('\n', '\n  ').replaceAll('\n  \n', '\n\n')}`,
  (s) => `> ${s.replaceAll('\n', '\n> ')}`,
];

test('a span end before a CR leaves later lines as an LF document reads them', () => {
  let checked = 0;
  const differing = [];
  for (const end of ends) for (const later of laters) for (const gap of gaps) for (const host of hosts) {
    const lf = `${host(`${end}${gap}${later}`)}\n`;
    const want = tree(lf);
    for (const terminator of ['\r\n', '\r']) {
      const source = lf.replaceAll('\n', terminator);
      if (tree(source) !== want) differing.push(JSON.stringify(source));
      ++checked;
    }
  }
  assert.equal(checked, ends.length * laters.length * gaps.length * hosts.length * 2);
  assert.deepEqual(differing, []);
});

test('a `{` behind a CR still does not attach to the span before it (#192)', () => {
  assert.equal(tree('[t]\r{.c}\r'), tree('[t]\n{.c}\n'));
  assert.doesNotMatch(tree('[t]\r\n{.c}\r\n'), /square_bracket_span|inline_attribute/);
});
