// A runner must know how many things it compared, and say so when that number
// is not what it should be: a check over an empty population would otherwise
// report success without having verified anything (markup-carve/carve#755).
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
