# Specification and editor audit, September 30

The specification pin advances to
`b4f6a1edbe20a090dfbdb270324e8e207017b209`. Its corpus has 2,164 documents in
535 categories. This adds checks for braced spans crossing bracket-run
boundaries, inline constructs in container labels, and non-punctuation
backslashes in quoted values and titles. Those categories all parse without
ERROR or MISSING nodes, but clean trees do not establish correct structure.

## Measured gaps

| Check | Current result |
|---|---|
| Covered corpus | 2,156 clean documents; eight individually skipped documents |
| Block under-acceptance | 55 documents missing expected block structure |
| Inline reading | 45 documents with different span counts or text |
| Visible over-acceptance | Five documents gaining unexpected blocks |
| Invisible over-acceptance | Four documents hidden by unexpected definitions/comments |
| Hidden reference definitions | All 155 recognized in the covered corpus |
| Final newline removed, Node runtime 0.25.0 | Two otherwise-clean documents acquire errors |
| Line-ending equivalence | Two recorded divergences across LF, CRLF and CR |

These are exact recorded populations, with checks that also fail when a gap is
fixed and its entry becomes stale. The eight skips are continuation markers
attaching no block, one nested quoted-fence case and one nested link/span case.
The EOF fix in [#468](https://github.com/markup-carve/tree-sitter-carve/pull/468)
landed during the audit. After rebasing and rebuilding the native binding, the
latest corpus retains its two residual errors: multi-row tables attached by a
continuation marker, whose final row becomes a line block at EOF. The corpus
refresh adds no residuals. Editor runtimes and the pinned CLI have different
readings, so the Node result cannot be replaced with a clean CLI run.

## New boundary coverage

`[{+a]+}` must remain literal, but the scanner builds an insertion. The same
gap affects the other forced marks and substitution. Ten of the thirteen
bracket-boundary fixtures differ; complete markup inside a bracket and an
editorial comment containing a bracket remain controls.

The general inline comparison excludes superscript and subscript because
footnote resolution can invent superscript HTML. The new
[bracket-boundary check](../scripts/bracket-boundaries.mjs) measures them in
this fixture family, where no footnote can affect the answer. Its
[record](../test/bracket-boundaries.json) includes their two previously
unmeasured mismatches alongside the eight visible to the general check.

Container labels remain opaque `code_block_label` tokens. In the new label
family, insertion, deletion and code nodes are absent even though the expected
HTML contains them. Fixing this needs an inline label context that closes on
its own bracket while keeping comments and code opaque.

Other recorded gaps include block openers on list and footnote marker lines,
fences after quotes, nested definition terms in description bodies, multiline
image titles and emphasis spanning link boundaries. Many are already tracked
in [#459](https://github.com/markup-carve/tree-sitter-carve/issues/459).

## Added editor functionality

The shipped queries now fold block quotes, definition lists, tables, footnotes,
frontmatter and fenced comments. Text objects select definition terms and
bodies, inline extension content, and the bodies of braced, editorial and fenced
comments. Context queries include divs and block quotes.

The [query test](../scripts/editor-queries.mjs) loads the shipped files and
asserts actual node ranges, not just successful compilation. Both supported
Web Tree-sitter versions compile all seven query files against the rebuilt
WASM parser. Existing highlight priority checks still pass.

## Implementation priorities

Consumer-runtime EOF errors should be addressed before extending the accepted
syntax inventory: they occur while an author edits the last line. Next, bound
inline pairing to bracket runs even when those brackets become literal text.
Then repair marker-line block recognition and parse container labels as inline
content. Preserve scanner serialization, incremental binding parity, fence
closers and termination checks during those changes.

Generated-content resolution, include expansion and import conversion belong
to the engines. A syntax grammar can expose their authored markers and content;
it cannot establish their document-wide rendered behavior.
