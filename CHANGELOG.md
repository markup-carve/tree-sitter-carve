# Changelog

All notable changes to tree-sitter-carve are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
