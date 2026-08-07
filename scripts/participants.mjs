// A runner must know how many things it compared, and say so when that number
// is not what it should be.
//
// markup-carve/carve#755 collects the recurring shape: a check that reports
// success without having verified anything. This repository is in that catalog
// twice already - markup-carve/tree-sitter-carve#38 and #60, both about
// over-acceptance being invisible - and the sweep that followed found four
// runners here that exit 0 over an empty population, measured by emptying it.
//
// The variant that bites hardest here is the one the ticket names fourth: a gate
// whose ability to fail depends on there being something already wrong. Three of
// this repository's runners decide "clean run" by reconciling against a recorded
// ledger in test/coverage.json, so an empty population reads as a pass the
// moment that ledger is empty - and empty is the state every one of those
// ledgers is trying to reach. `batteryDisagreements` and
// `invisibleOverAcceptance` are at zero today.
//
// The wording is carve's scripts/spec/participants.mjs, unaltered on purpose.

/**
 * @param {{label: string, actual: number, atLeast: number, of?: string, hint?: string}} spec
 * @returns {string | null} a finding, or null when the count is sufficient
 */
export function shortfall({ label, actual, atLeast, of, hint }) {
  if (!Number.isInteger(actual) || actual < 0) {
    return `${label}: participant count is ${actual}, which is not a count at all`;
  }
  if (actual >= atLeast) return null;
  const subject = of ? ` ${of}` : '';
  const because = hint ? ` ${hint}` : '';

  return (
    `${label}: compared ${actual}${subject} but expected at least ${atLeast}. ` +
    `A run over fewer than it should have is not a pass - it is a smaller ` +
    `question answered.${because}`
  );
}

/**
 * Print a shortfall and exit, or return so the caller carries on.
 *
 * Every runner here reports through stdout and `process.exit`, so the guard is
 * one line at each call site rather than five copies of the same three.
 */
export function refuseShortRun(spec) {
  const finding = shortfall(spec);
  if (!finding) return;
  console.error(finding);
  process.exit(2);
}
