// Time limits for every `tree-sitter parse` this repository spawns.
//
// A 14-byte document can hold the parser forever: `{~a` followed by a fence,
// with lone CR line terminators, ran for four hours at 9.6 GB RSS before it was
// killed by hand (markup-carve/tree-sitter-carve#321). Nothing here bounded it,
// so the run took the machine down with it rather than failing.
//
// Two limits, because one does not cover the other:
//
//   - `--timeout` makes the CLI abandon a single document. It is per-file, so a
//     batch carries on to the next one.
//   - the spawn timeout kills a CLI that wedges somewhere the parser's own
//     timeout is never consulted.
//
// THE TRAP: a document the CLI abandons prints NOTHING - no tree, no `--quiet`
// line, no stderr, and the exit status is the same 1 that an ordinary parse
// failure gives. Three files in, two trees out, and nobody named the third.
// Every caller here reconciles counts or parses stdout, so a dropped file reads
// as a clean answer to a smaller question. `namePathological` exists to turn
// that silence back into a filename.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Generous against a real document (the corpus parses in single-digit ms) and
// short enough that a batch of 400 pathological ones cannot outlive a CI job.
export const PARSE_TIMEOUT_US = 5_000_000;

export const TIMEOUT_ARGS = ['--timeout', String(PARSE_TIMEOUT_US)];

// The CLI stops each file on its own; this only has to outlast the whole batch
// doing that, plus process start-up.
export function spawnBudgetMs(fileCount) {
  return 30_000 + fileCount * (PARSE_TIMEOUT_US / 1000);
}

// Prefer the installed binary over `npx`. `npx` is a parent process: a spawn
// timeout kills IT and leaves the real `tree-sitter` running with no parent -
// which is how four orphaned parses survived the session that started them.
export function resolveCli(repoRoot) {
  const local = path.join(repoRoot, 'node_modules', '.bin', 'tree-sitter');
  return existsSync(local) ? [local, []] : ['npx', ['tree-sitter']];
}

/**
 * Parse one document under both limits, and report how long it took.
 *
 * @returns {{run: import('node:child_process').SpawnSyncReturns<string>, elapsedMs: number}}
 */
export function parseOnce(file, repoRoot) {
  const [cli, cliArgs] = resolveCli(repoRoot);
  const startedAt = Date.now();
  const run = spawnSync(cli, [...cliArgs, 'parse', '--quiet', ...TIMEOUT_ARGS, file], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: spawnBudgetMs(1),
    maxBuffer: 16 * 1024 * 1024,
  });
  return { run, elapsedMs: Date.now() - startedAt };
}

/**
 * Did the CLI give up on this document?
 *
 * SPENDING THE BUDGET IS THE ANSWER, not the exit status and not the silence.
 * Both of those turned out to be platform-dependent: the same abandoned parse
 * that exits non-zero with empty output here exits in a way that looks ordinary
 * on the CI runner, which passed a document the ledger records as hanging. A
 * document the parser can finish takes single-digit milliseconds, so burning
 * the whole limit means one thing wherever it happens.
 */
export function didNotFinish({ run, elapsedMs }) {
  if (run.signal) return true;
  if (run.error && run.error.code === 'ETIMEDOUT') return true;
  if (elapsedMs >= (PARSE_TIMEOUT_US / 1000) * 0.9) return true;
  // Kept as a second reading for a CLI that gives up early: a tree with an
  // ERROR still prints its `--quiet` line, so silence plus non-zero is a
  // parse that produced nothing at all.
  const silent = !(run.stdout || '').trim() && !(run.stderr || '').trim();
  return run.status !== 0 && silent;
}

/**
 * Re-parse `files` one at a time and return those the CLI could not finish.
 *
 * Only worth calling once a batch has already reported trouble - it pays a
 * process per file to convert "something in this batch vanished" into names.
 *
 * @returns {string[]} paths whose parse hit the limit
 */
export function namePathological(files, repoRoot) {
  return files.filter((file) => didNotFinish(parseOnce(file, repoRoot)));
}

/**
 * Print the pathological files a batch swallowed and exit, or return.
 *
 * @param {{files: string[], repoRoot: string, label: string, onExit?: () => void}} spec
 */
export function refuseUnfinishedParse({ files, repoRoot, label, onExit }) {
  const stuck = namePathological(files, repoRoot);
  if (stuck.length === 0) return;
  console.error(
    `${label}: ${stuck.length} document(s) did not finish parsing within ` +
      `${PARSE_TIMEOUT_US / 1_000_000}s and were dropped from the output ` +
      'silently. A run that lost documents is not a pass:',
  );
  for (const f of stuck) console.error(`  ${f}`);
  if (onExit) onExit();
  process.exit(2);
}
