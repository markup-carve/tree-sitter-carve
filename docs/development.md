# Development

## Setup and maintenance

```bash
git clone https://github.com/markup-carve/tree-sitter-carve
npm install
npm run generate
npm test
```

The grammar describes Carve 0.2. `npm test` runs the hand-written corpus in
`test/corpus/`; carve-js on its `main` branch is the reference for what a case
should parse to.

## Checks

```bash
npm run check-formatted        # grammar.js is prettier-formatted
npm run test:parser-warnings   # generated tables compile without -Woverflow
npm run test:final-terminator  # a missing final newline changes no tree
npm run test:editor-queries    # editor query captures and ranges
npm run test:marker-separators # marker runs stay out of content
npm run test:nesting-depth     # deep nesting through the Node binding
npm run test:binding-parity    # Node binding and CLI agree over the corpus
npm run test:asan              # corpus under AddressSanitizer
npm run build-wasm && npm run test:wasm
cargo test                     # Rust binding
```

## Measuring a change

A reading taken from a stale artifact is the most common wrong answer here.

- `tree-sitter parse` shares ONE `carve.so` across every checkout on the machine
  (`~/.cache/tree-sitter/lib/`) and rebuilds it only when `src/parser.c` is
  newer. Export `TREE_SITTER_LIBDIR` to a directory of your own and delete the
  cached library between builds.
- `node-gyp-build` does NOT rebuild after a `src/parser.c` change. It serves the
  existing `build/Release/*.node`, so `test:binding-parity`,
  `test:marker-separators` and `test:nesting-depth` answer for the previous
  grammar. `npx node-gyp build` rebuilds it.
- A failed `tree-sitter generate` leaves `src/parser.c` in place, so read its
  exit status before reading any number.
- A `prec.dynamic` value is stored as `int16_t`, so anything past 32767 wraps
  in `src/parser.c` and `tree-sitter generate` still succeeds. The only sign is
  a `-Woverflow` warning when the file is compiled, and
  `npm run test:parser-warnings` fails on one.

## Scanner cost on long lines

tree-sitter gives the external scanner no byte offset, and `get_column` rereads
the current line from its start whenever the lexer has moved since the last
read. So a reader that looks ahead from every opener, or asks for a column at
every token, costs time proportional to the paragraph or line times the number
of tokens.

- Closer and link-destination probes that find nothing are noted in the
  serialized state (`no_closer_kinds`, `link_tail_open_line`), and later openers
  in the same paragraph or line reuse the answer.
- `mid_line` records that the last external token ended mid-line, which spares
  the line-start test its column read.
- A pure alphanumeric word of 256 or more characters is one token.

Two costs remain:

- A single line of plain words with no inline markup pays one column read per
  whitespace token, so it is quadratic in the line length: about 5 s for a
  100 KB line on a loaded 16-core machine. The same text wrapped into ordinary
  lines is linear.
- Older runtimes, such as the 0.22 CLI this repository pins, reread the line
  on every `get_column`. There the column reads that each failed bare opener
  makes keep `*a *a ...` lines quadratic, at about a third of the old cost.

`MAX_NESTING_DEPTH` (200) caps container nesting, so the serialized state fits
the fixed 1024-byte buffer.
