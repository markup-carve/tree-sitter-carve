# Changelog

All notable changes to tree-sitter-carve are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **A blank line separates two block quotes** (spec:
  `resources/grammar.ebnf`, whose lazy-continuation note states that a lazy line
  continues the quote only while it is "not blank (a blank line ends the
  blockquote)"). `> a` over a blank line over `> b` parsed as ONE quote holding
  both paragraphs, where carve-js renders two `<blockquote>` elements; the same
  merge applied to every shape of the family, including the empty forms `>` over
  blank over `>` and a nested `> > a` over blank over `> b`, where every open
  quote ends and not just the innermost. A whitespace-only line separates the
  same way an empty one does. A MARKED empty line is unaffected: `> a` over `>`
  over `> b` is still one quote, since that line is not blank (#129).

- **A second content-less block quote marker joins the same empty quote**
  (spec: `resources/grammar.ebnf`, `blockquote = blockquote_line,
  {blockquote_line | ...}` over `blockquote_line = '>', (newline | ...)`). The
  bare marker line repeats, so `>` over `>` is one empty quote, and carve-js
  renders a single empty `<blockquote>` for it. The grammar had nowhere to put
  the second marker - the continuation markers live inside
  `_block_quote_content`'s repeat, behind a first real block - so a paragraph's
  own leading prefix took it instead: an ERROR when nothing followed, and a
  swallowed sibling when something did. `>` over `>` over `x` is now a quote and
  a sibling paragraph, `>` over `>` over `- b` a quote and a sibling list, the
  same rule #96 applied to the single marker (#126).

- **An indented definition term marker is paragraph text.** `:: t` written at
  column 1 opened a definition list, at the top level and inside a div alike,
  where all three engines keep the line as prose. The term branch of the scanner
  never asked what column it was on, while the div branch beside it already
  documented the rule as one "the heading marker and the definition markers
  follow". A term at a container's content column still opens the list, and a
  term continuing an open list is measured against that list's own marker column
  (#109).

- **The colon-fence opener accepts the hard-break form** (spec:
  `resources/grammar.ebnf`, `local_hard_break_block_open = colon_fence:open,
  space, backslash`). `::: \` is the local hard-break block and renders as
  `<div class="hardbreaks">`, but the opener accepted only a bare fence, a
  `[label]`, or a line-block bar / class name after a separator, so the
  backslash reached no route to a `div` and the whole block folded into a
  paragraph. The separator is required (`:::\` glued is still paragraph text)
  and the backslash must be the last thing on the line apart from trailing
  spaces (`::: \ x` and `::: \\` are still paragraph text), matching carve-js.
  Because the opener and the paragraph-closing peek share one tail test, a
  hard-break fence now also interrupts an open paragraph.

- **A lazy colon fence ends the list item a malformed one was absorbed into**
  (spec: PART 9 §12 absorption, §24 C3 content column). The absorption a
  malformed `:::` leaves behind belongs to the paragraph, so it reaches only as
  far as the container that paragraph lives in. `- item` over a flush-left
  `:::note`, `body`, `:::`, `tail` is a one-item list plus a `div` holding
  `tail` in carve-js, carve-php and carve-rs alike: the closing fence sits
  below the item's content column, where the outer context is offered it first
  and nothing there is expecting a closer. The grammar folded all five lines
  into the item, at any fence width. A fence at the item's own content column
  is unaffected and still absorbs.

- **A content-less definition marker line ends the item above it** (spec:
  `docs/examples/core.md`, MARKER REQUIRES CONTENT, settled for definition
  markers in markup-carve/carve#788). `:: t` over `:: ` over `x` is a one-term
  `<dl>` followed by a paragraph holding both remaining lines; the marker line
  is paragraph text, and being paragraph text is exactly what makes it end the
  term. The grammar folded the whole thing into the term instead, so a document
  that closes a definition list looked like one that never left it. The
  description shape (`:  `) and a content-less marker after an open description
  behave the same. A BARE `::` carries no separator, is not marker-shaped, and
  still continues the term lazily, which is what every engine does with it. The
  shape-only rule is scoped to definition lists: inside a bullet item a
  content-less `:: ` line is still lazy text, and only a colon marker carrying
  content ends the item.

- **A malformed colon fence leaves the paragraph expecting a closer** (spec:
  PART 9 §12, normative since markup-carve/carve#778). A `:::` line that is not
  a valid opener - `::: {.x}`, `::: 123`, a glued `:::note` - is paragraph text,
  and from there a bare fence at ANY width is text too, so `::: {.x}` over
  `not a div` over `:::` is ONE paragraph rather than a paragraph plus an empty
  `div`. The decision whether a colon line ends an open paragraph counted the
  colons and stopped, while the opener applied a shape test the peek did not,
  so the paragraph was cut one line early and the closing fence was then read
  as a fresh opener. Both now ask the same predicate. A bare fence still
  interrupts an ordinary paragraph, a valid opener still interrupts one that
  absorbed a malformed fence, and a fence that closes an open div is still that
  closer. Four recorded over-acceptances close with it, and `text` over
  `:::note` is now the single paragraph every engine renders instead of two.

### Changed

- **A definition's marker-to-content separator is a space** (spec: U+0020 for
  all three definition markers, carve-rs is the reference). `[a]:	/url`,
  `[a]:/url`, a bare `[a]:` and `*[HTML]:	Hyper` are ordinary paragraphs
  now, not definitions. It is the FIRST character after the colon that has to be
  a space - `[a]: 	/url` is still a definition. Nine corpus documents parse
  differently and none newly errors; six of those are `abbreviation_marker` spans
  growing by the one space now inside the token. The footnote marker already
  refused a tab and is unchanged.

- **BREAKING: a heading ends at the newline** (spec markup-carve/carve#451).
  Nothing folds into a heading any more - neither a plain line nor a same-count
  `#` line - so `## A` over `## still A` is two headings, and `# Title` with
  prose beneath is a heading plus a paragraph. The `_heading_continuation`
  external token is gone with the rule; an open heading now closes at its own
  newline whatever follows it.

## [0.1.1] - 2026-07-27

### Added

- Grammar node for the inline literal `` !`…` `` prefix, so a bang-prefixed
  verbatim span highlights as a distinct construct.

## [0.1.0] - 2026-07-15

### Added

- Initial tree-sitter grammar for Carve (grammar root for helix, zed, and
  vim-treesitter).
