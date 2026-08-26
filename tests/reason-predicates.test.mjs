import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateReasonPredicates } from '../scripts/reason-predicates.mjs';

test('a correctly filed document satisfies its reason', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'carve-reason-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '1-fence.crv'), '- ```\nx\n');
  const coverage = {
    reasons: { fence: 'marker-line fence' },
    reasonPredicates: { fence: { ledger: 'underAcceptance', sourcePattern: '^[-*+] [`~:]' } },
    underAcceptance: { fence: { reason: 'ref:fence' } },
  };
  assert.deepEqual(validateReasonPredicates({ coverage, corpusDir: dir }), []);
});

test('the misfiling from #273 fails even while the document still diverges', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'carve-reason-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '1-link-destination-parentheses-balance-4.crv'), '[t](url\nmore)\n');
  const coverage = {
    reasons: { column: 'a column probe is stranded' },
    reasonPredicates: {
      column: { ledger: 'lineTerminatorGaps', sourcePattern: '(^[ \\t]+\\S|^> |\\||```|\\{)' },
    },
    lineTerminatorGaps: {
      'link-destination-parentheses-balance-4': { reason: 'ref:column' },
    },
  };
  const errors = validateReasonPredicates({ coverage, corpusDir: dir });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not satisfy its source predicate/);
});

test('ledger mismatch, missing predicates and orphan predicates fail', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'carve-reason-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '1-a.crv'), 'x\n');
  const coverage = {
    reasons: { wrong: 'x', missing: 'x' },
    reasonPredicates: {
      wrong: { ledger: 'skip', sourcePattern: 'x' },
      orphan: { ledger: 'underAcceptance', sourcePattern: 'x' },
    },
    underAcceptance: {
      a: { reason: 'ref:wrong' },
      'a-2': { reason: 'ref:missing' },
    },
  };
  const errors = validateReasonPredicates({ coverage, corpusDir: dir });
  assert(errors.some((error) => error.includes('only admits the skip ledger')));
  assert(errors.some((error) => error.includes('has no document predicate')));
  assert(errors.some((error) => error.includes('has no shared reason')));
});
