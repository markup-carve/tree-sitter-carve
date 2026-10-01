# Attributed table-cell work

Repeating `[x]{.k}|` in separate cells caused quadratic runtime lexer work.
On `9da01ed`, the merged #495 fix, 128 cells took 266,747 lexer advances.
This change reduces that count to 4,603, a 98.3% reduction. Scanner work stays
at 3,963 advances. The input is `|` followed by the repeated fragment and LF.

| Cells | Bytes | Lexer on `9da01ed` | Lexer after | Scanner after |
| --- | ---: | ---: | ---: | ---: |
| 32 | 258 | 17,531 | 1,147 | 987 |
| 64 | 514 | 67,835 | 2,299 | 1,979 |
| 128 | 1,026 | 266,747 | 4,603 | 3,963 |
| 16,384 | 131,074 | Not measured | 589,819 | 507,899 |

Profiling traced the extra work to column queries that reread the row prefix
after speculative scans invalidated Tree-sitter's cached column. Ordinary
inline scans inside a row now skip the line-start query. A cell end reuses its
captured boundary column only when raw splitting and parser splitting agree.
Escapes, opaque forms, reference labels and included-range seams keep the
column lookup. The safety flag survives scanner serialization.

Row and separator validation also use 32-bit counters. The previous 8-bit
counters wrapped at 256 cells and rejected those rows, preventing wider checks.

## Validation

Run `npm run test:bracket-qualification` after building the native binding.
It checks 599 engine, range and preserved-tree controls, 1,980 incremental
edits, 63 direct-reader probes and 42 full-parser work cases. Table families
cover plain cells, escaped attributed spans within one cell, cells before a
late span and repeated attributed cells. Linear families run through 16,384
repetitions with limits of 32 scanner and 64 lexer advances per byte, and at
most threefold work when the input doubles. Paragraph comment families keep
their existing quadratic budgets through 512 repetitions.

To compare the previous scanner, run:

```sh
node scripts/bracket-qualification-parser-work.mjs --baseline 9da01ed
```

Baseline mode stops at 128 repetitions for every family. This avoids the old
256-cell counter wrap and limits the cost of quadratic baseline cases.

The wider regression run passes 711 fixture sources, all 2,200 shared corpus
sources and the 420 rich-markup work cases. Review candidates match the trees
from `9da01ed`. A temporary assertion comparing reused columns with runtime
columns passes the full corpus and the additional table controls. Those checks
cover pipes inside comments, destinations, notes and reference labels, error
recovery, Unicode, all line endings and excluded source ranges.

These are measured regression bounds for the tested inputs. Opaque and escaped
multi-cell rows can still require prefix column walks. Paragraph comments,
nested attributed depth and other scoped rich markup retain their documented
performance costs; see [the rich-markup work report](rich-markup-work.md).
