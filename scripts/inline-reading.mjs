#!/usr/bin/env node
// THE INLINE COUNTERPART OF THE OVER-ACCEPTANCE SCAN.
//
// `corpus-conformance` asserts that a covered document builds no ERROR and no
// MISSING node, and `under-acceptance` asks whether the BLOCK the language
// builds is there. Neither asks about inline structure, so a category whose
// every document builds the wrong spans reported as `covered`: a wrong reading
// is a perfectly clean tree (tree-sitter-carve#307).
//
// The expected fixture names each inline construct the language builds and the
// text it covers. Each tracked tag is paired, in document order, with the node
// of the matching type, and two things are compared: how many there are, and
// the alphanumeric SKELETON of what each covers. Markers, smart typography,
// dashes, escapes and entities are all non-alphanumeric, so they drop out; a
// span that stops early, runs long or swallows its neighbour does not.
//
// The skeleton is what makes this more than a count. A count-only version of
// this check dropped `01-emphasis-13` as fixed once its span count matched,
// while its first emphasis still stopped at the wrong slash, and could not see
// a delete that grew to swallow the word beside it.
//
// What it still cannot see: the ORDER of two sibling spans of different kinds,
// and any shape the corpus does not contain. `sup` and `sub` are left out: a
// footnote reference renders a superscript only once it resolves, which no
// grammar models (#322).
//
// Two places render inline content the HTML cannot show as spans. An image's
// description renders flat into its `alt`, so it is compared as text instead.
// A reference link or image whose label no definition registers renders as the
// source the author typed, and whether it resolves is a question about the
// definition table rather than the parse, so its content is not compared
// (#320). The comparison itself is in inline-reading-lib.mjs.
//
// Known gaps are RECORDED, exact in three directions: a NEW divergence fails, a
// recorded one that has been FIXED fails, and one whose reading MOVES fails.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuseShortRun } from "./participants.mjs";
import { parseTrees } from "./parse-batched.mjs";
import { reading, TAGS } from "./inline-reading-lib.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const corpusDir = path.join(repoRoot, "spec", "tests", "corpus");
const coverage = JSON.parse(
  readFileSync(path.join(repoRoot, "test", "coverage.json"), "utf8"),
);

const slugOf = (name) => name.replace(/^\d+-/, "");
const covered = new Set(coverage.covered.map(slugOf));
const skip = new Set(Object.keys(coverage.skip).map(slugOf));
const baseCategory = (file) =>
  path.basename(file, ".crv").replace(/-[0-9]+$/, "");

const allFiles = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".crv"))
  .sort();

refuseShortRun({
  label: "CORPUS",
  actual: allFiles.length,
  atLeast: 1000,
  of: `document(s) under ${corpusDir}`,
  hint: "the spec corpus has ~1740; run `git submodule update --init`.",
});

const targets = [];
for (const file of allFiles) {
  const category = slugOf(baseCategory(file));
  const stem = slugOf(path.basename(file, ".crv"));
  if (skip.has(category) || skip.has(stem)) continue;
  if (covered.has(category)) targets.push(path.join(corpusDir, file));
}

// Documents whose reference reading cannot be represented by a contiguous tree
// node, or whose pinned fixture is known to be wrong. Name each one explicitly
// so no other document can fall through this exclusion.
const EXCLUDED = {
  "a-continuation-row-s-open-run-and-an-escaped-closing-pipe-5":
    "the open run is in the row's SECOND cell and continues in the continuation " +
    "row's second cell, which sits behind that row's FIRST cell. A node covers a " +
    "contiguous range, so no node can hold both halves without holding the cell " +
    "between them. The spec waives this document's text positions for carve-js, " +
    "carve-rs and carve-php as well (spec/resources/ast-position-waivers.txt).",
  "a-comment-only-line-in-a-line-block-is-removed-before-any-inline-run":
    "the reference removes the physical comment line before it reads inline " +
    "content, joining `b` and `c`. A tree node has one contiguous source range, " +
    "so it must either include the removed comment or omit one side of it.",
  "a-fence-opened-on-a-list-marker-line-body-below-the-content-column-7":
    "the fixture is wrong at the pinned 0.1.6 specification tag and clears with " +
    "the first post-release corpus-pin update (tree-sitter-carve#349).",
};

const recorded = coverage.inlineReadingGaps ?? {};
const trees = parseTrees(targets, repoRoot);

const found = {};
targets.forEach((file, i) => {
  const r = reading(
    readFileSync(file.replace(/\.crv$/, ".html"), "utf8"),
    trees[i],
    readFileSync(file, "utf8"),
  );
  if (r) found[slugOf(path.basename(file, ".crv"))] = r;
});

// An exclusion that stops excluding is a check that cannot fire: if the tree
// ever reads this document the way the reference does, the reason above is
// wrong and has to go rather than sit there passing.
const stale = Object.keys(EXCLUDED).filter((k) => !(k in found));
if (stale.length) {
  console.error(
    "\nExcluded reading now agrees with the tree. Remove its exclusion from " +
      "scripts/inline-reading.mjs:",
  );
  for (const k of stale) console.error(`  - ${k}`);
  process.exit(1);
}
for (const k of Object.keys(EXCLUDED)) delete found[k];

if (process.argv.includes("--dump")) {
  process.stdout.write(JSON.stringify(found, null, 1));
  process.exit(0);
}

console.log(
  `inline-reading: compared ${targets.length} covered document(s) by span count and ` +
    `covered text on ${TAGS.length} inline tag(s), sup/sub excluded; ` +
    `${Object.keys(found).length} divergent, ${Object.keys(recorded).length} recorded, ` +
    `${Object.keys(EXCLUDED).length} explicitly excluded.`,
);

const newly = Object.keys(found).filter((k) => !(k in recorded));
const fixed = Object.keys(recorded).filter((k) => !(k in found));
const moved = Object.keys(found)
  .filter((k) => k in recorded && recorded[k].reading !== found[k])
  .map((k) => `${k}: recorded ${recorded[k].reading}, now ${found[k]}`);

if (newly.length || fixed.length || moved.length) {
  if (newly.length) {
    console.error(
      "\nInline reading divergence (the tree reads these spans differently):",
    );
    for (const k of newly) console.error(`  - ${k}: ${found[k]}`);
  }
  if (fixed.length) {
    console.error(
      "\nRecorded divergence that no longer happens - remove these from " +
        "`inlineReadingGaps` in test/coverage.json:",
    );
    for (const k of fixed) console.error(`  - ${k}`);
  }
  if (moved.length) {
    console.error(
      "\nRecorded divergence whose reading MOVED - the grammar changed, so " +
        "update `reading` and the reason in test/coverage.json:",
    );
    for (const k of moved) console.error(`  - ${k}`);
  }
  process.exit(1);
}

console.log(
  "inline-reading: OK (every divergence is exactly the set recorded).",
);
