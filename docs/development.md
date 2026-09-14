# Development

## Setup and maintenance

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
