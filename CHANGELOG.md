# Changelog

All notable changes to tree-sitter-carve are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **A heading ends at the newline.** `_heading_content` is one inline line and
  the `_heading_continuation` external token is gone: a plain line after a
  heading is its own paragraph, and a same-count `#` line is a second heading
  rather than a continuation (carve#434, carve#451, grammar PART 2 SINGLE-LINE
  HEADINGS). The scanner closes the open heading block on any following line,
  whatever it holds.

## [0.1.1] - 2026-07-27

### Added

- Grammar node for the inline literal `` !`…` `` prefix, so a bang-prefixed
  verbatim span highlights as a distinct construct.

## [0.1.0] - 2026-07-15

### Added

- Initial tree-sitter grammar for Carve (grammar root for helix, zed, and
  vim-treesitter).
