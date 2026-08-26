import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const slugOf = (name) => name.replace(/^\d+-/, '').replace(/\.crv$/, '');
const baseCategory = (name) => name.replace(/-[0-9]+$/, '');

export function validateReasonPredicates({ coverage, corpusDir }) {
  const errors = [];
  const reasons = coverage.reasons ?? {};
  const predicates = coverage.reasonPredicates ?? {};
  const files = readdirSync(corpusDir).filter((name) => name.endsWith('.crv'));
  const references = [];
  const ledgers = {
    skip: coverage.skip ?? {},
    overAcceptance: coverage.overAcceptance ?? {},
    invisibleOverAcceptance: coverage.invisibleOverAcceptance ?? {},
    underAcceptance: coverage.underAcceptance ?? {},
    lineTerminatorGaps: coverage.lineTerminatorGaps ?? {},
  };

  for (const [ledgerName, ledger] of Object.entries(ledgers)) {
    for (const [key, entry] of Object.entries(ledger)) {
      const text = typeof entry === 'string' ? entry : (entry.reason ?? '');
      if (text.startsWith('ref:')) references.push({ ledgerName, key, reason: text.slice(4) });
    }
  }

  for (const { ledgerName, key, reason } of references) {
    const predicate = predicates[reason];
    if (!predicate) {
      errors.push(`reason "${reason}" has no document predicate.`);
      continue;
    }
    if (predicate.ledger !== ledgerName) {
      errors.push(
        `${ledgerName}["${key}"] cites reason "${reason}", whose predicate only ` +
          `admits the ${predicate.ledger} ledger.`,
      );
      continue;
    }
    let regex;
    try {
      regex = new RegExp(predicate.sourcePattern, 'mu');
    } catch (error) {
      errors.push(`reason "${reason}" has an invalid sourcePattern: ${error.message}`);
      continue;
    }
    const matching = files.filter((file) => {
      const slug = slugOf(file);
      // Only `skip` permits category keys. The measurement ledgers name one
      // exact document, including the unsuffixed first example.
      return slug === key || (ledgerName === 'skip' && baseCategory(slug) === key);
    });
    if (matching.length === 0) {
      errors.push(`${ledgerName}["${key}"] has no corpus document to check.`);
      continue;
    }
    for (const file of matching) {
      const source = readFileSync(path.join(corpusDir, file), 'utf8');
      if (!regex.test(source)) {
        errors.push(
          `${ledgerName}["${key}"] cites reason "${reason}", but ${file} does ` +
            `not satisfy its source predicate ${JSON.stringify(predicate.sourcePattern)}.`,
        );
      }
    }
  }

  for (const reason of Object.keys(predicates)) {
    if (!(reason in reasons)) errors.push(`predicate "${reason}" has no shared reason.`);
    if (!references.some((reference) => reference.reason === reason)) {
      errors.push(`predicate "${reason}" is referenced by no ledger entry.`);
    }
  }
  return errors;
}
