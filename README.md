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

## Browser use

Each release ships `tree-sitter-carve.wasm` in the npm package and as a GitHub
release asset. Copy that file to a URL served by your application, then load it
with `web-tree-sitter`:

```js
import { Language, Parser, Query } from "web-tree-sitter";

await Parser.init();
const carve = await Language.load("/parsers/tree-sitter-carve.wasm");
const parser = new Parser();
parser.setLanguage(carve);

const tree = parser.parse("# Hello");
const highlights = await fetch("/queries/carve-highlights.scm").then(
  (response) => response.text(),
);
const query = new Query(carve, highlights);
const captures = query.captures(tree.rootNode);
```

The npm copy is at
`node_modules/tree-sitter-carve/tree-sitter-carve.wasm`. The matching release
asset includes a `.sha256` checksum. Highlight and injection queries are in the
package's `queries/` directory.

CI tests this grammar with `web-tree-sitter` 0.22.6 and 0.27.0. Version 0.22.6
uses the older default `Parser` export and `language.query(...)` API; the
example above uses the 0.27.0 API.

## Development

Contributor setup, corpus checks, generated-artifact hygiene, and maintenance
notes are in the [development guide](docs/development.md).
