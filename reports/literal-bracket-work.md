Literal brackets previously triggered lookahead from each nested opener. The scanner now reads the opening run once, retains its depth in one serialized entry, and leaves its innermost opener and inline content structural.

Full-parser scanner advance counts at depth 1,024:

| Content | Previous parser | Fixed parser |
| --- | ---: | ---: |
| plain | 12,511,622 | 11,281 |
| strong | 12,536,095 | 11,325 |
| emphasis | 12,536,095 | 11,325 |
| spaced | 25,043,578 | 22,563 |
| inner-link | 12,548,274 | 12,333 |
| multiline | 12,536,069 | 11,304 |
| footnote | 12,523,825 | 13,326 |
| citation | 12,523,795 | 11,270 |
| unclosed | 1,052,675 | 4,100 |
| unclosed-multiline | 1,060,882 | 4,112 |

[Raw measurements](literal-bracket-work.json) retain the baseline commit and runtime version. These are operation counts, not elapsed timings. CI checks a deterministic byte budget across all ten shapes through depth 16,384. Qualifying tails on batched brackets keep the regular reader.
