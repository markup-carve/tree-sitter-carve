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

## Development

```bash
git clone --recurse-submodules https://github.com/markup-carve/tree-sitter-carve
npm install
npm run generate
npm test
```

If you cloned without `--recurse-submodules`, fetch the shared spec corpus with
`git submodule update --init`.

### Shared-corpus conformance

The canonical Carve spec corpus is vendored as a git submodule at `spec/`
(`spec/tests/corpus/NN-slug.crv`). Two checks run it against this grammar:

```bash
npm run test:coverage    # every spec category is classified (covered or skip)
npm run test:conformance # every covered category parses with no ERROR/MISSING
npm run test:corpus      # both, in order
```

`test/coverage.json` is the coverage matrix. A category is `covered` when the
grammar parses every one of its corpus inputs cleanly; otherwise it is listed in
`skip` with a reason recording the unmodeled construct. Adding a new spec
category (after bumping the submodule) fails `test:coverage` until it is
classified, which is intentional: it forces a decision rather than silently
dropping coverage.

## Status

Initial grammar. It is intended for editor support and structural parsing. The
Carve conformance corpus remains the source of truth for renderer behavior.
