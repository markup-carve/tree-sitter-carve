# Nested, scoped and multiline rich markup work

The 35-family suite measures malformed `/*a` fragments inside strong, emphasis,
attributed spans and table cells, alongside multiline repetitions and growing
bracket, brace and attributed-span depth. Each family runs at 32, 64, 128 and 256
repetitions with LF, CRLF and CR endings: 420 full-parser cases.

Six families retain linear work: four plain paragraph families and growing
literal bracket and brace depth. The other 29 families still incur quadratic
scanner or runtime lexer work. Doubling from 128 to 256 repetitions gives these
representative advance counts with LF endings:

| Family | Scanner at 256 | Lexer at 256 | Scanner growth | Lexer growth |
| --- | ---: | ---: | ---: | ---: |
| Plain nested brackets | 47,053 | 59,073 | 2.01 | 2.01 |
| Bare strong, nested brackets | 372,366 | 5,975,727 | 3.57 | 3.95 |
| Forced emphasis, nested braces | 2,183,783 | 32,157,678 | 3.96 | 3.99 |
| Attributed span, nested braces | 766,480 | 28,968,235 | 3.78 | 3.98 |
| Multiline verbatim | 1,971,338 | 2,029,942 | 3.99 | 3.88 |
| Growing attributed depth | 237,704 | 736,542 | 3.86 | 3.92 |
| Growing literal bracket depth | 3,522 | 17,090 | 1.90 | 1.95 |

[Raw measurements](rich-markup-work.json) include the baseline commit, exact
families, runtime version, compiler flags, scanner/parser blob hashes and all
before/after observations. The baseline is `e677304`, after the flat-paragraph
column-rescan fix. Two nested-brace families produced errors on that baseline;
their previous work counts cannot establish a performance comparison with the
correct parse.

The new controls also fix correctness failures found during measurement.
Attributed-span qualification no longer stays active inside its content, where
it rejected literal nested braces. Bare formatting search stops at the owning
bracket. Formatting inside table cells retains its cell boundary, escaped
pipes and valid `+` continuation rows. The native suite checks
168 engine comparisons and 552 incremental edits across all three endings.

## Reproduce and interpret the checks

After `npm ci`, run `npm run test:rich-markup`. To capture the previous source,
run `node scripts/rich-markup-work.mjs --baseline e677304`. The scripts compile
an instrumented Tree-sitter 0.25.0 runtime and count scanner and runtime lexer
advances separately. Every current-source case must finish without errors and
retain its expected paragraph, span, formatting and verbatim counts.

Budgets were calibrated at 32, 64 and 128 repetitions, then checked at 256.
Linear families allow 32 scanner and 64 lexer advances per byte and at most
threefold work when input size doubles. Recorded quadratic families allow 32
scanner and 128 lexer advances per byte per repetition and at most fivefold
work on doubling. Timings are observations; they do not decide pass or fail.
Each parse has a ten-second timeout.

These are regression budgets for the listed families, not complexity proofs or
a complete conformance audit. Remaining performance work is to remove repeated
lookahead inside scoped markup and across line boundaries, then tighten the
quadratic budgets to linear bounds. Growing attributed depth needs its own
qualification strategy. The existing flat-paragraph tests continue to check
linear work through 16,384 repetitions.

## Boundary gaps found during the extension

The five baseline qualification gaps found here are fixed by
[#495](https://github.com/markup-carve/tree-sitter-carve/issues/495): brackets
inside code now stay inside their attributed span, table-cell pipes bound
qualification, and unmatched backticks in nested destinations or attributes
leave the outer brackets literal. Closed comments containing backticks remain
opaque; unclosed comments remain text.

The regression suite checks 414 engine comparisons and 1,800 incremental
edits, including LF, CRLF, CR, missing final terminators and excluded source
ranges. Raw-row boundaries preserve tick context from earlier comments,
attributes, destinations and escapes. Eight corpus fixtures also run through native and WASM tests, and the
sanitizer receives those sources and three raw-row context controls. Separate reader checks cover 63 probes
through 4,096 repetitions, with limits of six scanner advances per byte, one
host advance per byte and one column lookup per probe. Cached bracket matches
and failed comment searches prevent repeated suffix scans during fallback.

These reader checks do not remove the quadratic full-parser costs recorded
above. The archived measurements describe the source from #494.
