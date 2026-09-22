import assert from 'node:assert/strict';
import test from 'node:test';
import { reading } from '../scripts/inline-reading-lib.mjs';

// Trees are `tree-sitter parse` output for each source, captured from this
// grammar, so the cases need no build to run.
const nested = {
  source: "a ![t[z]](/i.png) b\n",
  tree: "(document [0, 0] - [1, 0]\n  (paragraph [0, 0] - [1, 0]))\n",
};
const plainImage = {
  source: "a ![t](/i.png) b\n",
  tree: "(document [0, 0] - [1, 0]\n  (paragraph [0, 0] - [1, 0]\n    (inline_image [0, 2] - [0, 14]\n      description: (image_description [0, 2] - [0, 6])\n      destination: (inline_link_destination [0, 6] - [0, 14]))))\n",
};
const altWithCode = {
  source: "a ![t`]`z](/i.png) b\n",
  tree: "(document [0, 0] - [1, 0]\n  (paragraph [0, 0] - [1, 0]\n    (inline_image [0, 2] - [0, 18]\n      description: (image_description [0, 2] - [0, 10]\n        (verbatim [0, 5] - [0, 8]\n          begin_marker: (verbatim_marker_begin [0, 5] - [0, 6])\n          content: (content [0, 6] - [0, 7])\n          end_marker: (verbatim_marker_end [0, 7] - [0, 8])))\n      destination: (inline_link_destination [0, 10] - [0, 18]))))\n",
};
const unresolved = {
  source: "[bold]: /x\n\nsee [*bold*][]\n",
  tree: "(document [0, 0] - [3, 0]\n  (link_reference_definition [0, 0] - [1, 0]\n    label: (link_label [0, 1] - [0, 5])\n    destination: (link_destination [0, 8] - [0, 10]))\n  (paragraph [2, 0] - [3, 0]\n    (collapsed_reference_link [2, 4] - [2, 14]\n      text: (link_text [2, 4] - [2, 12]\n        (strong [2, 5] - [2, 11]\n          begin_marker: (strong_begin [2, 5] - [2, 6])\n          content: (content [2, 6] - [2, 10])\n          end_marker: (strong_end [2, 10] - [2, 11]))))))\n",
};
const escaped = {
  source: "[*bold*]: /x\n\nsee [\\*bold\\*][]\n",
  tree: "(document [0, 0] - [3, 0]\n  (link_reference_definition [0, 0] - [1, 0]\n    label: (link_label [0, 1] - [0, 7])\n    destination: (link_destination [0, 10] - [0, 12]))\n  (paragraph [2, 0] - [3, 0]\n    (collapsed_reference_link [2, 4] - [2, 16]\n      text: (link_text [2, 4] - [2, 14]\n        (backslash_escape [2, 5] - [2, 7])\n        (backslash_escape [2, 11] - [2, 13])))))\n",
};
// tree-sitter-carve#320 row 6: a comment-only line read across an open code
// span inside a line block.
const commentOnlyLineInSpan = {
  source: "::: |\na `b\n%% secret\nc\n:::\n",
  tree: "(document [0, 0] - [5, 0]\n  (div [0, 0] - [5, 0]\n    (div_marker_begin [0, 0] - [0, 4])\n    line_block_marker: (line_block_marker [0, 4] - [0, 5])\n    content: (content [1, 0] - [4, 0]\n      (paragraph [1, 0] - [4, 0]\n        (verbatim [1, 2] - [3, 1]\n          begin_marker: (verbatim_marker_begin [1, 2] - [1, 3])\n          content: (content [1, 3] - [3, 1]\n            (comment_line [1, 4] - [2, 9]))\n          end_marker: (verbatim_marker_end [3, 1] - [3, 1]))))\n    (div_marker_end [4, 0] - [4, 3])))\n",
};
// The general rule survives beside it: a line that merely CONTAINS a comment
// (something precedes the `%%`) keeps every character, comment included.
const commentBesideContentInSpan = {
  source: "::: |\na `b\nx %% secret\nc\n:::\n",
  tree: "(document [0, 0] - [5, 0]\n  (div [0, 0] - [5, 0]\n    (div_marker_begin [0, 0] - [0, 4])\n    line_block_marker: (line_block_marker [0, 4] - [0, 5])\n    content: (content [1, 0] - [4, 0]\n      (paragraph [1, 0] - [4, 0]\n        (verbatim [1, 2] - [3, 1]\n          begin_marker: (verbatim_marker_begin [1, 2] - [1, 3])\n          content: (content [1, 3] - [3, 1])\n          end_marker: (verbatim_marker_end [3, 1] - [3, 1]))))\n    (div_marker_end [4, 0] - [4, 3])))\n",
};

test('an image the tree does not build fails on its alt text', () => {
  const html = '<p>a <img src="/i.png" alt="t[z]"> b</p>';
  assert.equal(reading(html, nested.tree, nested.source), 'alt html=1 tree=0');
});

test('an alt text that covers different text fails', () => {
  const html = '<p>a <img src="/i.png" alt="t[z]"> b</p>';
  assert.equal(reading(html, plainImage.tree, plainImage.source), 'alt#1 html="tz" tree="t"');
});

test('a span inside an image description is compared as alt text, not as a span', () => {
  const html = '<p>a <img src="/i.png" alt="t`]`z"> b</p>';
  assert.equal(reading(html, altWithCode.tree, altWithCode.source), '');
});

test('a reference that does not resolve is not compared', () => {
  const html = '<p>see [*bold*][]</p>';
  assert.equal(reading(html, unresolved.tree, unresolved.source), '');
});

test('a reference that resolves is still compared', () => {
  const html = '<p>see <a href="/x"><strong>bold</strong></a></p>';
  assert.equal(reading(html, escaped.tree, escaped.source), 'strong html=1 tree=0');
});

test('a comment-only line inside an open span in a line block is subtracted', () => {
  const html =
    '<div class="line-block">\n  <p>a <code>b\n\nc</code></p>\n</div>';
  assert.equal(
    reading(html, commentOnlyLineInSpan.tree, commentOnlyLineInSpan.source),
    '',
  );
});

test('a comment beside content in the same span keeps every character', () => {
  const html =
    '<div class="line-block">\n  <p>a <code>b\nx %% secret\nc</code></p>\n</div>';
  assert.equal(
    reading(
      html,
      commentBesideContentInSpan.tree,
      commentBesideContentInSpan.source,
    ),
    '',
  );
});
