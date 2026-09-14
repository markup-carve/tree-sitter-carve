# tree-sitter-carve

Tree-sitter grammar for [Carve](https://markup-carve.github.io/carve/), a
post-Markdown lightweight markup language with visual mnemonics.

This grammar is built from the proven Djot Tree-sitter scanner architecture and
changes the public syntax to Carve:

- `/italic/`, `*bold*`, and `/*bold italic*/`
- `=highlight=`, plus the braced-only `{^superscript^}` and `{,subscript,}`
  (a bare `^` or `,` is literal text)
- `$` + backtick math spans, and `$$` + backtick display math spans
- `:name[content]` inline extensions, `@mentions`, `#tags`, and `:emoji:`
- `%%` line comments, trailing inline `%%` comments, and `%%%` fenced comments
- Djot-style blocks retained where Carve keeps them: headings, lists, tables,
  fenced code, links, images, attributes, footnotes, captions, and divs

## Status

Initial grammar. It is intended for editor support and structural parsing. The
Carve conformance corpus remains the source of truth for renderer behavior.

## Development

Contributor setup, testing, and maintenance notes are in the [development guide](docs/development.md).
