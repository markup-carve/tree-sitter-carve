Unfinished bracket runs containing ordinary punctuation previously retried lookahead from every opener. The scanner now emits their literal text together at EOF or before a blank line. Periods, commas, semicolons and question marks are covered. Dotted runs remain available to smart punctuation; markup and continued lines retain the regular reader.

Fresh full-parser work at 1,024 repeated fragments, ending at EOF:

| Fragment | Previous scanner | Fixed scanner | Previous lexer | Fixed lexer |
| --- | ---: | ---: | ---: | ---: |
| `[[a.` | 13,124,099 | 10,243 | 23,628,295 | 10,248 |
| `[[a,b` | 15,747,075 | 12,291 | 25,197,574 | 12,296 |
| `[[a;` | 13,122,051 | 10,243 | 23,626,247 | 10,248 |
| `[[a?` | 13,122,051 | 10,243 | 23,626,247 | 10,248 |

[Raw measurements](malformed-bracket-work.json) retain the baseline, runtime version and exact input fragments. CI checks 198 cases through 32,768 fragments, including LF, CRLF, CR, blank-line boundaries and balanced multiline punctuation. The limits are 32 scanner and 64 runtime lexer advances per input byte.
