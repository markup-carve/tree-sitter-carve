import assert from 'node:assert/strict';
import test from 'node:test';
import Parser from 'tree-sitter';
import Carve from '../bindings/node/index.js';

// An unclosed run whose last line is a quote prefix with nothing after it at
// the end of input. The content token read that line as a quoted blank line and
// stayed zero width, while the continuation decision read it as more content,
// so the two tokens alternated at one spot forever (#681).
const LIMIT_US = 250_000;
const parser = new Parser();
parser.setLanguage(Carve);
parser.setTimeoutMicros(LIMIT_US);

const finishes = (source) => {
  try {
    return parser.parse(source) != null;
  } catch {
    return false;
  } finally {
    parser.reset();
  }
};

// [first-line prefix, continuation prefix at depth 1..n]
const hosts = [
  ['> ', ['> ']],
  ['> > ', ['> ', '> > ', '> > > ']],
  ['> > > ', ['> > ', '> > > ']],
  ['> - ', ['> ', '>   ']],
  ['- > ', ['  > ', '  ']],
];
const openers = ['', 'a', '{}', '=z=c', '_x_', 'x{.a}', '*a*', '[a]', '{=a=}', '{_a_}', 'a ', '@m'];
const runs = ['`', '``'];
const suffixes = ['', ' ', '  ', '\t', ' \t'];
const terminators = ['\n', '\r\n', '\r'];

test('an unclosed run before an empty quote line at the end of input finishes', () => {
  assert.equal(finishes('> =z=c`\n> '), true);
  assert.equal(finishes('> {}`\n> '), true);

  let checked = 0;
  const stuck = [];
  for (const [first, continuations] of hosts) for (const opener of openers) for (const run of runs) {
    for (const prefix of continuations) for (const suffix of suffixes) for (const nl of terminators) {
      for (const bare of [prefix, prefix.trimEnd()]) {
        const source = `${first}${opener}${run}${nl}${bare}${suffix}`;
        if (!finishes(source)) stuck.push(JSON.stringify(source));
        ++checked;
      }
    }
  }
  assert.equal(checked, 7200);
  assert.deepEqual(stuck, []);
});
