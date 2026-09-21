// Does the parser finish?
//
// Every other check here asks what a tree says. None of them asks whether a
// tree arrives at all, and on 2026-09-21 that gap cost a workstation: four
// `tree-sitter parse` runs over a 14-byte document sat at 9.6 GB RSS each for
// four hours until they were killed by hand. The document is
// test/termination/braced-sub-fence-cr.crv and it is 14 bytes.
//
// The CLI's own `--timeout` bounds a run but reports the bound being hit by
// printing NOTHING - so non-termination reads to a caller as an empty answer,
// not as a failure. This runner is the one place that treats the silence as the
// finding.
//
// Reconciled against test/coverage.json `parseTimeouts` in the three directions
// the other ledgers here use: a NEW document that will not finish fails, a
// recorded one that now finishes fails so the record cannot rot, and a recorded
// name with no document behind it fails so the record cannot go stale either.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';
import { PARSE_TIMEOUT_US, didNotFinish, parseOnce } from './parse-limits.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(repoRoot, 'test', 'termination');
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, 'test', 'coverage.json'), 'utf8'),
);
const recorded = coverage.parseTimeouts ?? {};

const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.crv'))
      .sort()
  : [];

refuseShortRun({
  label: 'TERMINATION',
  actual: files.length,
  atLeast: 1,
  of: `document(s) under ${dir}`,
  hint: 'every recorded non-termination keeps its document here.',
});

const measured = files.map((file) => {
  const attempt = parseOnce(path.join(dir, file), repoRoot);
  if (attempt.run.error && attempt.run.error.code !== 'ETIMEDOUT') {
    console.error(`Failed to run tree-sitter parse: ${attempt.run.error.message}`);
    process.exit(2);
  }
  return { file, ...attempt, stuck: didNotFinish(attempt) };
});

const stuck = measured.filter((m) => m.stuck).map((m) => m.file);

// Printed for every document, because the reading that matters here is a
// duration and a verdict derived from it. A failure that shows neither cannot
// be diagnosed from a CI log.
for (const m of measured) {
  console.log(`  ${m.file}: ${m.elapsedMs}ms, ${m.stuck ? 'did NOT finish' : 'finished'}`);
}

const isNew = stuck.filter((f) => !(f in recorded));
const nowFixed = Object.keys(recorded).filter((f) => !stuck.includes(f));
const missing = Object.keys(recorded).filter((f) => !files.includes(f));

console.log(
  `termination: parsed ${files.length} document(s) with a ` +
    `${PARSE_TIMEOUT_US / 1_000_000}s limit; ${stuck.length} did not finish, ` +
    `${Object.keys(recorded).length} recorded.`,
);

const findings = [];
if (isNew.length) {
  findings.push(
    'Documents that no longer finish parsing and are NOT recorded in ' +
      'test/coverage.json `parseTimeouts`:',
    ...isNew.map((f) => `  ${f}`),
  );
}
if (nowFixed.length) {
  findings.push(
    'Recorded non-terminating documents that now parse. Remove them from ' +
      'test/coverage.json `parseTimeouts`:',
    ...nowFixed.map((f) => `  ${f} - ${recorded[f]}`),
  );
}
if (missing.length) {
  findings.push(
    'Recorded under `parseTimeouts` with no document under test/termination:',
    ...missing.map((f) => `  ${f}`),
  );
}

if (findings.length) {
  for (const line of findings) console.error(line);
  process.exit(1);
}

console.log('termination: OK (every non-terminating document is recorded exactly).');
