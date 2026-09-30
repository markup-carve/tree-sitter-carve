Consecutive literal brackets previously triggered lookahead from each nested opener. The scanner now reads the opening run once, retains its depth in one serialized entry, and leaves inline content structural.

Full-parser scanner advance counts at depth 1,024:

| Content | Previous parser | Fixed parser |
| --- | ---: | ---: |
| Plain text | 12,511,622 | 11,267 |
| Strong text | 12,536,095 | 13,335 |
| Emphasis | 12,536,095 | 13,335 |

[Raw measurements](literal-bracket-work.json) retain the baseline commit. These are operation counts, not elapsed timings. CI checks a deterministic byte budget through depth 16,384. Qualified link/span tails and line boundaries use the regular reader.
