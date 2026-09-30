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

test("parsed trailing comments do not contribute visible span text", () => {
  assert.equal(reading("<p><ins>a</ins></p>", "(document [0, 0] - [1, 0]\n(paragraph [0, 0] - [1, 0]\n(insert [0, 0] - [0, 15]\n(insert_begin [0, 0] - [0, 2]\n)\n(content [0, 2] - [0, 13]\n(trailing_comment [0, 3] - [0, 13]\n))\n(insert_end [0, 13] - [0, 15]\n))))", "{+a %% secret+}\n"), '');
});

test("a code span keeps comment-like text literal", () => {
  assert.equal(reading("<p><code>a %% secret</code></p>", "(document [0, 0] - [1, 0]\n(paragraph [0, 0] - [1, 0]\n(verbatim [0, 0] - [0, 13]\n(verbatim_marker_begin [0, 0] - [0, 1]\n)\n(content [0, 1] - [0, 12]\n)\n(verbatim_marker_end [0, 12] - [0, 13]\n))))", "`a %% secret`\n"), '');
});

test("code fence metadata does not contribute rendered spans", () => {
  assert.equal(reading("<pre><code>c\n</code></pre>", "(document [0, 0] - [3, 0]\n(code_block [0, 0] - [3, 0]\n(code_block_marker_begin [0, 0] - [0, 3]\n)\n(language [0, 4] - [0, 6]\n)\n(code_block_label [0, 7] - [0, 12]\n(emphasis [0, 8] - [0, 11]\n(emphasis_begin [0, 8] - [0, 9]\n)\n(content [0, 9] - [0, 10]\n)\n(emphasis_end [0, 10] - [0, 11]\n)))\n(code [1, 0] - [2, 0]\n)\n(code_block_marker_end [2, 0] - [2, 3]\n)))", "``` js [/i/]\nc\n```\n"), '');
});

test("container labels contribute rendered spans", () => {
  assert.equal(reading("<div><p class=\"div-label\"><em>i</em></p><p>body</p></div>", "(document [0, 0] - [3, 0]\n(div [0, 0] - [3, 0]\n(div_marker_begin [0, 0] - [0, 3]\n)\n(code_block_label [0, 3] - [0, 8]\n(emphasis [0, 4] - [0, 7]\n(emphasis_begin [0, 4] - [0, 5]\n)\n(content [0, 5] - [0, 6]\n)\n(emphasis_end [0, 6] - [0, 7]\n)))\n(content [1, 0] - [2, 0]\n(paragraph [1, 0] - [2, 0]\n))\n(div_marker_end [2, 0] - [2, 3]\n)))", ":::[/i/]\nbody\n:::\n"), '');
});

test('an unresolved image preserves a nonbreaking space in its literal source', () => {
  const source = '![\u00a0x][]\n';
  const tree = '(document [0, 0] - [1, 0]\n (paragraph [0, 0] - [1, 0]\n (collapsed_reference_image [0, 0] - [0, 8]\n description: (image_description [0, 0] - [0, 6]))))';
  assert.equal(reading('<p>![&nbsp;x][]</p>', tree, source), '');
  assert.equal(reading('<p><img src="x" alt="x"></p>', tree, source), '');
});
