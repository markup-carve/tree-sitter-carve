# Changelog

All notable changes to tree-sitter-carve are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.3] - 2026-08-18

### Added

- Tilde code and raw fences parse with the same width, metadata, container and
  interruption rules as backtick fences. A closer must use the opener's fence
  character and may be wider than it (#225).
- Semantic language attributes: `{:TAG}` and `{:}` parse in inline and block
  attribute lists, with the structural subtag envelope enforced in the block
  scanner and a dedicated highlighted node (#191).
- An inline note, `^[content]`, is a construct: an `inline_note` node with a
  `content` field captured as `markup.link.label`. Its content recognizes no
  note and no footnote reference, and an empty or whitespace-only note stays a
  literal caret and bracket run (#199). Known gap, pinned in
  `test/corpus/carve.txt`: a note whose content holds a bracket run that forms
  no span ends at that run's `]` (corpus 309).
- A bare `::: figure` opener highlights as a composite figure - `class_name`
  captures `@type.builtin` rather than the generic `@type`, and an opener
  carrying a title or a `[label]` keeps `@type` (#197, markup-carve/carve#1215).
- Node-addon and CLI parse parity is a CI invariant, with the grammar battery
  pinned to a source revision (#224).

### Fixed

- A quote on a list item's marker line keeps the rest of that line instead of
  building an empty quote and ejecting the content out of the list (#220).
- Table continuation rows stay inside block quotes and definition-list
  prefixes, headings are recognized at an active container's content column,
  and a link reference identifier stays on one physical line (#224).
- A language tag has one spelling, so `[x]{:fr}` forms a span like every other
  attribute kind and a malformed tag stays literal (#194).
- A span's attribute list must be adjacent to the bracket it qualifies; a span
  no longer reaches across a lone-CR blank line to take the next line's block
  attribute list (#196).

### Changed

- The spec corpus pin moves from carve `c19d1a4` to the `22f7f47` freeze:
  892 to 1259 documents, 288 to 365 categories, each added category classified
  rather than regenerated (#206, #213, #221).
- The engine oracle behind `scripts/under-acceptance.mjs` moves to carve-js
  `2dc3232e`, 200 commits forward from a pin that predated the 0.1.3 engine
  release, so the recorded gaps describe an engine somebody ships (#215, #222).
- Under-acceptance is ratcheted against the exact compared document and node
  population, so corpus or node-mapping drift cannot silently shrink the sweep
  (#224). Over this release the ledger moved 28 to 40 recorded gaps - 21 in,
  9 out - and the line-terminator ledger 18 to 34 - 17 in, 1 out - against a
  corpus that grew by 367 documents.
- The four short-run corpus floors move from 400 to 1000 documents. A floor set
  at a third of the population caught an uninitialized submodule and nothing
  else, so a half-lost checkout ran at 600 documents and reported a clean pass
  (#207).
## [0.1.2] - 2026-08-10

### Fixed

- **A fence opener's separator and its metadata slots are spaces** (spec:
  `resources/grammar.ebnf`, PART 7 MARKER SEPARATORS AND PADDING SLOTS, with
  markup-carve/carve#907 and markup-carve/carve#912 settling the two roles and
  their cardinality). A tab in any of them makes the whole line prose, and a
  code fence's own `[space]` slot takes exactly one space where the two slots
  inside its info string take a run. So ``` ```<SP><SP>php ```,
  ``` ```<TAB>js ```, ``` ```js<TAB>"T" ```, `::: note<TAB>"Title"` and
  `---<SP><SP>yaml` open nothing and stay paragraphs; ``` ```js "T" [L] ```,
  `::: note "T" [L]` and `--- yaml` are unchanged. Trailing whitespace after the
  last token on an opener line still takes both spellings and any width.
- **A colon fence opener is decided by its whole line.** `::: note zzz`,
  `::: note {.x}`, `::: | x` and `::: note [L] "T"` produced an ERROR node; they
  are ordinary paragraphs, as every engine renders them. The opener now models
  the type word, an optional quoted title, an optional `[label]` and the end of
  the line, and declines the block when the line does not match.
- **A reference definition ends where its last modeled token does** (spec:
  markup-carve/carve#911, ANCHORED AT END OF LINE). `[a]: /u zzz`,
  `[a]: /u<TAB>{.c}`, `[a]: /u<SP><SP>{.c}` and `[r]: a b c` were parsed as
  definitions, which render nothing - so their visible source text had no node
  behind it, and a `[a][]` below them was highlighted as a reference that
  resolves. They are paragraphs. `[a]:` plus two spaces plus `/u` is still a
  definition, `[a]: /u` with a trailing space or tab is still a definition, and
  `[r]:` with no destination still parses as one. A definition's trailing
  attribute block is now a `link_reference_attributes` node rather than
  `ignored_text`.

- **A lone carriage return is a line ending** (spec: `resources/grammar.ebnf`,
  `newline = '\n' | '\r\n' | '\r'`, named rather than restated by PART 0's
  INPUT paragraph). Only two of the three spellings ended a line here: the
  scanner's `advance` skipped a `\r` wherever it met one, which is what made
  CRLF work, and which left a document written with lone carriage returns with
  no terminators at all - `# Title` + CR + `a` + CR + `b` was ONE heading
  spanning the whole file. All three spellings now parse to the same tree: over
  the 672 corpus documents written out in each of the three, 428 parsed
  differently before and 16 still do. Those 16 are recorded in
  `test/coverage.json`; they are reference definitions, attribute blocks and
  trailing blocks inside list items, whose probes read a column that tree-sitter
  only resets on `\n`. One shape outside the corpus is in the same family and
  named in `grammar.js`: a `%%` comment line ended by a lone carriage return
  consumes its own terminator in the internal lexer, so an INDENTED construct
  below it can be misread.
- **A trailing block stays inside its list item in a CRLF document.** Found
  while making the above safe: `- a` / blank / `  {.c}` / blank / `  b` put the
  last paragraph outside the item under CRLF, and parsed correctly under LF.
  Every corpus fixture is normalized to LF, so nothing could see it.
- **A tab does not satisfy the colon-fence separator** (spec:
  `resources/grammar.ebnf`, PART 7 MARKER SEPARATORS AND PADDING SLOTS,
  normative since markup-carve/carve#886: "the whitespace that stands between a
  marker and the token that SELECTS which construct the line opens ... is
  spelled `space`, and a tab never satisfies it"). The colon fence has ONE
  separator slot and all four openers share it, so `:::` followed by a tab now
  opens nothing at all: `:::` + TAB + `note` is the same paragraph `:::note`
  already was, and so are the line block's `|`, the local hard-break block's
  backslash, a custom type word, and the labelled div's `[label]` - `div_open`
  merely makes the slot OPTIONAL, which is a different property from a different
  role, so `:::[First]` still opens glued and `::: [First]` still opens spaced.
  A mixed run counts as a tab: `::: ` + TAB + `note` opens nothing either. How
  MANY separator characters the slot takes is a separate question and is
  unchanged. The `"title"` and `[label]` slots on the admonition opener are the
  other role - the type word has already decided the block, so they are PADDING
  and a tab is still legal there: `::: note` + TAB + `"T"` is an admonition with
  a title, and narrowing them along with the separator is the blanket sweep the
  spec section warns against. A whitespace-only tail is trailing whitespace
  rather than a separator, so a fence with a trailing tab is still the bare
  fence it was and still opens and still closes. The CODE fence is untouched:
  markup-carve/carve#886 leaves it out by name, `code_fence_info` still spells
  its metadata slots `space+`, and a tab before the info string still opens a
  code block. Of 455 colon-fence and code-fence shapes across five container
  contexts, 144 changed and every one of them is a tab-separated opener becoming
  the paragraph the spec says it is; no shape gained a block, none newly errored,
  no code-fence shape moved, and no shape whose separator holds no tab moved. The
  largest single swing is a tab-separated opener after a paragraph, which used to
  be paragraph + div and is now one paragraph, because a malformed fence leaves
  the paragraph expecting a closer (PART 9 §12). An indented fence inside a list
  item is unchanged, for the unrelated reason that it opens nothing at any indent
  already. The four implementations still accept the tab and are being corrected
  separately (markup-carve/carve-js#786, markup-carve/carve-php#941,
  markup-carve/carve-rs#712), so this grammar is ahead of them until they land.
- **A heading or a fenced code block interrupts an open paragraph** (spec:
  `resources/grammar.ebnf`, PART 9 §10 I1: "a heading, a fenced code opener WITH
  a matching closer ahead ... interrupts", "at the document top level AND inside
  nested content"). The paragraph-closing test recognized a block quote, a
  `:::` fence, block math, a caption and a comment fence, but never a `#` marker
  or a ``` run, so a heading or a fence with no blank line before it folded into
  the paragraph above: `[^a]: note` over `  ``` ` over `  code` over `  ``` `
  put an inline `verbatim` span inside the footnote's paragraph where carve-js
  builds a `<pre>`, `- item` over `  # H` built no heading, and the same held at
  the top level and inside a `:::` div. Both openers now end the paragraph when
  the line sits exactly at its container's content margin - a list item's
  recorded content column, a footnote's `indent + 2`, or the document's zero -
  and a fence only when a closer follows at the opener's own column, so an
  unterminated one - and one whose only closing run is outdented or
  over-indented - still stays an inline run. A footnote's margin is a threshold rather than an exact column,
  matching both the openers' own indent test and carve-js: `[^a]: note` over
  `   ``` ` at column 3 is a `<pre>` inside the note, where `- item` over
  `   ``` ` at the same column is paragraph text. Of 1188 generated shapes
  across twelve container contexts, 80 moved onto carve-js's block count and
  none off it, with no document newly erroring; seven recorded
  under-acceptances are resolved. A LAZY line under a block quote gains from
  the same rule - `> intro` over `# H` is now a quote followed by an `<h1>`, as
  in carve-js, where it used to be one quoted paragraph - while a MARKED line
  inside a quote is unchanged: this grammar builds no heading there even with a
  blank line before it, tracked separately as
  `headings-inside-containers-are-not-wrapped`. A seven-hash line stays
  paragraph text, matching carve-js rather than this grammar's own uncapped
  opener (#112).

- **A nested block quote line is decided by its whole marker run** (spec:
  `resources/grammar.ebnf`, `blockquote = blockquote_line, {blockquote_line |
  ...}` applied to the content the outer `>` strips). The external scanner takes
  one marker per call and carries the count between calls, and the test that
  dedents out of a deeper quote read that partial count as if it were the line's
  depth. The FIRST marker of `> >` therefore decided the line at depth 1 against
  an open depth of 2 and closed the inner quote before its own marker was seen,
  so every nested quote line that no open paragraph absorbed opened a fresh
  inner quote: `> >` over `> >` built two empty inner quotes with a loose marker
  between them, `> > # h` over `> > # i` two quotes holding one heading each, and
  `> > - a` over `> > - b` two quotes holding one list each - where carve-js
  builds one inner quote in every case. The dedent now waits while another `>`
  follows on the same line. Of 106 changed documents in a nested-quote sweep, 70
  moved onto carve-js's block quote count and 2 off it (`> >` over `> >x` over
  `> >`, and the same with a tab), with no document newly erroring; depth-1
  shapes are untouched (#136).

- **A document that does not end with a newline is one paragraph again**
  (spec: `resources/grammar.ebnf`, "A paragraph is terminated by a blank line,
  an interrupting block (§10), or end of file"). Such a document parsed into one
  paragraph per character - `abcdef` with no trailing newline produced six
  `paragraph` nodes, ` x` over `tail` produced four - where every engine renders
  a single paragraph. The external scanner's end-of-input test sat at the bottom
  of the scan, after every probe had run, and read the lexer's live position; a
  probe that scanned to the end of its line and then declined leaves the lexer
  where it stopped, which in a newline-less document is end-of-input. The test
  then closed the paragraph mid-line with a zero-width token and restarted the
  run on the next character, so the split column tracked whichever probe had
  read furthest. End-of-input is now recorded at the top of the call, beside the
  newline snapshot already taken there. 33 of 125 probed newline-less shapes
  changed, every one of them by merging nodes the old scanner had split; no
  document gained a node and none newly errored (#124).

- **A block quote marker line ending in a trailing space is content-less**
  (spec: `resources/grammar.ebnf`, `blockquote_line = '>', (newline | (space,
  inline_content, newline))`). A separator space with no inline content after it
  is the bare `'>' newline` line wearing a separator, and carve-js renders `> `
  and `>` identically. The scanner read only the space and left the newline
  unread, so the marker token stopped mid-line and the quote closed before the
  next line was seen: `> ` over `> ` built two `block_quote` nodes where the
  engine builds one. Every trailing-space shape now matches its bare spelling
  exactly, including the tail rule - `> ` over `> ` over `x` is a quote and a
  sibling paragraph, `> ` over `> ` over `- b` a quote and a sibling list - and
  the same holds for CRLF line endings. A marker followed by MORE whitespace
  (`>  `, `> ` and a tab) is a separate input class and is unchanged (#130).

- **A blank line separates two block quotes** (spec:
  `resources/grammar.ebnf`, whose lazy-continuation note states that a lazy line
  continues the quote only while it is "not blank (a blank line ends the
  blockquote)"). `> a` over a blank line over `> b` parsed as ONE quote holding
  both paragraphs, where carve-js renders two `<blockquote>` elements; the same
  merge applied to every shape of the family, including the empty forms `>` over
  blank over `>` and a nested `> > a` over blank over `> b`, where every open
  quote ends and not just the innermost. A whitespace-only line separates the
  same way an empty one does. A MARKED empty line is unaffected: `> a` over `>`
  over `> b` is still one quote, since that line is not blank (#129).

- **A second content-less block quote marker joins the same empty quote**
  (spec: `resources/grammar.ebnf`, `blockquote = blockquote_line,
  {blockquote_line | ...}` over `blockquote_line = '>', (newline | ...)`). The
  bare marker line repeats, so `>` over `>` is one empty quote, and carve-js
  renders a single empty `<blockquote>` for it. The grammar had nowhere to put
  the second marker - the continuation markers live inside
  `_block_quote_content`'s repeat, behind a first real block - so a paragraph's
  own leading prefix took it instead: an ERROR when nothing followed, and a
  swallowed sibling when something did. `>` over `>` over `x` is now a quote and
  a sibling paragraph, `>` over `>` over `- b` a quote and a sibling list, the
  same rule #96 applied to the single marker (#126).

- **An indented definition term marker is paragraph text.** `:: t` written at
  column 1 opened a definition list, at the top level and inside a div alike,
  where all three engines keep the line as prose. The term branch of the scanner
  never asked what column it was on, while the div branch beside it already
  documented the rule as one "the heading marker and the definition markers
  follow". A term at a container's content column still opens the list, and a
  term continuing an open list is measured against that list's own marker column
  (#109).

- **The colon-fence opener accepts the hard-break form** (spec:
  `resources/grammar.ebnf`, `local_hard_break_block_open = colon_fence:open,
  space, backslash`). `::: \` is the local hard-break block and renders as
  `<div class="hardbreaks">`, but the opener accepted only a bare fence, a
  `[label]`, or a line-block bar / class name after a separator, so the
  backslash reached no route to a `div` and the whole block folded into a
  paragraph. The separator is required (`:::\` glued is still paragraph text)
  and the backslash must be the last thing on the line apart from trailing
  spaces (`::: \ x` and `::: \\` are still paragraph text), matching carve-js.
  Because the opener and the paragraph-closing peek share one tail test, a
  hard-break fence now also interrupts an open paragraph.

- **A lazy colon fence ends the list item a malformed one was absorbed into**
  (spec: PART 9 §12 absorption, §24 C3 content column). The absorption a
  malformed `:::` leaves behind belongs to the paragraph, so it reaches only as
  far as the container that paragraph lives in. `- item` over a flush-left
  `:::note`, `body`, `:::`, `tail` is a one-item list plus a `div` holding
  `tail` in carve-js, carve-php and carve-rs alike: the closing fence sits
  below the item's content column, where the outer context is offered it first
  and nothing there is expecting a closer. The grammar folded all five lines
  into the item, at any fence width. A fence at the item's own content column
  is unaffected and still absorbs.

- **A content-less definition marker line ends the item above it** (spec:
  `docs/examples/core.md`, MARKER REQUIRES CONTENT, settled for definition
  markers in markup-carve/carve#788). `:: t` over `:: ` over `x` is a one-term
  `<dl>` followed by a paragraph holding both remaining lines; the marker line
  is paragraph text, and being paragraph text is exactly what makes it end the
  term. The grammar folded the whole thing into the term instead, so a document
  that closes a definition list looked like one that never left it. The
  description shape (`:  `) and a content-less marker after an open description
  behave the same. A BARE `::` carries no separator, is not marker-shaped, and
  still continues the term lazily, which is what every engine does with it. The
  shape-only rule is scoped to definition lists: inside a bullet item a
  content-less `:: ` line is still lazy text, and only a colon marker carrying
  content ends the item.

- **A malformed colon fence leaves the paragraph expecting a closer** (spec:
  PART 9 §12, normative since markup-carve/carve#778). A `:::` line that is not
  a valid opener - `::: {.x}`, `::: 123`, a glued `:::note` - is paragraph text,
  and from there a bare fence at ANY width is text too, so `::: {.x}` over
  `not a div` over `:::` is ONE paragraph rather than a paragraph plus an empty
  `div`. The decision whether a colon line ends an open paragraph counted the
  colons and stopped, while the opener applied a shape test the peek did not,
  so the paragraph was cut one line early and the closing fence was then read
  as a fresh opener. Both now ask the same predicate. A bare fence still
  interrupts an ordinary paragraph, a valid opener still interrupts one that
  absorbed a malformed fence, and a fence that closes an open div is still that
  closer. Four recorded over-acceptances close with it, and `text` over
  `:::note` is now the single paragraph every engine renders instead of two.

### Changed

- **A definition's marker-to-content separator is a space** (spec: U+0020 for
  all three definition markers, carve-rs is the reference). `[a]:	/url`,
  `[a]:/url`, a bare `[a]:` and `*[HTML]:	Hyper` are ordinary paragraphs
  now, not definitions. It is the FIRST character after the colon that has to be
  a space - `[a]: 	/url` is still a definition. Nine corpus documents parse
  differently and none newly errors; six of those are `abbreviation_marker` spans
  growing by the one space now inside the token. The footnote marker already
  refused a tab and is unchanged.

- **BREAKING: a heading ends at the newline** (spec markup-carve/carve#451).
  Nothing folds into a heading any more - neither a plain line nor a same-count
  `#` line - so `## A` over `## still A` is two headings, and `# Title` with
  prose beneath is a heading plus a paragraph. The `_heading_continuation`
  external token is gone with the rule; an open heading now closes at its own
  newline whatever follows it.

## [0.1.1] - 2026-07-27

### Added

- Grammar node for the inline literal `` !`…` `` prefix, so a bang-prefixed
  verbatim span highlights as a distinct construct.

## [0.1.0] - 2026-07-15

### Added

- Initial tree-sitter grammar for Carve (grammar root for helix, zed, and
  vim-treesitter).
