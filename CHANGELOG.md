# Changelog

All notable changes to tree-sitter-carve are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

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
