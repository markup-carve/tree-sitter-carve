#!/usr/bin/env node
// No `+` continuation shape may parse to ERROR or MISSING.
//
// The verdict checks only ask whether a `+` became a marker, so a tree that
// recovers through an ERROR node still passes them (#588). This sweep walks
// owner x follower x host shapes around a separate-line `+` and fails on any
// error tree outside KNOWN, and on a KNOWN shape that now parses cleanly, so
// the list only shrinks. It also refuses a corpus test that expects an error.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import Parser from 'tree-sitter';

const require = createRequire(import.meta.url);
const parser = new Parser();
parser.setLanguage(require('../bindings/node'));

// Error trees already present in 0.1.10, before the #584 work.
const KNOWN = new Set([
  '- > - a\n  >     +\n  >     - s\n',
  '- > - ```\n  >   x\n  >   ```\n  >     +\n  >     - s\n',
]);

const owners = [
  ['- a'], ['1. a'], ['> q'], ['> > q'], ['[^a]: a'], [':: t', ': a'],
  ['- > a'], ['- a', '  - b'], ['- a', '  > q'], ['- [ ] a'], ['> - a'],
  ['- ```', '  x', '  ```'], ['> - > a'], ['- > - > a'],
];
const followers = [['b'], ['> r'], ['- s'], ['```', 'c', '```'], ['# h'], ['| a |']];
const hosts = [['', ''], ['> ', '> '], ['- ', '  '], ['- > ', '  > ']];

const shapes = [];
for (const [first, rest] of hosts) {
  for (const owner of owners) {
    for (const blank of [false, true]) {
      for (const indent of ['', '  ', '    ']) {
        for (const follower of followers) {
          const body = [...owner, ...(blank ? [''] : []), indent + '+',
            ...follower.map((line) => indent + line)];
          let source = body
            .map((line, i) => ((i === 0 ? first : rest) + line).replace(/\s+$/, ''))
            .join('\n') + '\n';
          if (owner[0].startsWith('[^a]')) source += '\nr[^a]\n';
          shapes.push(source);
        }
      }
    }
  }
}

const failures = [];
const errored = new Set();
for (const source of shapes) {
  if (!parser.parse(source).rootNode.hasError) continue;
  errored.add(source);
  if (!KNOWN.has(source)) failures.push(`error tree: ${JSON.stringify(source)}`);
}
for (const source of KNOWN) {
  if (!errored.has(source)) failures.push(`now clean, drop it from KNOWN: ${JSON.stringify(source)}`);
}

const corpus = new URL('../test/corpus/', import.meta.url);
for (const name of readdirSync(corpus)) {
  const text = readFileSync(new URL(name, corpus), 'utf8');
  for (const [, title, expected] of text.matchAll(/^=+\n(.*)\n=+\n[\s\S]*?\n-{3,}\n([\s\S]*?)(?=\n=+\n|(?![\s\S]))/gm)) {
    if (/\((ERROR|MISSING)\b/.test(expected)) {
      failures.push(`test/corpus/${name}: "${title}" expects an error tree`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`${failures.length} problem(s) over ${shapes.length} shapes`);
  process.exit(1);
}
console.log(`${shapes.length} shapes: ${errored.size} known error tree(s), no new ones`);
