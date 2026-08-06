# Changelog

All notable changes to tree-sitter-carve are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

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
