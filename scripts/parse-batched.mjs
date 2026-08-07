// Batched `tree-sitter parse` invocations.
//
// Passing every corpus file in ONE invocation stops working once the corpus is
// large enough. At 830 documents the absolute paths come to ~138 kB of argv and
// the CLI exits 249 with empty stdout AND empty stderr - so a caller reading
// stdout sees "no failures" and a caller counting trees sees zero. Both are the
// same silent cliff, and it moves with every spec bump rather than with any one
// document, so it cannot be fixed by editing a fixture.
//
// `no-error-sweep.mjs` already batched for the same reason. These two helpers
// are that lesson applied to the remaining call sites, in one place, so the next
// corpus growth spurt does not re-open it a third time.

import { spawnSync } from 'node:child_process';

const BATCH = 200;

function run(args, repoRoot) {
  const result = spawnSync('npx', ['tree-sitter', 'parse', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`Failed to run tree-sitter parse: ${result.error.message}`);
    process.exit(2);
  }
  return result;
}

// `--quiet`: the CLI prints one line per file whose tree has an error and is
// silent otherwise. Returns those lines across every batch.
//
// A batch that exits non-zero with no per-file output means the invocation
// itself failed (parser not loaded, bad path, the argv cliff above) - that must
// be a hard error, never a silent pass.
export function parseQuiet(files, repoRoot) {
  const failures = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const result = run(['--quiet', ...batch], repoRoot);
    const lines = (result.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0 && result.status !== 0) {
      console.error(
        `tree-sitter parse exited with status ${result.status} but produced no ` +
          `per-file output for files ${i + 1}-${i + batch.length}; the parse ` +
          'invocation failed.',
      );
      if (result.stderr) console.error(result.stderr.toString().trim());
      process.exit(2);
    }
    failures.push(...lines);
  }
  return failures;
}

// The full parse: one `(document ...)` per input, in input order. Returns the
// trees concatenated across batches, so a caller can keep indexing them against
// its own file list.
export function parseTrees(files, repoRoot) {
  const trees = [];
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const result = run(batch, repoRoot);
    const perFile = (result.stdout || '')
      .split(/^(?=\(document )/m)
      .filter((t) => t.trim());
    if (perFile.length !== batch.length) {
      console.error(
        `Expected ${batch.length} parse trees for files ${i + 1}-${i + batch.length}, ` +
          `got ${perFile.length}; the tree-sitter output format changed and this ` +
          'check cannot be trusted.',
      );
      if (result.stderr) console.error(result.stderr.toString().trim());
      process.exit(2);
    }
    trees.push(...perFile);
  }
  return trees;
}
