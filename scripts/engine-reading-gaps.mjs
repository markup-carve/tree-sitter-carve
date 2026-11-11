// Engine readings the grammar does not build yet, for the boundary scripts that
// compare each source with carve-js. A comparison on a source recorded in
// test/engine-reading-gaps.json may fail; an unrecorded failure fails the run,
// and so does a recorded source that now matches or is no longer checked.
// Grammar-only assertions (ERROR nodes, incremental edits) stay outside it.
//
// Re-measure with UPDATE_ENGINE_READING_GAPS=1 and read the diff: it records
// every failing source of the script under the script's reason.
import { readFileSync, writeFileSync } from 'node:fs';
import { AssertionError } from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ledgerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'engine-reading-gaps.json');

export function engineReadingGaps(script) {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const entry = ledger.scripts[script] ?? { reason: '', sources: [] };
  const recorded = new Set(entry.sources);
  const failed = new Set();
  const seen = new Set();
  const unexpected = new Map();
  const update = process.env.UPDATE_ENGINE_READING_GAPS === '1';
  return {
    compare(key, engineCheck, grammarCheck = () => {}) {
      seen.add(key);
      try {
        engineCheck();
      } catch (error) {
        if (!(error instanceof AssertionError)) throw error;
        grammarCheck();
        failed.add(key);
        if (!recorded.has(key) && !unexpected.has(key)) unexpected.set(key, error);
      }
    },
    finish() {
      if (update) {
        ledger.scripts[script] = { reason: entry.reason, sources: [...failed] };
        writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
        console.log(`${script}: recorded ${failed.size} engine reading gap(s).`);
        return;
      }
      const stale = [...recorded].filter((key) => !failed.has(key));
      console.log(`${script}: ${failed.size} recorded engine reading gap(s) (${entry.reason ? 'reason on file' : 'no reason'}).`);
      if (!unexpected.size && !stale.length) return;
      if (unexpected.size) {
        console.error(`\n${script}: the grammar reads these sources differently from carve-js:`);
        for (const error of unexpected.values()) console.error(`  - ${error.message.split('\n')[0]}`);
        console.error(`First failure in full:\n${[...unexpected.values()][0].message}`);
      }
      if (stale.length) {
        console.error(`\n${script}: recorded gaps that now match carve-js or are no longer checked; remove them from test/engine-reading-gaps.json:`);
        for (const key of stale) console.error(`  - ${JSON.stringify(key)}${seen.has(key) ? '' : ' (not checked)'}`);
      }
      process.exit(1);
    },
  };
}
