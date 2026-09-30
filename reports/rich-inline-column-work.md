Malformed combined opener runs containing brackets, braces, verbatim text or escapes previously incurred repeated column rescans in the Tree-sitter runtime. The scanner now asks for a column only when a delimiter-position comparison or code-fence decision needs it. An existing whole-line negative proof also lets the scanner omit line-start checks for the remaining tokens on that line.

Hosts whose row-end tokens can consume a newline do not receive that shortcut. This preserves list and quote bookkeeping across table rows, including rows with attributes or trailing padding.

Full-parser runtime lexer advances at 512 repeated fragments:

| Fragment | Before | After |
| --- | ---: | ---: |
| `/*a [x] ` | 43,035,691 | 92,690 |
| `/*a {x} ` | 52,458,462 | 97,945 |
| `` /*a `x` `` | 56,634,262 | 86,733 |
| `/*a \x ` | 40,399,634 | 82,644 |

[Raw measurements](rich-inline-column-work.json) record the baseline commit, runtime version, compiler flags and exact fragments. CI now checks 90 cases through 16,384 repetitions with limits of 32 scanner and 64 runtime lexer advances per input byte. Rich-token validation uses a tree cursor instead of repeated indexed child lookups.

Native controls cover 42 engine comparisons and 90 incremental edits, including table row attributes, indentation, quote continuations, hard breaks, Unicode, multiline rich tokens and all three line endings. These work bounds apply to the tested families; they do not establish a complexity bound for every malformed document or for total parser time.
