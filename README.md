# tree-sitter-carve

Tree-sitter grammar for [Carve](https://markup-carve.github.io/carve/), a
lightweight markup language for readable source and structured documents.

It provides editor-facing parsing, highlighting, and structural navigation for
Carve syntax, including:

- `/italic/`, `*bold*`, and `/*bold italic*/`
- `=highlight=`, plus the braced-only `{^superscript^}` and `{,subscript,}`
  (a bare `^` or `,` is literal text)
- `$` plus backtick math spans, and `$$` plus backtick display math spans
- `:name[content]` inline extensions, `@mentions`, `#tags`, and `:emoji:`
- `%%` line comments, trailing inline `%%` comments, and `%%%` fenced comments
- headings, lists, tables, fenced code, links, images, attributes, footnotes,
  captions, and divs

## Scope

This repository is the grammar layer, not the canonical parser or renderer. It
aims to produce useful, error-free syntax trees for the covered Carve corpus.
The [Carve specification](https://markup-carve.github.io/carve/) defines the
language; engine conformance and rendered output are checked in their
respective implementation repositories.

The grammar is intentionally explicit about unsupported corpus categories.
`test/coverage.json` records each category as covered or skipped with a reason,
so new syntax cannot silently fall outside the checks.

## Development

Contributor setup, corpus checks, generated-artifact hygiene, and maintenance
notes are in the [development guide](docs/development.md).
