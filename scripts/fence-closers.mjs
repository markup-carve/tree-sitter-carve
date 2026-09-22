#!/usr/bin/env node
// Every fence below is CLOSED, so every code_block and raw_block in its tree
// must carry its end marker.
//
// A fence that loses its closer is not an ERROR: the closer line reads as
// inline verbatim in a paragraph and the tree is clean, so the no-error sweep
// cannot see it. A quoted closer was lost that way whenever the quote ended
// after it - the commonest spelling there is - with every other check green
// (#417). The documents are generated from a fixed vocabulary, so a failure
// names its shape and is reproducible.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrees } from './parse-batched.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where the fence sits: the prefix of every one of its lines.
const HOSTS = ['', '> ', '> > ', '- ', '> - '];
// The fence itself: opener, body, closer.
const FENCES = [
  ['```', 'x', '```'],
  ['~~~', 'x', '~~~'],
  ['````', '```', '````'],
  ['```=html', '<b>', '```'],
];
// What follows the closer.
const TAILS = ['', '\ny', 'y', '# H', '\n\n', '>\n> y', '> y', '- z'];
// A literal, so a shrunken vocabulary fails instead of passing smaller.
const EXPECTED_DOCUMENTS = 160;

const work = mkdtempSync(path.join(tmpdir(), 'carve-fence-closers-'));
const shapeOf = new Map();
for (const host of HOSTS) {
  for (const [open, body, close] of FENCES) {
    for (const tail of TAILS) {
      // A list item continues at its content column, so its body lines are
      // indented to it; a quoted item carries both.
      const cont = host === '- ' ? '  ' : host === '> - ' ? '>   ' : host;
      const lines = [host + open, cont + body, cont + close];
      const file = path.join(work, `f${shapeOf.size}.crv`);
      writeFileSync(file, `${lines.join('\n')}\n${tail}${tail ? '\n' : ''}`);
      shapeOf.set(file, `${JSON.stringify(host)} ${JSON.stringify(open)} then ${JSON.stringify(tail)}`);
    }
  }
}
if (shapeOf.size !== EXPECTED_DOCUMENTS) {
  console.error(
    `fence-closers: generated ${shapeOf.size} documents, expected ${EXPECTED_DOCUMENTS}.`,
  );
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

const files = [...shapeOf.keys()];
const trees = parseTrees(files, repoRoot);
rmSync(work, { recursive: true, force: true });

const failures = [];
files.forEach((file, i) => {
  const shape = shapeOf.get(file);
  const tree = trees[i];
  const blocks = (tree.match(/\((code_block|raw_block) /g) ?? []).length;
  const ends = (tree.match(/\((code_block|raw_block)_marker_end /g) ?? []).length;
  if (/\((ERROR|MISSING)\b/.test(tree)) {
    failures.push(`${shape}: ERROR or MISSING in the tree`);
  } else if (blocks !== 1 || ends !== 1) {
    failures.push(`${shape}: ${blocks} fence block(s), ${ends} end marker(s)`);
  }
});

console.log(`fence-closers: parsed ${shapeOf.size} closed-fence document(s).`);
if (failures.length) {
  console.error('\nA closed fence lost its closer:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('fence-closers: OK (every closed fence keeps its end marker).');
