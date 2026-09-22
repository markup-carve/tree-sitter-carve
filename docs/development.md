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

## Measuring a change

A reading taken from a stale artifact is the most common wrong answer here.

- `tree-sitter parse` shares ONE `carve.so` across every checkout on the machine
  (`~/.cache/tree-sitter/lib/`) and rebuilds it only when `src/parser.c` is
  newer. Export `TREE_SITTER_LIBDIR` to a directory of your own and delete the
  cached library between builds. `test:line-terminators` forks workers, so a
  shared library can have one run comparing two different grammars.
- `node-gyp-build` does NOT rebuild after a `src/parser.c` change. It serves the
  existing `build/Release/*.node`, so `test:binding-parity`, `test:highlights`,
  `test:marker-separators` and `test:nesting-depth` answer for the previous
  grammar. `npx node-gyp build` rebuilds it.
- A failed `tree-sitter generate` leaves `src/parser.c` in place, so read its
  exit status before reading any number.
- A `prec.dynamic` value is stored as `int16_t`, so anything past 32767 wraps
  in `src/parser.c` and `tree-sitter generate` still succeeds. The only sign is
  a `-Woverflow` warning when the file is compiled, and
  `npm run test:parser-warnings` fails on one.

## What the gates cannot see

`test:inline-reading` compares inline spans, so a change that moves none of them
is invisible to it however wrong the tree is.

- `alias()` over an inline `seq` renames each CHILD rather than wrapping them:
  `alias(seq($._a, $._b), $.cell)` builds two `cell` nodes. Alias a named hidden
  rule instead. A table row read one attributed cell as two with every gate green.
- An over-acceptance inside a run the fixture renders literally builds no inline
  span either way. `test:conformance` reports it only when it becomes an ERROR.

## A gate that looks redundant and is not

`test:conformance` counts over-acceptance twice: once over single-paragraph
documents, and once as INVISIBLE over-acceptance, where a node that renders
nothing covers text the fixture still shows. The second looks like a subset of
the first and is not. It is the only check that can see a
`link_reference_definition`, a footnote definition or a comment swallowing text
that the document still displays, because a node producing no output moves no
inline span and changes no over-acceptance count.

It has caught defects no other gate could twice: a stray
`link_reference_definition` in a description body, and four documents where a
definition opened against a content column that a folded marker had set. In
both cases `test:inline-reading` and `test:under-acceptance` were green.

Do not fold it into the count beside it.

Its mirror runs beside it: INVISIBLE UNDER-ACCEPTANCE, a reference definition
the fixture hides that the tree keeps as paragraph text. A definition renders
nothing, so the only trace of the miss is the paragraph that holds its source,
and no other gate reads paragraph text. It started with 54 recorded documents,
every one of them green on every other gate (#372).
