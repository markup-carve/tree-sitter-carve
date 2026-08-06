#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

// WASM-host compatibility: avoid linking against libc's ctype helpers.
// Some Tree-sitter consumers (e.g. Zed via wasi-sdk + wasmtime) cannot
// resolve `isalnum` as an import. The lookahead is a Unicode codepoint
// (int32_t); for the syntax we use this in (identifier-style tokens), the
// ASCII alphanumeric range is sufficient.
static inline bool carve_is_alnum_ascii(int32_t c) {
    return (c >= '0' && c <= '9')
        || (c >= 'A' && c <= 'Z')
        || (c >= 'a' && c <= 'z');
}

// #define DEBUG

#ifdef DEBUG
#include <assert.h>
#endif

// The different tokens the external scanner support
// See `externals` in `grammar.js` for a description of most of them.
typedef enum {
  IGNORED,

  BLOCK_CLOSE,
  EOF_OR_NEWLINE,
  NEWLINE,
  NEWLINE_INLINE,
  NON_WHITESPACE_CHECK,
  HIGHLIGHTED_OPEN_CHECK,
  HARD_LINE_BREAK,

  FRONTMATTER_MARKER,

  HEADING_BEGIN,
  DIV_BEGIN,
  DIV_END,
  CODE_BLOCK_BEGIN,
  CODE_BLOCK_END,
  COMMENT_FENCE_BEGIN,
  COMMENT_FENCE_CONTENT,
  COMMENT_FENCE_END,
  NOT_A_CONTAINER_OPENER,
  LIST_MARKER_DASH,
  LIST_MARKER_STAR,
  LIST_MARKER_TASK_BEGIN,
  LIST_MARKER_DEFINITION,
  LIST_MARKER_DESCRIPTION,
  LIST_MARKER_DECIMAL_PERIOD,
  LIST_MARKER_LOWER_ALPHA_PERIOD,
  LIST_MARKER_UPPER_ALPHA_PERIOD,
  LIST_MARKER_LOWER_ROMAN_PERIOD,
  LIST_MARKER_UPPER_ROMAN_PERIOD,
  LIST_MARKER_DECIMAL_PAREN,
  LIST_MARKER_LOWER_ALPHA_PAREN,
  LIST_MARKER_UPPER_ALPHA_PAREN,
  LIST_MARKER_LOWER_ROMAN_PAREN,
  LIST_MARKER_UPPER_ROMAN_PAREN,
  LIST_MARKER_DECIMAL_PARENS,
  LIST_MARKER_LOWER_ALPHA_PARENS,
  LIST_MARKER_UPPER_ALPHA_PARENS,
  LIST_MARKER_LOWER_ROMAN_PARENS,
  LIST_MARKER_UPPER_ROMAN_PARENS,
  LIST_ITEM_CONTINUATION,
  LIST_ITEM_END,
  INDENTED_CONTENT_SPACER,
  CLOSE_PARAGRAPH,
  BLOCK_QUOTE_BEGIN,
  BLOCK_QUOTE_CONTINUATION,
  THEMATIC_BREAK_DASH,
  THEMATIC_BREAK_STAR,
  FOOTNOTE_MARK_BEGIN,
  FOOTNOTE_CONTINUATION,
  FOOTNOTE_END,
  LINK_REF_DEF_MARK_BEGIN,
  LINK_REF_DEF_LABEL_END,
  TABLE_HEADER_BEGIN,
  TABLE_SEPARATOR_BEGIN,
  TABLE_ROW_BEGIN,
  TABLE_ROW_END_NEWLINE,
  TABLE_CELL_END,
  TABLE_CAPTION_BEGIN,
  TABLE_CAPTION_END,
  BLOCK_ATTRIBUTE_BEGIN,
  COMMENT_END_MARKER,
  COMMENT_CLOSE,

  INLINE_COMMENT_BEGIN,

  VERBATIM_BEGIN,
  VERBATIM_END,
  VERBATIM_CONTENT,

  // The different spans.
  // Begin is marked by a zero-width token to push elements on the open stack
  // (unless when we're parsing a fallback token).
  // End scans an actual ending token (such as `_}` or `_`) and checks the open
  // stack.
  EMPHASIS_MARK_BEGIN,
  EMPHASIS_END,
  STRONG_MARK_BEGIN,
  STRONG_END,
  UNDERLINE_MARK_BEGIN,
  UNDERLINE_END,
  STRIKETHROUGH_MARK_BEGIN,
  STRIKETHROUGH_END,
  SUPERSCRIPT_MARK_BEGIN,
  SUPERSCRIPT_END,
  SUBSCRIPT_MARK_BEGIN,
  SUBSCRIPT_END,
  HIGHLIGHTED_MARK_BEGIN,
  HIGHLIGHTED_END,
  INSERT_MARK_BEGIN,
  INSERT_END,
  DELETE_MARK_BEGIN,
  DELETE_END,

  PARENS_SPAN_MARK_BEGIN,
  PARENS_SPAN_END,
  CURLY_BRACKET_SPAN_MARK_BEGIN,
  CURLY_BRACKET_SPAN_END,
  SQUARE_BRACKET_SPAN_MARK_BEGIN,
  SQUARE_BRACKET_SPAN_END,

  IN_FALLBACK,

  ERROR,

  // A lone `+` on its own line: the list/block-quote continuation marker
  // (PART 9 §17). Appended at the END of the enum so every existing token keeps
  // its index (must stay aligned with the `externals` array in grammar.js).
  LIST_CONTINUATION_MARKER,

  // Bold-italic `/*…*/`. Appended for the same reason, and last so the two
  // stay adjacent to the marker above them.
  BOLD_ITALIC_MARK_BEGIN,
  BOLD_ITALIC_END,
} TokenType;

// The different blocks in Carve that we track,
// in order to match or close them properly.
// Note that paragraphs are anonymous and aren't tracked.
typedef enum {
  BLOCK_QUOTE,
  COMMENT_FENCE,
  CODE_BLOCK,
  DIV,
  SECTION,
  HEADING,
  FOOTNOTE,
  LINK_REF_DEF,
  TABLE_ROW,
  TABLE_CAPTION,
  LIST_DASH,
  LIST_STAR,
  LIST_TASK,
  LIST_DEFINITION,
  LIST_DECIMAL_PERIOD,
  LIST_LOWER_ALPHA_PERIOD,
  LIST_UPPER_ALPHA_PERIOD,
  LIST_LOWER_ROMAN_PERIOD,
  LIST_UPPER_ROMAN_PERIOD,
  LIST_DECIMAL_PAREN,
  LIST_LOWER_ALPHA_PAREN,
  LIST_UPPER_ALPHA_PAREN,
  LIST_LOWER_ROMAN_PAREN,
  LIST_UPPER_ROMAN_PAREN,
  LIST_DECIMAL_PARENS,
  LIST_LOWER_ALPHA_PARENS,
  LIST_UPPER_ALPHA_PARENS,
  LIST_LOWER_ROMAN_PARENS,
  LIST_UPPER_ROMAN_PARENS,
} BlockType;

// The different types of "numbers" in ordered lists.
typedef enum {
  DECIMAL,
  LOWER_ALPHA,
  UPPER_ALPHA,
  LOWER_ROMAN,
  UPPER_ROMAN,
} OrderedListType;

typedef struct {
  BlockType type;
  // Data depends on the block type.
  // Can be indentation, number of opening/ending symbols, or number of cells in
  // a table row.
  uint8_t data;
  // The column where this container's CONTENT starts, or 0 when unknown.
  //
  // `data` is the marker's own indent plus one, which is a minimum indent and
  // not a column: it is 1 for both `- ` (content at column 2) and `1. `
  // (content at column 3), so no arithmetic on it recovers the column. A block
  // opener inside a container has to sit exactly AT that column - one space
  // past is literal text - and nothing could express that
  // (tree-sitter-carve#84).
  uint8_t content_col;
} Block;

typedef enum {
  VERBATIM,
  EMPHASIS,
  STRONG,
  UNDERLINE,
  STRIKETHROUGH,
  SUPERSCRIPT,
  SUBSCRIPT,
  HIGHLIGHTED,
  INSERT,
  DELETE,
  // The only span whose delimiters are TWO characters and not mirror images:
  // `/*` opens and `*/` closes.
  BOLD_ITALIC,
  // Spans where the start token is managed by `grammar.js`
  // and the tokens specify the ending token ), }, or ]
  PARENS_SPAN,
  CURLY_BRACKET_SPAN,
  SQUARE_BRACKET_SPAN,
} InlineType;

// What kind of span we should parse.
typedef enum {
  // Only delimited by a single character, for example `[text]`.
  SpanSingle,
  // Only delimited by a curly bracketed tags, for example `{= highlight =}`.
  SpanBracketed,
  // Either single or bracketed, for example `^superscript^}`.
  SpanBracketedAndSingle,
  // Either single or bracketed, but no whitespace next to the single tags.
  // For example `_emphasis_}` (but not `_ emphasis _`).
  SpanBracketedAndSingleNoWhitespace,
  // A two-character closer that is not a mirror of its opener: `/*…*/`.
  SpanPair,
} SpanType;

typedef struct {
  InlineType type;
  // Different types may use `data` differently.
  // Spans use it to count how many fallback symbols was returned after the
  // opening tag.
  // Verbatim counts the number of open and closing ticks.
  uint8_t data;
} Inline;

typedef struct {
  // Open blocks is a stack of the blocks that haven't been closed.
  // Used to match closing markers or for implicitly closing blocks.
  Array(Block *) * open_blocks;

  // Open inline is a stack of non-closed inline elements.
  Array(Inline *) * open_inline;

  // How many BLOCK_CLOSE we should output right now?
  uint8_t blocks_to_close;

  // What's our current block quote level?
  uint8_t block_quote_level;

  // The whitespace indent of the current line.
  uint8_t indent;

  // Column right after the most recent list marker emitted on the current
  // line (0 = none). A bullet marker that starts exactly at this column is a
  // marker-line nested list (`- - A`, corpus 103-marker-line-nested-lists):
  // its list opens at the marker's own column instead of the line indent.
  uint8_t marker_end_col;

  // Parser state flags.
  uint8_t state;
} Scanner;

// Tracks if a `[` starts an inline link.
// It's used to prune branches where it does not, fixing precedence
// issues with multiple elements inside the destination.
static const uint8_t STATE_BRACKET_STARTS_INLINE_LINK = 1 << 0;
// Tracks if a `[` starts a span (the Carve element).
// It's used to prune branches where it does not, fixing precedence
// issues where the span wasn't chosen despite being closed first.
static const uint8_t STATE_BRACKET_STARTS_SPAN = 1 << 1;
// Tracks if the next table row is a separator row.
static const uint8_t STATE_TABLE_SEPARATOR_NEXT = 1 << 2;
// Tracks that a `+` continuation marker (PART 9 §17) has attached a flush-left
// block to the current LIST item. While set, indent-based list closing is
// suppressed so the attached block (which sits at indent 0, below the item's
// content margin) is not torn out of the item -- e.g. a fenced code block's
// body or a table's later rows. Cleared when a sibling list marker, a blank
// line, or the list's close ends the attached block.
static const uint8_t STATE_LIST_CONTINUATION = 1 << 3;
// Tracks that a colon-fence line in the CURRENT paragraph failed the opener
// test, so the paragraph is left "expecting a closer" (PART 9 §12, NORMATIVE
// since markup-carve/carve#778). While set, a BARE fence that would otherwise
// open a new div is paragraph text instead: `::: {.x}` / `not a div` / `:::` is
// ONE paragraph, and the absorption is not width-tagged, so a `::::` after a
// malformed `:::` is absorbed too.
//
// It suppresses only the bare-fence-as-OPENER case. A valid non-bare opener
// still interrupts (`::: {.x}` / `x` / `::: note` is a paragraph plus an
// admonition), and a bare fence that CLOSES a div which is actually open is
// still that closer. Cleared when the paragraph ends.
static const uint8_t STATE_FENCE_ABSORBS = 1 << 4;

static TokenType scan_list_marker_token(Scanner *s, TSLexer *lexer);
static uint8_t scan_block_quote_markers(Scanner *s, TSLexer *lexer,
                                        bool *ending_newline);
static TokenType scan_unordered_list_marker_token(Scanner *s, TSLexer *lexer);
static bool scan_valid_inline_attribute(Scanner *s, TSLexer *lexer);

#ifdef DEBUG
static char *block_type_s(BlockType t);
static char *token_type_s(TokenType t);
static void dump(Scanner *s, TSLexer *lexer);
static void dump_all_valid_symbols(const bool *valid_symbols);
static void dump_some_valid_symbols(const bool *valid_symbols);
#endif

static bool is_list(BlockType type) {
  switch (type) {
  case LIST_DASH:
  case LIST_STAR:
  case LIST_TASK:
  case LIST_DEFINITION:
  case LIST_DECIMAL_PERIOD:
  case LIST_LOWER_ALPHA_PERIOD:
  case LIST_UPPER_ALPHA_PERIOD:
  case LIST_LOWER_ROMAN_PERIOD:
  case LIST_UPPER_ROMAN_PERIOD:
  case LIST_DECIMAL_PAREN:
  case LIST_LOWER_ALPHA_PAREN:
  case LIST_UPPER_ALPHA_PAREN:
  case LIST_LOWER_ROMAN_PAREN:
  case LIST_UPPER_ROMAN_PAREN:
  case LIST_DECIMAL_PARENS:
  case LIST_LOWER_ALPHA_PARENS:
  case LIST_UPPER_ALPHA_PARENS:
  case LIST_LOWER_ROMAN_PARENS:
  case LIST_UPPER_ROMAN_PARENS:
    return true;
  default:
    return false;
  }
}

static BlockType list_marker_to_block(TokenType type) {
  switch (type) {
  case LIST_MARKER_DASH:
    return LIST_DASH;
  case LIST_MARKER_STAR:
    return LIST_STAR;
  case LIST_MARKER_TASK_BEGIN:
    return LIST_TASK;
  case LIST_MARKER_DEFINITION:
  case LIST_MARKER_DESCRIPTION:
    return LIST_DEFINITION;
  case LIST_MARKER_DECIMAL_PERIOD:
    return LIST_DECIMAL_PERIOD;
  case LIST_MARKER_LOWER_ALPHA_PERIOD:
    return LIST_LOWER_ALPHA_PERIOD;
  case LIST_MARKER_UPPER_ALPHA_PERIOD:
    return LIST_UPPER_ALPHA_PERIOD;
  case LIST_MARKER_LOWER_ROMAN_PERIOD:
    return LIST_LOWER_ROMAN_PERIOD;
  case LIST_MARKER_UPPER_ROMAN_PERIOD:
    return LIST_UPPER_ROMAN_PERIOD;
  case LIST_MARKER_DECIMAL_PAREN:
    return LIST_DECIMAL_PAREN;
  case LIST_MARKER_LOWER_ALPHA_PAREN:
    return LIST_LOWER_ALPHA_PAREN;
  case LIST_MARKER_UPPER_ALPHA_PAREN:
    return LIST_UPPER_ALPHA_PAREN;
  case LIST_MARKER_LOWER_ROMAN_PAREN:
    return LIST_LOWER_ROMAN_PAREN;
  case LIST_MARKER_UPPER_ROMAN_PAREN:
    return LIST_UPPER_ROMAN_PAREN;
  case LIST_MARKER_DECIMAL_PARENS:
    return LIST_DECIMAL_PARENS;
  case LIST_MARKER_LOWER_ALPHA_PARENS:
    return LIST_LOWER_ALPHA_PARENS;
  case LIST_MARKER_UPPER_ALPHA_PARENS:
    return LIST_UPPER_ALPHA_PARENS;
  case LIST_MARKER_LOWER_ROMAN_PARENS:
    return LIST_LOWER_ROMAN_PARENS;
  case LIST_MARKER_UPPER_ROMAN_PARENS:
    return LIST_UPPER_ROMAN_PARENS;
  default:
#ifdef DEBUG
    assert(false);
#endif
    return LIST_DASH;
  }
}

static bool is_alpha_list(BlockType type) {

  switch (type) {
  case LIST_LOWER_ALPHA_PERIOD:
  case LIST_LOWER_ALPHA_PAREN:
  case LIST_LOWER_ALPHA_PARENS:
  case LIST_UPPER_ALPHA_PERIOD:
  case LIST_UPPER_ALPHA_PAREN:
  case LIST_UPPER_ALPHA_PARENS:
    return true;
  default:
    return false;
  }
}

static void advance(Scanner *s, TSLexer *lexer) {
  lexer->advance(lexer, false);
  // Carriage returns should simply be ignored.
  if (lexer->lookahead == '\r') {
    lexer->advance(lexer, false);
  }
}

static uint8_t consume_chars(Scanner *s, TSLexer *lexer, char c) {
  uint8_t count = 0;
  while (lexer->lookahead == c) {
    advance(s, lexer);
    ++count;
  }
  return count;
}

static uint8_t consume_whitespace(Scanner *s, TSLexer *lexer) {
  uint8_t indent = 0;
  for (;;) {
    if (lexer->lookahead == ' ') {
      advance(s, lexer);
      ++indent;
    } else if (lexer->lookahead == '\r') {
      advance(s, lexer);
    } else if (lexer->lookahead == '\t') {
      advance(s, lexer);
      // PART 9 §24 C1: a tab advances to the NEXT MULTIPLE OF 4 from wherever
      // it starts, not by four from wherever it starts. The two agree only
      // when the tab begins on a tab stop, so `<SPACE><TAB>` is column 4 and
      // not 5. `s->indent` is compared against list content columns - several
      // of those comparisons are exact - so the difference changed structure:
      // a marker at column 4 reached by a space and a tab nested INSIDE a
      // marker at column 4 reached by four spaces, instead of being its
      // sibling (#100).
      indent += 4 - (indent % 4);
    } else {
      break;
    }
  }
  return indent;
}

static Block *create_block(BlockType type, uint8_t data) {
  Block *b = ts_malloc(sizeof(Block));
  b->type = type;
  b->data = data;
  b->content_col = 0;
  return b;
}

static Inline *create_inline(InlineType type, uint8_t data) {
  Inline *res = ts_malloc(sizeof(Inline));
  res->type = type;
  res->data = data;
  return res;
}

static void push_block(Scanner *s, BlockType type, uint8_t data) {
  array_push(s->open_blocks, create_block(type, data));
}

static void push_inline(Scanner *s, InlineType type, uint8_t data) {
  array_push(s->open_inline, create_inline(type, data));
}

static void remove_block(Scanner *s) {
  if (s->open_blocks->size > 0) {
    Block *removed = array_pop(s->open_blocks);
    // Closing a self-terminating container (fenced code, div, block quote,
    // nested list, ...) that a `+` marker attached ends the continuation. A
    // TABLE_ROW / TABLE_CAPTION pop is an INTERNAL table event -- the table is
    // still being parsed row by row -- so it must NOT clear the flag, or a
    // multi-row attached table would lose its later rows.
    if (removed->type != TABLE_ROW && removed->type != TABLE_CAPTION) {
      s->state &= ~STATE_LIST_CONTINUATION;
    }
    ts_free(removed);
    if (s->blocks_to_close > 0) {
      --s->blocks_to_close;
    }
  }
}

static void remove_inline(Scanner *s) {
  if (s->open_inline->size > 0) {
    ts_free(array_pop(s->open_inline));
  }
}

static Block *peek_block(Scanner *s) {
  if (s->open_blocks->size > 0) {
    return *array_back(s->open_blocks);
  } else {
    return NULL;
  }
}

static Inline *peek_inline(Scanner *s) {
  if (s->open_inline->size > 0) {
    return *array_back(s->open_inline);
  } else {
    return NULL;
  }
}

static bool disallow_newline(Block *top) {
  if (!top)
    return false;

  switch (top->type) {
  case TABLE_ROW:
  case LINK_REF_DEF:
    return true;
  default:
    return false;
  }
}

// How many blocks from the top of the stack can we find a matching block?
// If it's directly on the top, returns 1.
// If it cannot be found, returns 0.
static size_t number_of_blocks_from_top(Scanner *s, BlockType type,
                                        uint8_t level) {
  for (int i = s->open_blocks->size - 1; i >= 0; --i) {
    Block *b = *array_get(s->open_blocks, i);
    if (b->type == type && b->data == level) {
      return s->open_blocks->size - i;
    }
  }
  return 0;
}

static Block *find_block(Scanner *s, BlockType type) {
  for (int i = s->open_blocks->size - 1; i >= 0; --i) {
    Block *b = *array_get(s->open_blocks, i);
    if (b->type == type) {
      return b;
    }
  }
  return NULL;
}

static Block *find_list(Scanner *s) {
  for (int i = s->open_blocks->size - 1; i >= 0; --i) {
    Block *b = *array_get(s->open_blocks, i);
    if (is_list(b->type)) {
      return b;
    }
  }
  return NULL;
}

// Whether the current line's leading whitespace (`s->indent`) is EXTRA --
// indentation beyond the left margin of the innermost open container. A list
// item, footnote, or table caption indents its content (any indent at or above
// its `data` threshold stays inside it); blocks whose content sits flush left
// (the document root, a `:::` div) and block quotes (whose `>` markers are
// consumed separately, leaving indent at 0) expect a zero margin. A heading
// marker only counts as a marker when it sits at this margin with NO extra
// leading whitespace -- carve drops CommonMark's 0-3 space indent fuzz
// (column-0, NORMATIVE; corpus 101-heading-marker-column-zero).
/// TRUE when the line sits PAST its container's content column.
///
/// `has_extra_indent` answers the opposite question - short OF the column - and
/// a block attribute needs both. Measured against carve-js: inside `- a`, whose
/// content column is 2, `{.c}` at column 2 attaches to the block under it and
/// `{.c}` at column 3 is a literal paragraph (corpus 87-compact-list-blocks-10).
///
/// Uses the container's recorded content column, NOT `data`: `data` is the
/// marker's indent plus one, so it is 1 for both `- ` and `1. ` and cannot tell
/// column 2 from column 3. A container opened before this field existed, or one
/// whose column was never recorded, reads 0 and is treated as "no opinion" -
/// the guard then behaves exactly as it did before (tree-sitter-carve#84).
/// The innermost open container that INDENTS its content, or NULL when the
/// margin is the document's own zero. A list item, footnote or table caption
/// indents; a div and a block quote do not (a quote's `>` markers are consumed
/// separately, leaving the indent at 0). Every margin question below asks this
/// one first, so the set of indenting containers has a single spelling.
static Block *indenting_container(Scanner *s) {
  for (int i = s->open_blocks->size - 1; i >= 0; --i) {
    Block *b = *array_get(s->open_blocks, i);
    if (is_list(b->type) || b->type == FOOTNOTE || b->type == TABLE_CAPTION) {
      return b;
    }
  }
  return NULL;
}

static bool has_surplus_indent(Scanner *s) {
  // A `+` continuation attaches a FLUSH-LEFT block, so the margin is zero.
  if (s->state & STATE_LIST_CONTINUATION) {
    return s->indent > 0;
  }
  Block *b = indenting_container(s);
  if (b) {
    return b->content_col != 0 && s->indent > b->content_col;
  }
  return s->indent > 0;
}

static bool has_extra_indent(Scanner *s) {
  // A `+` continuation marker attaches a FLUSH-LEFT block to the list item
  // (PART 9 section 17), so while one is attached the margin is zero rather
  // than the item's content column -- otherwise the attached block's own
  // opener would read as indented and refuse to open.
  if (s->state & STATE_LIST_CONTINUATION) {
    return s->indent > 0;
  }
  Block *b = indenting_container(s);
  if (b) {
    // Inside such a container, any indent at or above its content threshold
    // is the container's own margin, not heading-disqualifying fuzz.
    return s->indent < b->data;
  }
  return s->indent > 0;
}

static uint8_t count_blocks(Scanner *s, BlockType type) {
  uint8_t count = 0;
  for (int i = s->open_blocks->size - 1; i >= 0; --i) {
    Block *b = *array_get(s->open_blocks, i);
    if (b->type == type) {
      ++count;
    }
  }
  return count;
}

/// TRUE when `column` sits SHORT of the innermost INDENTING container's
/// content margin -- a lazy-continuation line, which belongs to the paragraph
/// above it only because nothing in the outer context claimed it first.
///
/// Takes the column rather than reading `s->indent`, and that is the whole
/// reason this is not simply `has_extra_indent`. `s->indent` is refreshed only
/// when a scan STARTS at column 0; the paragraph-closing decision runs from
/// the newline at the end of the PREVIOUS line, where it still holds whatever
/// that line left behind - measured as 0 for `  :::` at a list item's own
/// content column, which would report every fence as lazy and answer nothing.
/// The lexer's column is correct at that moment, because the container prefix
/// has already been consumed by the time the decision is made.
///
/// Also deliberately narrower than `has_extra_indent` in the no-container
/// case: that one reports "indented past column zero", and here the absence of
/// an indenting container has to read as NOT lazy, since at the document root
/// every line is at its own margin.
///
/// SCOPED TO INDENTING CONTAINERS ON PURPOSE. A block quote continues by its
/// `>` markers rather than by indentation, so it never appears in
/// `indenting_container` and never moves this margin. A quote has an escape
/// boundary of its own, and `escapes_open_block_quote` below answers that one.
static bool below_container_margin(Scanner *s, uint32_t column) {
  // A `+` continuation attaches its block flush left, so the item's margin is
  // zero and a flush-left line under it is not lazy at all.
  if (s->state & STATE_LIST_CONTINUATION) {
    return false;
  }
  Block *b = indenting_container(s);
  return b != NULL && column < b->data;
}

/// TRUE when a colon fence at `column` steps OUT of an open block quote: a
/// quote is open, and the column is EXACTLY the margin of the context that
/// holds it -- zero at the document root, the content column of the innermost
/// indenting container OUTSIDE the quote inside one.
///
/// THE COLUMN IS THE WHOLE ANSWER, and that is why this needs no plumbing. The
/// obvious spelling is a marker count (`count_blocks(BLOCK_QUOTE) >
/// s->block_quote_level`), and it was written, measured and reverted once
/// already: `block_quote_level` does not describe the current line at every
/// route into the paragraph-closing peek -- one of them runs after
/// `end_paragraph_in_block_quote` has consumed the markers -- so it turned the
/// fully-marked `> para` / `> :::note` / `> body` / `> :::` / `> tail`, one
/// quoted paragraph in all three engines, into a quote holding a div. The
/// column does not have that problem: the quote's own `> ` prefix occupies
/// columns, so a marked line's fence can never land ON the enclosing margin,
/// and the fully-marked shape fails this test for the same reason it is not
/// lazy (tree-sitter-carve#114, and #113 for the same lesson about `s->indent`).
///
/// THE MARGIN COMES FROM OUTSIDE THE QUOTE, which is why this walks the block
/// stack itself instead of reusing `indenting_container`. That helper answers
/// "the innermost container of any kind", and inside `> - item` / `>   :::note`
/// / `>   body` / `>   :::` / `>   tail` that is the list item WITHIN the quote,
/// whose content column already includes the `> ` prefix -- so the fully-marked
/// closer lands exactly on it and the argument above stops holding. All three
/// engines keep that document as one quoted list item. Anchoring on the
/// innermost open quote and looking only BELOW it restores the invariant: a
/// margin measured outside the quote is always at least two columns left of any
/// marked line's content.
///
/// EXACTLY at the margin, not "at or left of" and not "at or right of". Out in
/// the holding context a colon fence is a block opener only at that context's
/// own content column; one space either way is literal text (see
/// `Block::content_col`), so nothing claims the line and it folds back into the
/// paragraph above. All three engines agree in both directions: `> para` /
/// `:::note` / `body` / `  :::` / `tail` is a single quoted paragraph
/// (over-indented, corpus 158-indented-colon-fence-blocks-stay-literal is the
/// same rule), and so is the `- item` / `  > para` / `  :::note` / `  body` /
/// ` :::` / ` tail` form one column short of the item's content column.
///
/// The margin is `content_col`, NOT the `data` that `below_container_margin`
/// uses. The two questions differ: that one asks whether a line escapes a LIST
/// ITEM, whose boundary is the MARKER's column, and this one asks whether the
/// line would be a block OPENER outside the quote, which is a content column.
/// The ordered form separates them - under `1. ` the marker is at 0 and the
/// content at 3 - and all three engines keep a column-2 fence inside the quote
/// while a column-3 one ends it.
///
/// A container whose content column was never recorded reads 0 and gets no
/// opinion here, exactly as in `has_surplus_indent`.
static bool escapes_open_block_quote(Scanner *s, uint32_t column) {
  int i = s->open_blocks->size - 1;
  while (i >= 0 && (*array_get(s->open_blocks, i))->type != BLOCK_QUOTE) {
    --i;
  }
  if (i < 0) {
    // No quote is open, so there is none to step out of.
    return false;
  }
  // A `+` continuation attaches its block flush left, so the holding margin is
  // the document's zero rather than the item's content column.
  if (s->state & STATE_LIST_CONTINUATION) {
    return column == 0;
  }
  for (--i; i >= 0; --i) {
    Block *b = *array_get(s->open_blocks, i);
    if (is_list(b->type)) {
      // A list keeps its content column in a field of its own, because `data`
      // is the marker's column plus one and cannot tell `- ` from `1. `. A
      // container opened before that field existed reads 0 and gets no opinion,
      // exactly as in `has_surplus_indent`.
      return b->content_col != 0 && column == b->content_col;
    }
    if (b->type == FOOTNOTE || b->type == TABLE_CAPTION) {
      // Both push `s->indent + 2`, which IS their content column - the margin
      // does not follow the label's width. `[^a]: > para` and
      // `[^abcd]: > para` behave identically in all three engines: a fence at
      // column 2 ends the quote and opens a div in the footnote, one at column
      // 3 is indented and folds back into the quoted paragraph.
      return column == b->data;
    }
  }
  // Nothing indenting outside the quote: the document root holds it.
  return column == 0;
}


// Mark that we should close `count` blocks.
// This call will only emit a single BLOCK_CLOSE token,
// the other are emitted in `handle_blocks_to_close`.
static void close_blocks(Scanner *s, TSLexer *lexer, size_t count) {
#ifdef DEBUG
  assert(s->open_blocks->size > 0);
#endif
  if (s->open_blocks->size > 0) {
    remove_block(s);
    s->blocks_to_close = s->blocks_to_close + count - 1;
  }
  lexer->result_symbol = BLOCK_CLOSE;
}

// Output BLOCK_CLOSE tokens, delegated from previous iteration.
static bool handle_blocks_to_close(Scanner *s, TSLexer *lexer) {
  if (s->open_blocks->size == 0) {
    return false;
  }

  // If we reach eof with open blocks, we should close them all.
  if (lexer->eof(lexer) || s->blocks_to_close > 0) {
    lexer->result_symbol = BLOCK_CLOSE;
    remove_block(s);
    return true;
  } else {
    return false;
  }
}

static bool scan_identifier(Scanner *s, TSLexer *lexer) {
  bool any_scanned = false;
  while (!lexer->eof(lexer)) {
    if (carve_is_alnum_ascii(lexer->lookahead) || lexer->lookahead == '-' ||
        lexer->lookahead == '_') {
      any_scanned = true;
      advance(s, lexer);
    } else {
      return any_scanned;
    }
  }
  return any_scanned;
}

// Like `scan_identifier`, but the first character must be a letter or `_` (a
// leading `_` is valid, e.g. the `_box` div class). Carve class names and
// attribute keys are identifiers in this sense: a digit- or hyphen-leading
// token (`.123`, `12=v`, `-foo`) is not a valid attribute, matching the
// grammar's `_id_no_digit_start` and the spec rule that also makes `::: 123`
// not a div.
static bool scan_name_no_digit_start(Scanner *s, TSLexer *lexer) {
  int32_t c = lexer->lookahead;
  bool valid_first =
      (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
  if (!valid_first) {
    return false;
  }
  return scan_identifier(s, lexer);
}

static bool scan_until_unescaped(Scanner *s, TSLexer *lexer, char c) {
  while (!lexer->eof(lexer)) {
    if (lexer->lookahead == c) {
      return true;
    } else if (lexer->lookahead == '\\') {
      advance(s, lexer);
    }
    advance(s, lexer);
  }
  return false;
}

static bool parse_indented_content_spacer(Scanner *s, TSLexer *lexer,
                                          bool is_newline) {
  if (is_newline) {
    advance(s, lexer);
    lexer->mark_end(lexer);
  }
  lexer->result_symbol = INDENTED_CONTENT_SPACER;
  return true;
}

// Close open list if list markers are different.
static bool parse_list_item_continuation(Scanner *s, TSLexer *lexer) {
  Block *list = find_list(s);
  if (!list) {
    return false;
  }

  if (s->indent < list->data) {
    return false;
  }

  lexer->mark_end(lexer);
  lexer->result_symbol = LIST_ITEM_CONTINUATION;
  return true;
}

// A lone `+` on its own line is the list/block-quote continuation marker
// (PART 9 §17): it attaches the following flush-left block to the enclosing
// list item or block quote. The marker is only valid where the grammar expects
// it (inside a `_list_continuation` / `_quote_continuation`), so a top-level `+`
// or a `+ text` line stays a normal paragraph -- no scanner state is needed,
// the surrounding container stays open simply because no list/quote-closing
// token is valid right after the marker. The `+` must stand ALONE: only
// whitespace may follow before the line ends. Consumes the trailing newline so
// the attached block starts on a fresh line.
static bool parse_continuation_marker(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '+') {
    return false;
  }
  advance(s, lexer);
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(s, lexer);
  }
  if (!lexer->eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') {
    // `+ text` (or any trailing content) is not a marker.
    return false;
  }
  if (lexer->lookahead == '\r') {
    advance(s, lexer);
  }
  if (lexer->lookahead == '\n') {
    advance(s, lexer);
  }
  lexer->mark_end(lexer);
  // Only a LIST imposes a content margin that the attached flush-left block
  // would otherwise be dedented out of; a block quote's content already sits at
  // indent 0, so it needs no suppression (and must not get it, or its own
  // nested lists would never close).
  if (find_list(s) != NULL) {
    s->state |= STATE_LIST_CONTINUATION;
  }
  lexer->result_symbol = LIST_CONTINUATION_MARKER;
  return true;
}

// Close a block inside a list.
// They should be closed if indentation is too little.
static bool close_list_nested_block_if_needed(Scanner *s, TSLexer *lexer,
                                              bool non_newline) {
  if (s->open_blocks->size == 0) {
    return false;
  }

  // No open inline at block boundary.
  if (s->open_inline->size > 0) {
    return false;
  }

  Block *top = peek_block(s);
  Block *list = find_list(s);

  // A `+`-attached flush-left block (e.g. fenced code) legitimately sits at
  // indent 0, below the list margin: don't tear it out of the item.
  if (s->state & STATE_LIST_CONTINUATION) {
    return false;
  }

  // If we're in a block that's in a list
  // we should check the indentation level,
  // and if it's less than the current list, we need to close that block.
  if (non_newline && list && list != top) {
    if (s->indent < list->data) {
      lexer->result_symbol = BLOCK_CLOSE;
      remove_block(s);
      return true;
    }
  }

  return false;
}

static bool close_different_list_if_needed(Scanner *s, TSLexer *lexer,
                                           Block *list, TokenType list_marker) {
  // No open inline at block boundary.
  if (s->open_inline->size > 0) {
    return false;
  }
  if (list_marker != IGNORED) {
    BlockType to_open = list_marker_to_block(list_marker);
    if (list->type != to_open) {
      lexer->result_symbol = BLOCK_CLOSE;
      remove_block(s);
      return true;
    }
  }
  return false;
}

// Check if we're starting a list of a different type and close the open one.
static bool try_close_different_typed_list(Scanner *s, TSLexer *lexer,
                                           TokenType ordered_list_marker) {
  if (s->open_blocks->size == 0) {
    return false;
  }

  Block *top = peek_block(s);
  if (top->type == CODE_BLOCK) {
    return false;
  }
  Block *list = find_list(s);

  // If we're about to open a list of a different type, we
  // need to close the previous list.
  if (list) {
    if (close_different_list_if_needed(s, lexer, list, ordered_list_marker)) {
      return true;
    }
    TokenType other_list_marker = scan_unordered_list_marker_token(s, lexer);
    if (close_different_list_if_needed(s, lexer, list, other_list_marker)) {
      return true;
    }
  }

  return false;
}

/// Does the text AFTER a `:::` run open a block?
///
/// The one place that answers it. The opener branch in `parse_colon` and the
/// paragraph-closing peek in `scan_paragraph_closing_marker` both ask, and a
/// grammar where the two answer differently cuts the paragraph one line early
/// and then reads the next fence as a fresh opener - which is what produced
/// four of the five recorded over-acceptances (#103). There used to be a
/// `scan_div_marker` here that counted colons and stopped; it had no reachable
/// caller, so the live second spelling was the peek's own `colons >= 3`.
///
/// Call with the lexer already past the colons and their separating
/// whitespace: `bare` is true when the line ends there, `spaced` when any
/// separator was consumed, `c` is the first character of the tail.
///
/// A bare fence, a `[label]` (glued or not), and a line-block bar, hard-break
/// backslash or class name AFTER a separator are openers. A `{` attribute
/// block, a digit-leading class and a glued class name are not - those lines
/// are paragraph text per PART 9 §12.
///
/// The backslash form is the one tail that cannot be answered from its first
/// character, so this takes the lexer and reads past it. Both callers scan
/// ahead only; neither has committed a token end at the point it asks.
static bool colon_fence_tail_opens_block(Scanner *s, TSLexer *lexer, bool bare,
                                         bool spaced, int32_t c) {
  if (bare || c == '[') {
    return true;
  }
  // The local hard-break block, `::: \` (grammar.ebnf
  // `local_hard_break_block_open = colon_fence:open, space, backslash`). It
  // takes the separator like every other type token, and the backslash must be
  // the LAST thing on the line: `::: \ x` is an escaped space and `::: \\` an
  // escaped backslash, and carve-js renders both as ordinary paragraph text
  // where `::: \` and `::: \` plus trailing spaces open a `hardbreaks` div.
  if (c == '\\') {
    if (!spaced) {
      return false;
    }
    advance(s, lexer);
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(s, lexer);
    }
    return lexer->lookahead == '\n' || lexer->eof(lexer);
  }
  bool named = c == '|' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
               c == '_';
  return named && spaced;
}

// Try to close an open verbatim implicitly
// (should happen on a newline).
static bool try_implicit_close_verbatim(Scanner *s, TSLexer *lexer) {
  Inline *top = peek_inline(s);
  if (!top || top->type != VERBATIM) {
    return false;
  }
  if (top->data > 0) {
    remove_inline(s);
    lexer->result_symbol = VERBATIM_END;
    return true;
  } else {
    return false;
  }
}

// Parsing verbatim content is also responsible for parsing VERBATIM_END.
static bool parse_verbatim_content(Scanner *s, TSLexer *lexer) {
  Inline *top = peek_inline(s);
  if (!top || top->type != VERBATIM) {
    return false;
  }

  while (!lexer->eof(lexer)) {
    if (lexer->lookahead == '\n') {
      // We should only end verbatim if the paragraph is ended by a
      // blankline.

      // Advance over the first newline.
      advance(s, lexer);
      // Remove any whitespace on the next line.
      consume_whitespace(s, lexer);
      if (lexer->eof(lexer) || lexer->lookahead == '\n') {
        // Found a blankline, meaning the paragraph containing the varbatim
        // should be closed. So now we can close the verbatim.
        break;
      } else {
        // No blankline, continue parsing.
        lexer->mark_end(lexer);
      }
    } else if (lexer->lookahead == '`') {
      // If we find a `, we need to count them to see if we should stop.
      uint8_t current = consume_chars(s, lexer, '`');
      if (current == top->data) {
        // We found a matching number of `, stop content parsing.
        break;
      } else {
        // Found a number of ` that doesn't match the start,
        // we should consume them.
        lexer->mark_end(lexer);
      }
    } else {
      // Non-` token found, this we should consume.
      advance(s, lexer);
      lexer->mark_end(lexer);
    }
  }

  // Scanned all the verbatim.
  lexer->result_symbol = VERBATIM_CONTENT;
  return true;
}

// Does a run of `ticks` fence characters have the width the open code block's
// own opener had? The single width test behind every closer decision, so the
// three call sites below cannot drift apart the way an opener test and a peek
// test once did (#104).
static bool code_fence_run_matches_open_block(Scanner *s, uint8_t ticks) {
  Block *top = peek_block(s);
  return top && top->type == CODE_BLOCK && top->data == ticks;
}

// A code fence CLOSER carries nothing after its run but optional trailing
// whitespace: `fenced_code_block = ..., code_fence_close, newline` in the
// spec's grammar.ebnf, where `code_fence_close` is the run alone. A run that
// carries anything else -- ``` js -- is fence BODY, and the fence stays open
// (PART 9 §12 closes it at end of input).
//
// Call with the lexer positioned right after the run. It ADVANCES over the
// trailing whitespace, so a caller whose token must end at the run has to
// `mark_end` first, and no caller may fall through to an opener path after it.
static bool code_fence_closer_tail_is_blank(Scanner *s, TSLexer *lexer) {
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(s, lexer);
  }
  return lexer->lookahead == '\n' || lexer->lookahead == '\r' ||
         lexer->eof(lexer);
}

static bool try_end_code_block(Scanner *s, TSLexer *lexer, uint8_t ticks) {
  if (!code_fence_run_matches_open_block(s, ticks)) {
    return false;
  }
  // Pin the token at the run BEFORE the tail peek advances the lexer.
  lexer->mark_end(lexer);
  if (!code_fence_closer_tail_is_blank(s, lexer)) {
    return false;
  }
  remove_block(s);
  lexer->result_symbol = CODE_BLOCK_END;
  return true;
}

static bool try_close_code_block(Scanner *s, TSLexer *lexer, uint8_t ticks) {
  if (!code_fence_run_matches_open_block(s, ticks)) {
    return false;
  }
  // BLOCK_CLOSE is zero width: the scan-entry `mark_end` already pinned it at
  // the run's start, and nothing here may move it.
  if (!code_fence_closer_tail_is_blank(s, lexer)) {
    return false;
  }
  lexer->result_symbol = BLOCK_CLOSE;
  return true;
}

// Validate the info string that follows a backtick code fence (the rest of the
// opening line, after the ticks). The fence is opened only for an info string
// the grammar can model: empty, or a single language word optionally followed
// by a bracketed `[label]`. A `{` (attribute block) or a `key=value` pair makes
// the line NOT a fence (e.g. ```js title="x"`), so we refuse and let the
// backticks fall back to inline verbatim. The `=FORMAT` raw-block form is
// allowed (it is handled by the `raw_block` rule in the grammar).
//
// Must be called with the lexer positioned right after the ticks, before
// `mark_end` is committed for the begin token.
static bool code_fence_info_is_modeled(Scanner *s, TSLexer *lexer) {
  // Optional leading whitespace.
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(s, lexer);
  }
  // Empty info string: just a newline / EOF.
  if (lexer->lookahead == '\n' || lexer->eof(lexer)) {
    return true;
  }
  // The raw-block `=FORMAT` form (`raw_block_info` in the grammar) needs a
  // non-empty single-word format and nothing but trailing whitespace after it.
  if (lexer->lookahead == '=') {
    advance(s, lexer);
    uint8_t fmt_len = 0;
    while (lexer->lookahead != '\n' && !lexer->eof(lexer) &&
           lexer->lookahead != ' ' && lexer->lookahead != '\t' &&
           lexer->lookahead != '{' && lexer->lookahead != '}' &&
           lexer->lookahead != '=' && lexer->lookahead != '[' &&
           lexer->lookahead != '"') {
      fmt_len++;
      advance(s, lexer);
    }
    if (fmt_len == 0) {
      return false;
    }
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(s, lexer);
    }
    return lexer->lookahead == '\n' || lexer->eof(lexer);
  }
  // A `{` glued to the fence is never a code fence.
  if (lexer->lookahead == '{') {
    return false;
  }
  // Info string (PART 9 §2): an optional language word, then an optional quoted
  // "header", then an optional bracketed [label] -- in that order. Each must be
  // whitespace-separated from the preceding token, but the FIRST token may sit
  // directly against the fence. `had_token` tracks whether a prior token needs
  // a separating space; `saw_ws` whether one was seen.
  bool had_token = false;
  bool saw_ws = true;

  // Optional language word (a run that does not start a header/label and stops
  // at `"`/`[` so a glued header/label is not folded into the language).
  if (lexer->lookahead != '"' && lexer->lookahead != '[') {
    char word[4] = {0};
    uint8_t word_len = 0;
    while (lexer->lookahead != '\n' && !lexer->eof(lexer) &&
           lexer->lookahead != ' ' && lexer->lookahead != '\t' &&
           lexer->lookahead != '{' && lexer->lookahead != '}' &&
           lexer->lookahead != '=' && lexer->lookahead != '[' &&
           lexer->lookahead != '"') {
      if (word_len < 3) {
        word[word_len] = (char)lexer->lookahead;
      }
      word_len++;
      advance(s, lexer);
    }
    if (word_len == 0) {
      return false;
    }
    had_token = true;
    bool is_raw =
        word_len == 3 && word[0] == 'r' && word[1] == 'a' && word[2] == 'w';
    saw_ws = false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      saw_ws = true;
      advance(s, lexer);
    }
    if (lexer->lookahead == '\n' || lexer->eof(lexer)) {
      return true;
    }
    // The carve raw-block form `raw FORMAT` (`raw_block_info` in the grammar):
    // exactly one more single-word format follows the `raw` marker. (A `raw`
    // language with a quoted header is not modeled as a code block here -- it
    // falls back to inline verbatim rather than opening a fence.)
    if (is_raw) {
      uint8_t fmt_len = 0;
      while (lexer->lookahead != '\n' && !lexer->eof(lexer) &&
             lexer->lookahead != ' ' && lexer->lookahead != '\t' &&
             lexer->lookahead != '{' && lexer->lookahead != '}' &&
             lexer->lookahead != '=' && lexer->lookahead != '[' &&
             lexer->lookahead != '"') {
        fmt_len++;
        advance(s, lexer);
      }
      if (fmt_len == 0) {
        return false;
      }
      while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        advance(s, lexer);
      }
      return lexer->lookahead == '\n' || lexer->eof(lexer);
    }
  }

  // Optional quoted "header".
  if (lexer->lookahead == '"') {
    if (had_token && !saw_ws) {
      return false; // glued to the language token
    }
    advance(s, lexer);
    while (lexer->lookahead != '"' && lexer->lookahead != '\n' &&
           !lexer->eof(lexer)) {
      advance(s, lexer);
    }
    if (lexer->lookahead != '"') {
      return false; // unterminated header
    }
    advance(s, lexer);
    had_token = true;
    saw_ws = false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      saw_ws = true;
      advance(s, lexer);
    }
    if (lexer->lookahead == '\n' || lexer->eof(lexer)) {
      return true;
    }
  }

  // Optional bracketed [label].
  if (lexer->lookahead == '[') {
    if (had_token && !saw_ws) {
      return false; // glued to a preceding token
    }
    advance(s, lexer);
    while (lexer->lookahead != ']' && lexer->lookahead != '\n' &&
           !lexer->eof(lexer)) {
      advance(s, lexer);
    }
    if (lexer->lookahead != ']') {
      return false;
    }
    advance(s, lexer);
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(s, lexer);
    }
    return lexer->lookahead == '\n' || lexer->eof(lexer);
  }

  // Anything else (e.g. `key="x"`, a bare second word) is not a fence.
  return false;
}

static bool try_begin_code_block(Scanner *s, TSLexer *lexer, uint8_t ticks) {
  Block *top = peek_block(s);
  if (top && top->type == CODE_BLOCK) {
    return false;
  }
  // Mark the begin token at the ticks before peeking ahead to validate the
  // info string, so the lookahead is not folded into CODE_BLOCK_BEGIN.
  lexer->mark_end(lexer);
  if (!code_fence_info_is_modeled(s, lexer)) {
    return false;
  }
  push_block(s, CODE_BLOCK, ticks);
  lexer->result_symbol = CODE_BLOCK_BEGIN;
  return true;
}

/// A `%%%` comment fence, scanned line by line by the SCANNER rather than
/// matched as one multi-line token by the grammar.
///
/// The construct used to be a single `token()` regex, which cannot survive a
/// block quote: an internal token consumes its own text, so it would have to
/// eat the `> ` prefixes, and then the scanner never sees those lines and its
/// per-line block bookkeeping goes stale - the quote parsed as ERROR from the
/// fence onward (tree-sitter-carve#45).
///
/// Nor can the body be `optional(block_quote_prefix) line` the way a code
/// block's is: after the prefix token the parser is committed to a content
/// line, so the closer is never offered and the fence runs to the end of the
/// document. The scanner already knows the fence's width and the quote depth,
/// so it decides where the body ends and the grammar is left with three plain
/// tokens and no ambiguity to resolve.
///
/// Consume a run of block-quote markers and then a `%` run, and report the
/// width. Used to ask, of the line the lexer is sitting on, "is this the
/// closer?" - the answer is an EXACT width match, the rule the carve engines
/// follow: a `%%%%` line does not close a `%%%` fence.
static uint8_t scan_comment_fence_line_width(Scanner *s, TSLexer *lexer) {
  bool ending_newline = false;
  uint8_t markers = scan_block_quote_markers(s, lexer, &ending_newline);
  if (ending_newline) {
    return 0;
  }
  // The line has to sit at the fence's OWN quote depth. A `> %%%` does not
  // close a fence opened at the top level - there the `%%%` was never a fence
  // at all, it was an unterminated opener, which degrades to a line comment -
  // and a `> %%%` does not close one opened at `> > `. The open BLOCK_QUOTE
  // blocks are that depth, so no extra bookkeeping is needed.
  if (markers != count_blocks(s, BLOCK_QUOTE)) {
    return 0;
  }
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(s, lexer);
  }
  return consume_chars(s, lexer, '%');
}

/// Consume the rest of the line, leaving the lexer ON its newline.
static void scan_to_line_end(Scanner *s, TSLexer *lexer) {
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    advance(s, lexer);
  }
}

static bool parse_comment_fence(Scanner *s, TSLexer *lexer,
                                const bool *valid_symbols) {
  // Nothing to say unless one of this construct's tokens is wanted here: the
  // classification below CONSUMES the line, and a probe that consumes and then
  // declines leaves every later probe in the same call reading from the middle
  // of it.
  if (!valid_symbols[BLOCK_CLOSE] && !valid_symbols[COMMENT_FENCE_CONTENT] &&
      !valid_symbols[COMMENT_FENCE_END]) {
    return false;
  }
  Block *top = peek_block(s);
  if (!top || top->type != COMMENT_FENCE) {
    return false;
  }
  uint8_t width = top->data;

  // Is the line the lexer sits on this fence's closer? Asked once, because
  // asking twice would leave the second question looking at the middle of the
  // first answer.
  uint8_t percents = scan_comment_fence_line_width(s, lexer);
  bool closes = percents == width;

  if (closes) {
    // The end marker is asked for FIRST where both are valid, the order the
    // code fence beside this one uses: `_block_close` is zero-width, so if it
    // answered here too it would answer forever and the marker would never be
    // reached.
    if (valid_symbols[COMMENT_FENCE_END]) {
      // Trailing text on a closer is allowed and discarded (`%%% end`), so the
      // marker runs to the end of its line.
      scan_to_line_end(s, lexer);
      remove_block(s);
      lexer->mark_end(lexer);
      lexer->result_symbol = COMMENT_FENCE_END;
      return true;
    }
    // `_block_close` comes before the end marker in the rule and is zero-width,
    // so the closer line is still there for the marker token.
    if (valid_symbols[BLOCK_CLOSE]) {
      lexer->result_symbol = BLOCK_CLOSE;
      return true;
    }
    return false;
  }

  if (!valid_symbols[COMMENT_FENCE_CONTENT]) {
    return false;
  }
  // Body lines, up to but not including the closer. Whatever prefixes they
  // carry are the comment's, which is the whole point of scanning them here.
  bool consumed = false;
  while (!lexer->eof(lexer)) {
    scan_to_line_end(s, lexer);
    if (lexer->eof(lexer)) {
      break;
    }
    advance(s, lexer);
    consumed = true;
    lexer->mark_end(lexer);
    if (lexer->eof(lexer)) {
      break;
    }
    if (scan_comment_fence_line_width(s, lexer) == width) {
      break;
    }
  }
  if (!consumed) {
    return false;
  }
  lexer->result_symbol = COMMENT_FENCE_CONTENT;
  return true;
}

static bool parse_comment_fence_begin(Scanner *s, TSLexer *lexer,
                                      const bool *valid_symbols) {
  if (!valid_symbols[COMMENT_FENCE_BEGIN]) {
    return false;
  }
  Block *top = peek_block(s);
  if (top && top->type == COMMENT_FENCE) {
    return false;
  }
  uint8_t percents = consume_chars(s, lexer, '%');
  if (percents < 3) {
    return false;
  }
  lexer->mark_end(lexer);

  // An UNTERMINATED `%%%` is not a fence: the engines degrade it to a
  // single-line comment rather than swallowing the rest of the document, and
  // the regex this replaces required a closer too. Look for one before
  // committing - the lookahead is scratch, since the token end is already
  // pinned at the opener.
  scan_to_line_end(s, lexer);
  while (!lexer->eof(lexer)) {
    advance(s, lexer);
    if (lexer->eof(lexer)) {
      return false;
    }
    if (scan_comment_fence_line_width(s, lexer) == percents) {
      push_block(s, COMMENT_FENCE, percents);
      lexer->result_symbol = COMMENT_FENCE_BEGIN;
      return true;
    }
    scan_to_line_end(s, lexer);
  }
  return false;
}

static bool parse_backtick(Scanner *s, TSLexer *lexer,
                           const bool *valid_symbols) {
  if (!valid_symbols[CODE_BLOCK_BEGIN] && !valid_symbols[CODE_BLOCK_END] &&
      !valid_symbols[BLOCK_CLOSE] && !valid_symbols[VERBATIM_BEGIN] &&
      !valid_symbols[VERBATIM_END]) {
    return false;
  }

  uint8_t ticks = consume_chars(s, lexer, '`');
  if (ticks == 0) {
    return false;
  }

  if (ticks >= 3) {
    if (valid_symbols[CODE_BLOCK_END] && try_end_code_block(s, lexer, ticks)) {
      return true;
    }
    if (valid_symbols[BLOCK_CLOSE] && try_close_code_block(s, lexer, ticks)) {
      return true;
    }
    // Both closer paths peek past the run to see whether the rest of the line
    // is blank, and that peek advances the lexer. When the run had the open
    // fence's own width but the tail disqualified it, this line is fence BODY:
    // stop here rather than fall through to the opener path below, whose
    // `mark_end` would pin the begin token past the whitespace the peek ate.
    if ((valid_symbols[CODE_BLOCK_END] || valid_symbols[BLOCK_CLOSE]) &&
        code_fence_run_matches_open_block(s, ticks)) {
      return false;
    }
    // Pin the token end at the ticks before `try_begin_code_block` peeks past
    // them to validate the fence info string: that validation may advance the
    // lexer before failing, and the verbatim fallback below must not swallow
    // the lookahead (it intentionally does not re-mark).
    lexer->mark_end(lexer);
    // COLUMN ZERO. An indented fence opens nothing; the line is paragraph
    // text, and the ticks fall through to the verbatim handling below exactly
    // as they would mid-paragraph (corpus 11-fenced-code). Only the OPENER is
    // guarded -- a closer is matched against its opener's block, above.
    if (valid_symbols[CODE_BLOCK_BEGIN] && !has_extra_indent(s) &&
        try_begin_code_block(s, lexer, ticks)) {
      return true;
    }
  }

  Inline *top = peek_inline(s);
  if (valid_symbols[VERBATIM_END] && top && top->type == VERBATIM) {
    remove_inline(s);
    // For ticks >= 3 the end is already pinned above (fence validation may have
    // advanced the lexer); only re-mark for the 1-2 tick inline case.
    if (ticks < 3) {
      lexer->mark_end(lexer);
    }
    lexer->result_symbol = VERBATIM_END;
    return true;
  }
  if (valid_symbols[VERBATIM_BEGIN]) {
    // For ticks >= 3 the end is already pinned above; re-mark here for the
    // 1-2 tick inline-verbatim case where no fence validation ran.
    if (ticks < 3) {
      lexer->mark_end(lexer);
    }
    lexer->result_symbol = VERBATIM_BEGIN;
    push_inline(s, VERBATIM, ticks);
    return true;
  }
  return false;
}

// Scan a '- ' or similar.

/// Consume an attribute block GLUED to a list marker, if one is there.
///
/// `1.{.x} item` and `-{.x} item` are lists in every engine: the marker takes an
/// attribute block before its separator, and the block's own rules apply inside
/// it - including quoting, so the `}` in `1.{title='a}b'} item` closes nothing
/// (carve#215, corpus `a-marker-attribute-may-hold-a-quoted-brace`).
///
/// This grammar required a space directly after the marker, so every one of
/// those lines stayed a paragraph: no list highlighting, no indentation
/// behaviour, no item textobject, for a line every renderer treats as an item
/// (#81). `scan_valid_inline_attribute` already validates the payload and is
/// quote-aware, so the marker path reuses it rather than growing a second
/// brace-matching loop that could disagree with the first.
///
/// Returns false only when a `{` is present and does NOT form a valid block -
/// `1.{not!} item` stays a paragraph, which is what the attribute grammar says.
static bool scan_marker_attribute(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '{') {
    return true;
  }

  return scan_valid_inline_attribute(s, lexer);
}

static bool scan_bullet_list_marker(Scanner *s, TSLexer *lexer, char marker) {
  if (lexer->lookahead != marker) {
    return false;
  }
  advance(s, lexer);
  if (!scan_marker_attribute(s, lexer)) {
    return false;
  }
  if (lexer->lookahead != ' ') {
    return false;
  }
  advance(s, lexer);
  return true;
}

/// Classify a COLON-led line in ONE pass: `:: ` opens a definition TERM, `:`
/// plus two or more spaces a DESCRIPTION, anything else neither.
///
/// One pass, because the lexer cannot rewind and both markers begin with the
/// same character: asking "is it a term?" and then "is it a description?"
/// leaves the second question looking at the middle of the first answer, which
/// is how a `:  d` line stopped being recognized after a term (#48).
///
/// The separator is a space and only a space - `::t` is a paragraph, and a tab
/// in its place is one too, the rule every other marker follows. A description
/// needs TWO spaces because ONE is what a term's own lazy continuation looks
/// like: `:: t` / `: d` renders `<dt>t\n: d</dt>` in every engine. Spaces past
/// the second belong to the marker, so `:  d` and `:   d` are the same item.
static TokenType scan_definition_marker_token(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != ':') {
    return IGNORED;
  }
  advance(s, lexer);
  if (lexer->lookahead == ':') {
    advance(s, lexer);
    if (lexer->lookahead != ' ') {
      return IGNORED;
    }
    advance(s, lexer);
    return LIST_MARKER_DEFINITION;
  }
  if (lexer->lookahead != ' ') {
    return IGNORED;
  }
  advance(s, lexer);
  if (lexer->lookahead != ' ') {
    return IGNORED;
  }
  while (lexer->lookahead == ' ') {
    advance(s, lexer);
  }
  return LIST_MARKER_DESCRIPTION;
}

// Scan a `> ` or `>\n`.
static bool scan_block_quote_marker(Scanner *s, TSLexer *lexer,
                                    bool *ending_newline) {
  if (lexer->lookahead != '>') {
    return false;
  }
  advance(s, lexer);

  // Carriage returns should be ignored.
  if (lexer->lookahead == '\r') {
    advance(s, lexer);
  }
  if (lexer->lookahead == ' ') {
    advance(s, lexer);
    return true;
  } else if (lexer->lookahead == '\n') {
    advance(s, lexer);
    *ending_newline = true;
    return true;
  } else {
    return false;
  }
}

static uint8_t scan_block_quote_markers(Scanner *s, TSLexer *lexer,
                                        bool *ending_newline) {
  uint8_t marker_count = 0;
  while (scan_block_quote_marker(s, lexer, ending_newline)) {
    ++marker_count;
    if (*ending_newline) {
      break;
    }
  }
  return marker_count;
}

static void output_block_quote_continuation(Scanner *s, TSLexer *lexer,
                                            uint8_t marker_count,
                                            bool ending_newline) {
  // It's important to always clear the stored level on newlines.
  if (ending_newline) {
    s->block_quote_level = 0;
  } else {
    s->block_quote_level = marker_count;
  }
  lexer->result_symbol = BLOCK_QUOTE_CONTINUATION;
}

// Parse block quote related things.
//
// It's made complicated by the need to match nested quotes,
// but we still want to keep block quotes separated,
// so we can't match '> > ' in one go, but in multiple passes.
//
// We also need to close any contained paragraphs if there's a mismatch of
// quote indentation, or if there's an "empty line" (only > on a line).
//
// And we also need to close open blocks when we go down a nesting level.
static bool parse_block_quote(Scanner *s, TSLexer *lexer,
                              const bool *valid_symbols) {
  if (!valid_symbols[BLOCK_QUOTE_BEGIN] &&
      !valid_symbols[BLOCK_QUOTE_CONTINUATION] && !valid_symbols[BLOCK_CLOSE] &&
      !valid_symbols[CLOSE_PARAGRAPH]) {
    return false;
  }

  bool ending_newline = false;
  // A valid marker is a '> ' or '>\n'.
  bool has_marker = scan_block_quote_marker(s, lexer, &ending_newline);

  // No open inline at block boundary.
  bool any_open_inline = s->open_inline->size > 0;

  // If we have a marker but with an empty line,
  // we need to close the paragraph.
  if (has_marker && ending_newline && !any_open_inline &&
      valid_symbols[CLOSE_PARAGRAPH]) {
    lexer->result_symbol = CLOSE_PARAGRAPH;
    return true;
  }

  // Store nesting level on the scanner, to keep it between runs
  // in the case of multiple `>`, like `> > > txt`.
  uint8_t marker_count = s->block_quote_level + has_marker;
  size_t matching_block_pos =
      number_of_blocks_from_top(s, BLOCK_QUOTE, marker_count);
  Block *highest_block_quote = find_block(s, BLOCK_QUOTE);

  // There's an open block quote with a higher nesting level.
  if (highest_block_quote && marker_count < highest_block_quote->data &&
      !any_open_inline) {
    // Close the paragraph, but allow lazy continuation (without any `>`).
    if (valid_symbols[CLOSE_PARAGRAPH] && has_marker) {
      lexer->result_symbol = CLOSE_PARAGRAPH;
      return true;
    }
    if (valid_symbols[BLOCK_CLOSE]) {
      // We may need to close more than one block (nested block quotes, lists,
      // divs, etc).
      size_t close_pos =
          number_of_blocks_from_top(s, BLOCK_QUOTE, marker_count + 1);
      close_blocks(s, lexer, close_pos);
      return true;
    }
  }

  // If we should continue an open block quote.
  if (valid_symbols[BLOCK_QUOTE_CONTINUATION] && has_marker &&
      matching_block_pos != 0) {
    lexer->mark_end(lexer);
    output_block_quote_continuation(s, lexer, marker_count, ending_newline);
    return true;
  }

  // Finally, start a new block quote if there's any marker.
  if (valid_symbols[BLOCK_QUOTE_BEGIN] && has_marker) {
    push_block(s, BLOCK_QUOTE, marker_count);
    lexer->mark_end(lexer);
    // It's important to always clear the stored level on newlines.
    if (ending_newline) {
      s->block_quote_level = 0;
    } else {
      s->block_quote_level = marker_count;
    }
    lexer->result_symbol = BLOCK_QUOTE_BEGIN;
    return true;
  }

  return false;
}

static bool is_decimal(char c) { return '0' <= c && c <= '9'; }
static bool is_lower_alpha(char c) { return 'a' <= c && c <= 'z'; }
static bool is_upper_alpha(char c) { return 'A' <= c && c <= 'Z'; }
static bool is_lower_roman(char c) {
  switch (c) {
  case 'i':
  case 'v':
  case 'x':
  case 'l':
  case 'c':
  case 'd':
  case 'm':
    return true;
  default:
    return false;
  }
}
static bool is_upper_roman(char c) {
  switch (c) {
  case 'I':
  case 'V':
  case 'X':
  case 'L':
  case 'C':
  case 'D':
  case 'M':
    return true;
  default:
    return false;
  }
}

static bool matches_ordered_list(OrderedListType type, char c) {
  switch (type) {
  case DECIMAL:
    return is_decimal(c);
  case LOWER_ALPHA:
    return is_lower_alpha(c);
  case UPPER_ALPHA:
    return is_upper_alpha(c);
  case LOWER_ROMAN:
    return is_lower_roman(c);
  case UPPER_ROMAN:
    return is_upper_roman(c);
  default:
    return false;
  }
}

static bool scan_ordered_list_type(Scanner *s, TSLexer *lexer,
                                   OrderedListType *res) {
  bool can_be_decimal = true;
  uint8_t scanned_decimal = 0;
  bool can_be_lower_roman = true;
  uint8_t scanned_lower_roman = 0;
  bool can_be_upper_roman = true;
  uint8_t scanned_upper_roman = 0;
  bool can_be_lower_alpha = true;
  uint8_t scanned_lower_alpha = 0;
  bool can_be_upper_alpha = true;
  uint8_t scanned_upper_alpha = 0;

  while (!lexer->eof(lexer)) {
    char c = lexer->lookahead;

    if (can_be_decimal) {
      if (matches_ordered_list(DECIMAL, c)) {
        ++scanned_decimal;
      } else {
        can_be_decimal = false;
      }
    }
    if (can_be_lower_roman) {
      if (matches_ordered_list(LOWER_ROMAN, c)) {
        ++scanned_lower_roman;
      } else {
        can_be_lower_roman = false;
      }
    }
    if (can_be_upper_roman) {
      if (matches_ordered_list(UPPER_ROMAN, c)) {
        ++scanned_upper_roman;
      } else {
        can_be_upper_roman = false;
      }
    }
    if (can_be_lower_alpha) {
      if (matches_ordered_list(LOWER_ALPHA, c)) {
        ++scanned_lower_alpha;
      } else {
        can_be_lower_alpha = false;
      }
    }
    if (can_be_upper_alpha) {
      if (matches_ordered_list(UPPER_ALPHA, c)) {
        ++scanned_upper_alpha;
      } else {
        can_be_upper_alpha = false;
      }
    }
    if (!can_be_decimal && !can_be_lower_roman && !can_be_upper_roman &&
        !can_be_lower_alpha && !can_be_upper_alpha) {
      break;
    }

    advance(s, lexer);
  }

  if (scanned_decimal > 0) {
    *res = DECIMAL;
    return true;
  }

  // If we're already inside an alpha list then we should
  // prioritize to continue the alpha list, otherwise we should
  // prioritize roman lists.
  Block *top = peek_block(s);
  bool inside_alpha_list = top && is_alpha_list(top->type);

  if (inside_alpha_list) {
    // Alpha lists are only a single letter wide.
    if (scanned_lower_alpha == 1) {
      *res = LOWER_ALPHA;
      return true;
    }
    if (scanned_upper_alpha == 1) {
      *res = UPPER_ALPHA;
      return true;
    }
  }

  // Note that we don't check if marker is a valid roman numeral.
  if (scanned_lower_roman > 0) {
    *res = LOWER_ROMAN;
    return true;
  }
  if (scanned_upper_roman > 0) {
    *res = UPPER_ROMAN;
    return true;
  }

  if (scanned_lower_alpha == 1) {
    *res = LOWER_ALPHA;
    return true;
  }
  if (scanned_upper_alpha == 1) {
    *res = UPPER_ALPHA;
    return true;
  }
  return false;
}

static TokenType scan_ordered_list_marker_token_type(Scanner *s,
                                                     TSLexer *lexer) {
  // A marker is `a)` or `a.` - the delimiter TRAILS the value. A wrapped
  // `(a)` is not one: `(1) First` and `(a) x` are paragraphs in every engine
  // (corpus 156-parenthesized-ordered-marker). Accepting the wrapped form
  // coloured ordinary parenthesised prose as a list.

  OrderedListType list_type;
  if (!scan_ordered_list_type(s, lexer, &list_type)) {
    // BARE DOT (carve#472). The value may be omitted when the delimiter is
    // `.`: a bare `. ` is a decimal ordered marker counting from 1. It shares
    // the decimal-dot flavour, so it opens and continues the same list as `1.`
    // and needs no token of its own.
    //
    // Only `.` may drop its value. A lone `)` stays paragraph text, which is
    // why this is guarded on the delimiter and on not having consumed a `(` -
    // `() x` is not a marker either. The caller requires the trailing space,
    // so `.x` and a bare `.` on its own line are unaffected.
    if (lexer->lookahead == '.') {
      advance(s, lexer);
      return LIST_MARKER_DECIMAL_PERIOD;
    }
    return IGNORED;
  }

  switch (lexer->lookahead) {
  case ')':
    advance(s, lexer);
    {
      switch (list_type) {
      case DECIMAL:
        return LIST_MARKER_DECIMAL_PAREN;
      case LOWER_ALPHA:
        return LIST_MARKER_LOWER_ALPHA_PAREN;
      case UPPER_ALPHA:
        return LIST_MARKER_UPPER_ALPHA_PAREN;
      case LOWER_ROMAN:
        return LIST_MARKER_LOWER_ROMAN_PAREN;
      case UPPER_ROMAN:
        return LIST_MARKER_UPPER_ROMAN_PAREN;
      default:
        return IGNORED;
      }
    }
  case '.':
    // a.
    advance(s, lexer);
    switch (list_type) {
    case DECIMAL:
      return LIST_MARKER_DECIMAL_PERIOD;
    case LOWER_ALPHA:
      return LIST_MARKER_LOWER_ALPHA_PERIOD;
    case UPPER_ALPHA:
      return LIST_MARKER_UPPER_ALPHA_PERIOD;
    case LOWER_ROMAN:
      return LIST_MARKER_LOWER_ROMAN_PERIOD;
    case UPPER_ROMAN:
      return LIST_MARKER_UPPER_ROMAN_PERIOD;
    default:
      return IGNORED;
    }
  default:
    return IGNORED;
  }
}

static TokenType scan_ordered_list_marker_token(Scanner *s, TSLexer *lexer) {
  TokenType res = scan_ordered_list_marker_token_type(s, lexer);
  if (res == IGNORED) {
    return res;
  }

  if (!scan_marker_attribute(s, lexer)) {
    return IGNORED;
  }

  if (lexer->lookahead == ' ') {
    advance(s, lexer);
    return res;
  } else {
    return IGNORED;
  }
}

// Scans a task marker box. `x`/`X` are the checked states; ` `, `_`, `-`,
// `>`, `?` are the unchecked states (spec grammar.ebnf task_state; every
// non-x state renders as an unchecked checkbox, matching djot-php).
static bool scan_task_list_marker(Scanner *s, TSLexer *lexer) {
  // The caller has consumed `<bullet> `, one space. A RUN of spaces before the
  // checkbox is still a task marker - `-   [ ] a` renders a checkbox in every
  // engine, the same way `#   H` is a heading - and requiring exactly one put
  // an ERROR inside the marker node (corpus 75-list-nesting-and-looseness-9).
  // Tabs are not accepted: the separator is a space.
  while (lexer->lookahead == ' ') {
    advance(s, lexer);
  }
  if (lexer->lookahead != '[') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != 'x' && lexer->lookahead != 'X' &&
      lexer->lookahead != ' ' && lexer->lookahead != '_' &&
      lexer->lookahead != '-' && lexer->lookahead != '>' &&
      lexer->lookahead != '?') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != ']') {
    return false;
  }
  advance(s, lexer);
  return lexer->lookahead == ' ';
}

static TokenType scan_unordered_list_marker_token(Scanner *s, TSLexer *lexer) {
  // A task marker token can be started with either `-` or `*` and still be of
  // the same type. `+` is never a bullet in Carve, so it cannot open a task
  // list.
  if (scan_bullet_list_marker(s, lexer, '-')) {
    if (scan_task_list_marker(s, lexer)) {
      return LIST_MARKER_TASK_BEGIN;
    } else {
      return LIST_MARKER_DASH;
    }
  }
  if (scan_bullet_list_marker(s, lexer, '*')) {
    if (scan_task_list_marker(s, lexer)) {
      return LIST_MARKER_TASK_BEGIN;
    } else {
      return LIST_MARKER_STAR;
    }
  }
  return scan_definition_marker_token(s, lexer);
}

static TokenType scan_list_marker_token(Scanner *s, TSLexer *lexer) {
  TokenType unordered = scan_unordered_list_marker_token(s, lexer);
  if (unordered != IGNORED) {
    return unordered;
  }
  return scan_ordered_list_marker_token(s, lexer);
}

static bool scan_list_marker(Scanner *s, TSLexer *lexer) {
  TokenType marker = scan_list_marker_token(s, lexer);
  return marker != IGNORED;
}

// NORMATIVE -- "MARKER REQUIRES CONTENT" (grammar, unordered_item/ordered_item
// and PART 9 §11): a bullet or ordered marker opens a list item ONLY when it is
// followed by NON-EMPTY content on the same line. Trailing whitespace is
// ignored, so a content-less marker line -- bare (`-`) or whitespace-only
// (`- `, `-   `) -- is paragraph text, not a list; `-` and `- ` behave
// identically. Call with the lexer positioned at (or just past) the marker's
// separating space, AFTER the token end has been marked: the scratch advances
// here consume only trailing blanks and do not extend the committed token.
static bool marker_line_has_content(Scanner *s, TSLexer *lexer) {
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(s, lexer);
  }
  return !lexer->eof(lexer) && lexer->lookahead != '\n' &&
         lexer->lookahead != '\r';
}

static bool scan_eof_or_blankline(Scanner *s, TSLexer *lexer) {
  if (lexer->eof(lexer)) {
    return true;
    // We've already parsed any leading whitespace in the beginning of the
    // scan function.
  } else if (lexer->lookahead == '\n') {
    advance(s, lexer);
    return true;
  } else {
    return false;
  }
}

// Variant for closing an open PARAGRAPH. A LIST MARKER does NOT interrupt a
// standalone paragraph: with no open list, a bullet or ordered marker folds
// into the open paragraph as plain text (§10 -- no list interrupts a
// paragraph; a blank line is required before a list). This holds at the top
// level and, by lazy continuation, inside a block quote: "> quoted \n - item"
// is ONE quote whose paragraph is "quoted\n- item", not a quote plus a sibling
// list. Only a HEADING, a bounded title, is ended by a list marker (handled via
// the full helper in parse_heading). The `+` continuation marker (corpus 100)
// is the way to attach a REAL list to a quote.
//
// The DEFINITION TERM marker is the single exception, and it is the engines'
// exception, not this grammar's: `x` / `:: t` is a paragraph plus a `<dl>` in
// carve-js, carve-php and carve-rs (tree-sitter-carve#108). It is scoped to
// the term marker alone -- a DESCRIPTION marker attaches to a term, so with no
// definition list open `x` / `:  d` stays one paragraph in all three.
//
// When a list IS already open, a marker WITH CONTENT is a list operation, not
// a fold: it continues the list with a sibling item (or, for a different
// type/indent, closes it and opens a new one), so it still ends the item's
// paragraph -- e.g. consecutive "- a \n - b" stay separate items. Pinned by
// carve corpus 76-paragraph-interruption, 77/81 lazy-continuation, and
// 05-lists.
//
// MARKER REQUIRES CONTENT applies here too, same as the definition-marker
// branch below already does: a content-less bullet/ordered marker line does
// not open a sibling item, so it must not close the current item's paragraph
// either. Without the check, "- a" / "- " / "x" closed the paragraph here,
// then the item-end lookahead (which independently applies the same rule,
// tree-sitter-carve#94) ended the item too -- landing the marker line and the
// text after it OUTSIDE the item as a new top-level paragraph, where every
// engine keeps both lines INSIDE the item as lazy text (tree-sitter-carve#75).
static bool scan_paragraph_closing_marker(Scanner *s, TSLexer *lexer) {
  // A COLON-led line is classified in one pass, because every candidate starts
  // with the same run of colons and the lexer cannot rewind: `:::`+ is a
  // container marker, `:: ` a definition TERM, `:` plus two spaces a
  // DESCRIPTION. Asking the container probe first consumed the colons the
  // marker probe needed, so a sibling `:: term` was swallowed by the term above
  // it (tree-sitter-carve#48).
  if (lexer->lookahead == ':') {
    // Read before the colons are consumed: the margin test below needs where
    // the LINE starts, not where the fence's tail ended up.
    uint32_t marker_column = lexer->get_column(lexer);
    uint8_t colons = consume_chars(s, lexer, ':');
    if (colons >= 3) {
      // A COLON FENCE ENDS THE PARAGRAPH ONLY WHEN IT IS REALLY A MARKER.
      // Counting the colons and stopping here is what closed the paragraph one
      // line early: `::: {.x}` is not an opener, so the line is paragraph text,
      // yet the peek ended the paragraph on it and the trailing `:::` three
      // lines down was then read as a fresh opener (#103). The tail test is
      // the opener's own, shared rather than restated.
      bool spaced = false;
      while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        advance(s, lexer);
        spaced = true;
      }
      int32_t c = lexer->lookahead;
      bool bare = c == '\n' || lexer->eof(lexer);
      if (!colon_fence_tail_opens_block(s, lexer, bare, spaced, c)) {
        // Paragraph text - and from here the paragraph is "expecting a
        // closer": a later BARE fence is text too (PART 9 §12).
        s->state |= STATE_FENCE_ABSORBS;
        return false;
      }
      if (!bare) {
        // A valid opener carrying something interrupts even after a malformed
        // sibling: `::: {.x}` / `x` / `::: note` is a paragraph plus an
        // admonition in every engine.
        return true;
      }
      // Bare. A closer for a div that is actually open is still that closer,
      // absorption or not - the flag only suppresses opening a NEW div.
      if (number_of_blocks_from_top(s, DIV, colons) > 0) {
        return true;
      }
      // ...and the absorption is the PARAGRAPH's, so it reaches only as far as
      // the container that paragraph lives in. A fence BELOW the container's
      // content margin is a lazy-continuation line: the outer context is
      // offered it first, and out there no paragraph is expecting a closer, so
      // it ends the item and opens its div. `- item` / `:::note` / `body` /
      // `:::` / `tail` is a one-item list plus a div holding `tail` in
      // carve-js, carve-php and carve-rs alike, at any fence width
      // (tree-sitter-carve#106).
      //
      // Only this consumption side needs the margin; the SETTING side is
      // already right. A malformed fence absorbed lazily still governs a later
      // fence at the item's own column - `- item` / `:::note` / `  body` /
      // `  :::` / `  tail` is one item in all three engines, where the same
      // `  :::` without the `:::note` above it opens a div inside the item.
      //
      // A block quote reaches only as far too, and because it continues by its
      // `>` markers rather than by indentation its boundary is asked
      // separately: an unmarked fence at the margin of the context HOLDING the
      // quote is offered to that context first, and out there nothing is
      // expecting a closer. `> para` / `:::note` / `body` / `:::` / `tail` is a
      // quote holding one paragraph plus a document-level div in carve-js,
      // carve-php and carve-rs alike, while the same document with every line
      // marked is a single quoted paragraph (tree-sitter-carve#114).
      if (s->state & STATE_FENCE_ABSORBS) {
        return escapes_open_block_quote(s, marker_column) ||
               below_container_margin(s, marker_column);
      }
      return true;
    }
    Block *open_list = find_list(s);
    // Inside a DEFINITION list, a marker-shaped colon line ends the item above
    // it on its SHAPE alone - deliberately unlike every other list, where the
    // marker must carry content. MARKER REQUIRES CONTENT still applies to the
    // marker itself: the line is paragraph text, it just is not part of the
    // term or description above it. `:: t` / `:: ` / `x` is a one-term `<dl>`
    // followed by a paragraph holding both remaining lines in carve-rs and
    // carve-php (markup-carve/carve#788; carve-js folds it into the term and is
    // the outlier, filed as markup-carve/carve-js#731).
    //
    // The separator space is the whole of the shape test. A BARE `::` carries
    // no separator, so it is not marker-shaped at all and continues the term
    // lazily - which is what all three engines do with it, and why this is not
    // simply "a colon run ends the term".
    //
    // The shape-only rule is scoped to a definition list because a colon line
    // has no marker meaning anywhere else: inside a bullet item, `- a` / `:: `
    // / `x` keeps both lines in the item as lazy text in every engine, exactly
    // like the content-less bullet line #98 fixed. Only a colon marker WITH
    // content ends a bullet item (`- a` / `:: b` is a `<ul>` plus a `<dl>`),
    // which is what the content test below still answers.
    bool in_definition_list =
        open_list != NULL && open_list->type == LIST_DEFINITION;
    if (colons == 2) {
      // A definition TERM marker is the ONE list marker that interrupts a
      // standalone paragraph, which is why no open list is required here: it
      // OPENS the list rather than continuing one, exactly as the opener in
      // `parse_colon` already models it. `x` / `:: t` is a paragraph plus a
      // one-term `<dl>` in carve-js, carve-php and carve-rs alike
      // (tree-sitter-carve#108). MARKER REQUIRES CONTENT is what keeps `x` /
      // `:: ` a single paragraph, and the separator test keeps `x` / `::` one
      // too - both measured against all three engines.
      //
      // No indent test here on purpose: the opener has none either, and this
      // peek must answer exactly the question the opener answers. An INDENTED
      // term marker opens a `<dl>` in this grammar where every engine keeps
      // paragraph text (` :: t` on its own already does, with no paragraph
      // above it), and a peek that refused an indented marker the opener still
      // accepts produced an ERROR tree. That laxity is the opener's, it is
      // pre-existing, and it is tracked separately.
      if (lexer->lookahead != ' ') {
        return false;
      }
      advance(s, lexer);
      return in_definition_list || marker_line_has_content(s, lexer);
    }
    // One colon: a DESCRIPTION attaches to a TERM, so with no list open at all
    // it is not a marker and cannot interrupt anything - `x` / `:  d` is one
    // paragraph in every engine. Same requirement the opener states.
    if (open_list == NULL) {
      return false;
    }
    // A description needs a SECOND space, since one space is the term's own
    // lazy continuation.
    if (lexer->lookahead != ' ') {
      return false;
    }
    advance(s, lexer);
    if (lexer->lookahead != ' ') {
      return false;
    }
    return in_definition_list || marker_line_has_content(s, lexer);
  }
  if (find_list(s) == NULL) {
    return false;
  }
  if (!scan_list_marker(s, lexer)) {
    return false;
  }
  return marker_line_has_content(s, lexer);
}

/// Record where the innermost container's content starts.
///
/// Called at every site that opens a list, with the column the lexer sits at
/// once the marker and its separator are consumed. Kept separate from
/// `ensure_list_open` because a CONTINUED list keeps the column it opened with -
/// re-recording would let a lazily-indented later item move it.
static void set_content_col(Scanner *s, uint8_t col) {
  Block *top = peek_block(s);
  if (top && top->content_col == 0) {
    top->content_col = col;
  }
}

static void ensure_list_open(Scanner *s, BlockType type, uint8_t indent) {
  Block *top = peek_block(s);
  // Found a list with the same type and indent, we should continue it.
  if (top && top->type == type && top->data == indent) {
    return;
    // There might be other cases, like if the top list is a list of different
    // types, but that's handled by BLOCK_CLOSE in `close_list_if_needed` and
    // we shouldn't see that state here.
  }

  push_block(s, type, indent);
}

static bool handle_ordered_list_marker(Scanner *s, TSLexer *lexer,
                                       const bool *valid_symbols,
                                       TokenType marker) {
  if (marker != IGNORED && valid_symbols[marker]) {
    // Mark the token end (after the marker's space) before the content probe,
    // so the scratch advances in `marker_line_has_content` cannot extend it.
    lexer->mark_end(lexer);
    // A content-less marker line is paragraph text, not a list.
    if (!marker_line_has_content(s, lexer)) {
      return false;
    }
    ensure_list_open(s, list_marker_to_block(marker), s->indent + 1);
    // The lexer sits just past the marker's separator here (mark_end above), so
    // this is the content column for every marker WIDTH - `1. `, `a) `, `iv. `.
    set_content_col(s, (uint8_t)lexer->get_column(lexer));
    lexer->result_symbol = marker;
    return true;
  } else {
    return false;
  }
}

// Consumes until newline or eof, only allowing 'c' or whitespace.
// Returns the number of 'c' encountered (0 if any other character is
// encountered).
static uint8_t consume_line_with_char_or_whitespace(Scanner *s, TSLexer *lexer,
                                                    char c) {
  uint8_t seen = 0;
  while (!lexer->eof(lexer)) {
    if (lexer->lookahead == c) {
      ++seen;
      advance(s, lexer);
    } else if (lexer->lookahead == ' ') {
      advance(s, lexer);
    } else if (lexer->lookahead == '\r') {
      advance(s, lexer);
    } else if (lexer->lookahead == '\n') {
      return seen;
    } else {
      return 0;
    }
  }
  return seen;
}

// Does a document-level closing frontmatter marker exist anywhere later in
// the input? Called right after the OPENING run of `-` characters has been
// consumed (so the lexer sits at whatever follows them on the opener line).
// Frontmatter content is raw text end to end (`frontmatter_content` is just
// `repeat1($._line)`, an unparsed `/[^\n]*/` per line), so the closer is
// simply the first later line that is, from column 0, nothing but three or
// more '-' characters and trailing horizontal whitespace - the identical
// shape `parse_list_marker_or_thematic_break` itself commits to when it is
// asked to recognize that same line as the closer.
//
// Deliberately takes only `lexer`, never `Scanner *s`: every `advance` here
// is a plain read with no effect on persistent scanner state (no indent,
// list or block-quote tracking touched), so however far this travels -
// potentially to the end of the document - there is nothing left to unwind
// if the caller ultimately decides not to use what it finds. An earlier
// attempt at this same lookahead (tree-sitter-carve#95) used the ordinary
// state-tracking helpers to scan ahead and, on failing to find a closer,
// left `Scanner *s` mid-document for the NEXT token - this function is
// written to make that class of mistake impossible by construction rather
// than by care.
static bool frontmatter_has_closer(TSLexer *lexer) {
  // Skip whatever remains of the OPENER line (optional whitespace and/or a
  // language tag per the grammar) without caring about its shape.
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    lexer->advance(lexer, false);
  }
  if (lexer->eof(lexer)) {
    return false;
  }
  lexer->advance(lexer, false); // the opener line's own newline

  // `frontmatter_content` is `repeat1($._line)`: at least ONE content line is
  // grammatically required between the opener and the closer, so the very
  // next line can never itself close the block, however it is shaped -
  // `---` immediately followed by another `---` is not empty, closed
  // frontmatter, it is still an unclosed opener (tracked separately as the
  // "---" + "---" no-error family). Consume that mandatory line unconditionally
  // before the closer search below even starts looking.
  if (lexer->eof(lexer)) {
    return false;
  }
  while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
    lexer->advance(lexer, false);
  }
  if (lexer->eof(lexer)) {
    return false;
  }
  lexer->advance(lexer, false); // the mandatory content line's newline

  while (!lexer->eof(lexer)) {
    uint32_t dashes = 0;
    while (lexer->lookahead == '-') {
      ++dashes;
      lexer->advance(lexer, false);
    }
    if (dashes >= 3) {
      while (lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
             lexer->lookahead == '\r') {
        lexer->advance(lexer, false);
      }
      if (lexer->eof(lexer) || lexer->lookahead == '\n') {
        return true;
      }
    }
    // Not a closer: skip to the end of this line and try the next one.
    while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
      lexer->advance(lexer, false);
    }
    if (lexer->eof(lexer)) {
      return false;
    }
    lexer->advance(lexer, false);
  }
  return false;
}

// Either parse a list item marker (like '- ') or a thematic break
// (like '- - -').
static bool parse_list_marker_or_thematic_break(
    Scanner *s, TSLexer *lexer, const bool *valid_symbols, char marker,
    TokenType marker_type, BlockType list_type, TokenType thematic_break_type) {
  // This is a bit ugly to do here, but eh, refactoring will look very ugly.
  bool check_frontmatter = valid_symbols[FRONTMATTER_MARKER] && marker == '-';

  if (!check_frontmatter && !valid_symbols[marker_type] &&
      !valid_symbols[thematic_break_type] &&
      !valid_symbols[LIST_MARKER_TASK_BEGIN]) {
    return false;
  }

#ifdef DEBUG
  assert(lexer->lookahead == marker);
#endif
  // A bullet marker that begins exactly where the previous list marker on
  // this line ended is a marker-line nested list (`- - A`, corpus
  // 103-marker-line-nested-lists): its list nests at the marker's own column
  // instead of continuing the outer list at the line indent.
  uint32_t start_col = lexer->get_column(lexer);
  uint8_t list_indent = s->indent;
  if (start_col > s->indent && s->marker_end_col != 0 &&
      start_col == s->marker_end_col) {
    list_indent = (uint8_t)start_col;
  }
  advance(s, lexer);

  // A GLUED ATTRIBUTE BLOCK. `-{.x} item` and `*{.x} item` are lists in every
  // engine: the marker takes an attribute block before its separator, and the
  // block's own rules apply inside it, so the `}` in `-{title='a}b'} item`
  // closes nothing. The ordered markers gained this in #81; bullets come
  // through here instead, where the character right after the marker decides
  // everything below (tree-sitter-carve#89).
  //
  // Consumed BEFORE the two probes below, both of which are inert on a `{`
  // anyway - a frontmatter run needs marker characters and a thematic break
  // needs a second marker or a space - and forced off explicitly once a block
  // is taken, because after it the lookahead IS a space and the break test
  // would otherwise say yes.
  bool marker_attribute = false;
  if (lexer->lookahead == '{' &&
      (valid_symbols[marker_type] || valid_symbols[LIST_MARKER_TASK_BEGIN])) {
    // No rewind on failure, which is the same contract the ordered path uses:
    // an invalid payload (`-{not!} item`) refuses the token and the line parses
    // as a paragraph, which is what the attribute grammar says it is.
    if (!scan_valid_inline_attribute(s, lexer)) {
      return false;
    }
    marker_attribute = true;
  }

  // We should prioritize a thematic break over lists.
  // We need to remember if a '- ' is found, which means we can open a list.
  bool can_be_list_marker =
      (valid_symbols[marker_type] || valid_symbols[LIST_MARKER_TASK_BEGIN]) &&
      lexer->lookahead == ' ';

  // We have now checked the two first characters.
  uint32_t marker_count = lexer->lookahead == marker ? 2 : 1;

  // COLUMN ZERO. An indented `***` is a paragraph, not a break (corpus
  // 130-thematic-break-requires-contiguous-markers). The list marker below is
  // deliberately NOT guarded: a list may be indented, a block opener may not.
  bool can_be_thematic_break = valid_symbols[thematic_break_type] &&
                               !marker_attribute && !has_extra_indent(s) &&
                               (marker_count == 2 || lexer->lookahead == ' ');

  // We might have scanned a '- ', we need to mark the end here
  // so we can go back to simply returning a list marker that
  // only consumes these two characters.
  advance(s, lexer);
  lexer->mark_end(lexer);
  // The column just past the COMMITTED token, captured here because the content
  // probe below advances the lexer as scratch - reading the column after it
  // returns wherever that probe stopped, which broke `- - A` (corpus
  // 103-marker-line-nested-lists) while this was being written.
  uint8_t marker_content_col = (uint8_t)lexer->get_column(lexer);

  // Whether the probes below have consumed marker characters from the rest of
  // the line. The lexer cannot rewind, so what they eat decides the CONTENT
  // question further down: a line of markers reaches the newline, and the
  // content check would then see nothing and call the line content-less. It is
  // not - the marker characters ARE the content. `- -` and `- - ` are a list
  // whose item holds a literal `-`, because MARKER REQUIRES CONTENT applies to
  // the INNER marker and leaves it as text; carve-rs, carve-js and carve-php
  // all publish `<ul><li>-</li></ul>` where this grammar flattened the pair to
  // a paragraph (tree-sitter-carve#48).
  bool consumed_line_of_markers = false;

  // Check frontmatter, if needed.
  if (check_frontmatter) {
    uint8_t frontmatter_run = consume_chars(s, lexer, marker);
    marker_count += frontmatter_run;
    if (marker_count >= 3) {
      // The boundary for FRONTMATTER_MARKER either way: just the marker
      // characters themselves, matching what a closed frontmatter opener has
      // always produced here.
      lexer->mark_end(lexer);
      // `can_be_thematic_break` is only true when a thematic break is ALSO
      // grammatically valid at this exact position - which is the document
      // start (frontmatter is optional there), never the closing-marker
      // position inside `frontmatter_content` (raw lines, no thematic break
      // reachable). So this gate is what tells the OPENING commitment apart
      // from the CLOSING one without needing any extra state: the closer
      // keeps committing unconditionally below, exactly as before.
      if (can_be_thematic_break) {
        // PART 9 section 12: "an opener with no exact closer ahead opens
        // nothing" - already the rule for the `%%%` comment block and the
        // code fence. An unclosed `---` at document start is the same shape,
        // and every engine reads it as a thematic break instead
        // (tree-sitter-carve#95).
        if (frontmatter_has_closer(lexer)) {
          lexer->result_symbol = FRONTMATTER_MARKER;
          return true;
        }
        // No closer anywhere in the rest of the document: fall back to a
        // thematic break, spanning exactly the marker run already consumed
        // above (the `mark_end` call before the lookahead). Any trailing
        // same-line whitespace after the markers cannot also be folded into
        // this token: `frontmatter_has_closer` has already read past this
        // line (and potentially to the end of the document) to answer the
        // closer question, so the lexer's physical position is no longer
        // right after the marker run, and `mark_end` cannot be pointed
        // backward to reclaim it. Every case this fixes
        // (tree-sitter-carve#95) is a bare `---` with nothing else on the
        // line, where this boundary is already exact.
        lexer->result_symbol = thematic_break_type;
        return true;
      }
      lexer->result_symbol = FRONTMATTER_MARKER;
      return true;
    }
    consumed_line_of_markers = frontmatter_run > 0;
  }

  // Check a thematic break that can span the entire line.
  if (can_be_thematic_break) {
    uint8_t trailing = consume_line_with_char_or_whitespace(s, lexer, marker);
    marker_count += trailing;
    if (marker_count >= 3) {
      lexer->result_symbol = thematic_break_type;
      lexer->mark_end(lexer);
      return true;
    }
    consumed_line_of_markers = consumed_line_of_markers || trailing > 0;
  }

  if (can_be_list_marker) {
    if (valid_symbols[LIST_MARKER_TASK_BEGIN]) {
      if (scan_task_list_marker(s, lexer)) {
        ensure_list_open(s, LIST_TASK, list_indent + 1);
        set_content_col(s, marker_content_col);
        // The chain column is right after the committed token: two characters
        // for a bare `<bullet> `, more when the marker took an attribute block.
        s->marker_end_col = marker_content_col;
        lexer->result_symbol = LIST_MARKER_TASK_BEGIN;
        return true;
      }
    }

    if (valid_symbols[marker_type]) {
      // A content-less marker line is paragraph text, not a list (the token end
      // is already marked above, so this lookahead is scratch).
      if (!consumed_line_of_markers && !marker_line_has_content(s, lexer)) {
        return false;
      }
      ensure_list_open(s, list_type, list_indent + 1);
      set_content_col(s, marker_content_col);
      s->marker_end_col = marker_content_col;
      lexer->result_symbol = marker_type;
      return true;
    }
  }

  return false;
}

static bool scan_verbatim_to_end_no_newline(Scanner *s, TSLexer *lexer) {
  uint8_t tick_count = consume_chars(s, lexer, '`');
  if (tick_count == 0) {
    return false;
  }
  while (!lexer->eof(lexer)) {
    switch (lexer->lookahead) {
    case '\\':
      advance(s, lexer);
      advance(s, lexer);
      break;
    case '`':
      if (consume_chars(s, lexer, '`') == tick_count) {
        return true;
      }
      break;
    case '\n':
      return false;
    default:
      advance(s, lexer);
    }
  }
  return false;
}

static bool scan_ref_def(Scanner *s, TSLexer *lexer) {
  // Link label in a definition can be any inline except newlines.
  while (!lexer->eof(lexer) && lexer->lookahead != ']') {
    switch (lexer->lookahead) {
    case '\\':
      advance(s, lexer);
      advance(s, lexer);
      break;
    case '\n':
      return false;
    case '`':
      // We must have ending ticks for this to be a valid label.
      if (!scan_verbatim_to_end_no_newline(s, lexer)) {
        return false;
      }
      break;
    default:
      advance(s, lexer);
    }
  }

  if (lexer->lookahead != ']') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != ':') {
    return false;
  }
  advance(s, lexer);

  // THE SEPARATOR IS A SPACE (U+0020), NOT WHITESPACE. The spec states it for
  // all three definition markers - "A tab does NOT satisfy `space`, so
  // `[^a]:<TAB>x`, `[a]:<TAB>/url` and `*[HTML]:<TAB>x` are ordinary
  // paragraphs, not definitions" - and names carve-rs as the reference.
  //
  // Measured against carve-rs, it is the FIRST character after the colon that
  // has to be a space; whitespace after that is free:
  //
  //   [a]: /url      definition        [a]:<TAB>/url   paragraph
  //   [a]:   /url    definition        [a]:<TAB> /url  paragraph
  //   [a]: <TAB>/url definition        [a]:/url        paragraph
  //
  // Refusing here rather than in grammar.js is what puts the line back on the
  // paragraph path. Tightening the separator token instead leaves the rule
  // matching a truncated `[a]:` and the rest of the line parsing as something
  // else, because the destination group is optional and the rule's tail accepts
  // trailing whitespace (tree-sitter-carve#83).
  if (lexer->lookahead != ' ') {
    return false;
  }

  return true;
}

static bool parse_ref_def_begin(Scanner *s, TSLexer *lexer,
                                const bool *valid_symbols) {
  if (!valid_symbols[LINK_REF_DEF_MARK_BEGIN]) {
    return false;
  }
  if (!scan_ref_def(s, lexer)) {
    return false;
  }

  push_block(s, LINK_REF_DEF, 0);
  lexer->result_symbol = LINK_REF_DEF_MARK_BEGIN;
  return true;
}

static bool parse_link_ref_def_label_end(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != ']') {
    return false;
  }
  Block *top = peek_block(s);
  if (!top || top->type != LINK_REF_DEF) {
    return false;
  }

  // Prevent inline from reaching outside of the link label.
  if (s->open_inline->size > 0) {
    return false;
  }

  remove_block(s);
  lexer->result_symbol = LINK_REF_DEF_LABEL_END;
  return true;
}

/// The footnote scan from just AFTER the caret, so the caller can look one
/// character past it before choosing between a footnote and a reference
/// definition (see `parse_open_bracket`).
static bool scan_footnote_after_caret(Scanner *s, TSLexer *lexer) {
  // Identifier can have surrounding whitespace
  consume_whitespace(s, lexer);
  if (!scan_identifier(s, lexer)) {
    return false;
  }
  consume_whitespace(s, lexer);

  // Scan `]:`
  if (lexer->lookahead != ']') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != ':') {
    return false;
  }
  advance(s, lexer);

  // A footnote definition's body STARTS on the marker line: the grammar reads
  // `"]:", space, inline_content, newline`, so `[^a]:` alone is not one - the
  // line and what follows it are paragraph text (corpus
  // 132-footnote-definition-requires-an-inline-body). The separator is a
  // literal SPACE; a tab in its place leaves a paragraph too. This is where a
  // footnote definition parts company with a LINK reference definition, which
  // is allowed to carry nothing after the colon (corpus 34-reference-link-9).
  if (lexer->lookahead != ' ') {
    return false;
  }
  consume_whitespace(s, lexer);
  if (lexer->eof(lexer) || lexer->lookahead == '\n') {
    return false;
  }

  return true;
}

static bool parse_footnote_after_caret(Scanner *s, TSLexer *lexer,
                                       const bool *valid_symbols) {
  if (!valid_symbols[FOOTNOTE_MARK_BEGIN]) {
    return false;
  }
  if (!scan_footnote_after_caret(s, lexer)) {
    return false;
  }

  if (!valid_symbols[IN_FALLBACK]) {
    push_block(s, FOOTNOTE, s->indent + 2);
  }

  lexer->result_symbol = FOOTNOTE_MARK_BEGIN;

  return true;
}

static bool parse_open_bracket(Scanner *s, TSLexer *lexer,
                               const bool *valid_symbols) {
  // Needs to differentiate between:
  //
  //   [^x]: footnote
  //   [yy]: link definition
  //
  // Both markers are zero-width tokens that scans the entire line for
  // validity.

  if (!valid_symbols[FOOTNOTE_MARK_BEGIN] &&
      !valid_symbols[LINK_REF_DEF_MARK_BEGIN]) {
    return false;
  }

  // COLUMN ZERO, same rule the heading marker follows. A definition opens only
  // at its container's content column; an indented `[x]:` / `[^x]:` is ordinary
  // paragraph text, not a definition with a stray space (corpus
  // 157-indented-reference-and-footnote-definitions-stay-literal).
  if (has_extra_indent(s)) {
    return false;
  }

  // Scan initial `[^`
  if (lexer->lookahead != '[') {
    return false;
  }
  advance(s, lexer);

  if (lexer->lookahead == '^') {
    advance(s, lexer);
    // An EMPTY footnote label is not a footnote label: `footnote_label` is
    // one-or-more characters, so `[^]: /u` is a LINK reference definition whose
    // label is `^` (carve#632, corpus
    // 184-a-caret-is-a-reference-label-not-an-empty-footnote). The caret is
    // already consumed here, which is exactly where the ref-def scan expects to
    // pick up: it reads to `]` and then requires `]:`. Committing to the
    // footnote path on the caret alone left this line a paragraph, and with it
    // every reference to the label (carve-rs style oracle: the reference side
    // `[text][^]` already parsed here, so the two halves disagreed).
    if (lexer->lookahead == ']') {
      return parse_ref_def_begin(s, lexer, valid_symbols);
    }
    return parse_footnote_after_caret(s, lexer, valid_symbols);
  }
  return parse_ref_def_begin(s, lexer, valid_symbols);
}

static bool parse_dash(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  return parse_list_marker_or_thematic_break(s, lexer, valid_symbols, '-',
                                             LIST_MARKER_DASH, LIST_DASH,
                                             THEMATIC_BREAK_DASH);
}

static bool parse_star(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  return parse_list_marker_or_thematic_break(s, lexer, valid_symbols, '*',
                                             LIST_MARKER_STAR, LIST_STAR,
                                             THEMATIC_BREAK_STAR);
}

static bool parse_list_item_end(Scanner *s, TSLexer *lexer,
                                const bool *valid_symbols) {
  // Captured before the block-quote / list-marker scans below advance the
  // lexer: the first non-whitespace character of the line, used to tell whether
  // a `+`-attached TABLE is still continuing (a `|` row).
  int32_t line_lead = lexer->lookahead;

  // We only look at the top, list item end is only valid if we're
  // about to close the list. Otherwise we need to close the open blocks
  // first.
  Block *list = peek_block(s);
  if (!list || !is_list(list->type)) {
    return false;
  }

  // We're still inside the list, don't end it yet.
  if (s->indent >= list->data) {
    return false;
  }

  // No open inline at block boundary.
  if (s->open_inline->size > 0) {
    return false;
  }

  // Scanning the block prefix markers are necessary so we can
  // tell if we should end a list item or not.
  // For example in a list like this:
  //
  //   > - a
  //   > - b
  //
  // If we should end the `a` list item we need to be able to scan `- b`
  // later in this function.
  // But first we need to skip the `> ` tokens.
  bool ending_newline;
  uint8_t block_quote_markers =
      scan_block_quote_markers(s, lexer, &ending_newline);

  // Delayed output of BLOCK_QUOTE_CONTINUATION, if necessary.
  uint8_t has_block_quote_continuation = false;

  if (block_quote_markers > 0) {
    uint8_t block_quotes = count_blocks(s, BLOCK_QUOTE);

    if (block_quotes != block_quote_markers) {
      lexer->result_symbol = LIST_ITEM_END;
      s->blocks_to_close = 1;
      return true;
    }

    // With a sparse list we need to scan past one newline:
    //
    //   > - a
    //   >
    //   > - b
    //
    // By scanning once again we allow `next_marker` below to find `- b`.
    if (ending_newline) {
      // If we're not ending the list, for example with an indented paragraph:
      //
      //   > - a
      //   >
      //   >   text
      //
      // Then we should output a block quote prefix.
      if (valid_symbols[BLOCK_QUOTE_CONTINUATION]) {
        has_block_quote_continuation = true;
      }

      bool second_newline;
      uint8_t second_block_quote_markers =
          scan_block_quote_markers(s, lexer, &second_newline);

      if (block_quotes != second_block_quote_markers) {
        lexer->result_symbol = LIST_ITEM_END;
        s->blocks_to_close = 1;
        return true;
      }
    }

    // Check indent again after we've parsed the block quote markers.
    // This to allow indented paragraphs inside lists:
    //
    //   > - a
    //   >
    //   >   text
    //
    if (has_block_quote_continuation) {
      s->indent = consume_whitespace(s, lexer);
      if (s->indent >= list->data) {
        lexer->mark_end(lexer);
        output_block_quote_continuation(s, lexer, block_quote_markers,
                                        ending_newline);
        return true;
      }
    }
  }

  // Handle the special case of a list item following this,
  // which may close the entire list if it's of a different type
  // or a mismatching indent. For instance:
  //
  //      - a
  //
  //    - b     <- different indent should close the `a` list.
  TokenType next_marker = scan_list_marker_token(s, lexer);

  // While a `+`-attached flush-left block is being parsed, an indent-0 line
  // that is NOT a sibling list marker (e.g. a table's second row) belongs to
  // the attached block, so the item must not end. A real sibling marker ends
  // the attached block and clears the continuation.
  if (s->state & STATE_LIST_CONTINUATION) {
    // A `+`-attached TABLE has no terminator and pushes/pops a block per row,
    // so only a `|` row keeps the item open; anything else (a sibling marker, a
    // plain flush-left paragraph, EOF) ends the attached block and clears the
    // continuation so the item -- and list -- can close normally.
    if (line_lead == '|' && next_marker == IGNORED && !lexer->eof(lexer)) {
      return false;
    }
    s->state &= ~STATE_LIST_CONTINUATION;
  }

  // MARKER REQUIRES CONTENT applies to this LOOKAHEAD too. `scan_list_marker_token`
  // answers "does a marker start here", and the real scan in
  // `parse_list_marker_or_thematic_break` additionally requires content on the
  // line. When the two disagree the parser is told the item ends, then nothing
  // can open the next one, and a valid document lands in ERROR:
  //
  //     - a
  //     -            <- `- ` with nothing after it
  //     x
  //
  // parsed as three ERROR nodes, while every engine keeps the line and the one
  // after it inside the item as lazy text (tree-sitter-carve#75). The bare `-`
  // form never reached here, because it has no separator and so is not a marker
  // at all - only the spaced form could produce the mismatch.
  if (next_marker != IGNORED && !marker_line_has_content(s, lexer)) {
    // Treated as "no sibling marker here", which ends the item the ordinary way
    // instead of promising one that cannot open.
    //
    // NOT `return false`: refusing the token entirely puts the parse back in
    // ERROR and loses the list_item as well - measured. The line therefore ends
    // up OUTSIDE the item, as a top-level paragraph, where the engines keep it
    // inside as lazy text. That remaining difference is recorded in #75; this
    // takes a valid document out of ERROR, which is the half that breaks
    // highlighting today.
    next_marker = IGNORED;
  }

  if (next_marker != IGNORED) {
    bool different_type = list_marker_to_block(next_marker) != list->type;
    bool different_indent = list->data != s->indent + 1;

    // If we're continuing the list we shouldn't emit a BLOCK_CLOSE.
    if (different_type || different_indent) {
      s->blocks_to_close = 1;
    }
    lexer->result_symbol = LIST_ITEM_END;
    return true;
  }

  lexer->result_symbol = LIST_ITEM_END;
  s->blocks_to_close = 1;
  return true;
}

static bool parse_colon(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  // Nothing block-level opens inside a code fence - the body is data. The
  // heading scanner has carried this guard since it was written; the colon
  // scanner did not, so a `::: tip` line in a fence body was taken as a real
  // container opener and the ENCLOSING container's closer then had nothing to
  // match (corpus 69-opaque-spans-inside-a-container-3, which was skipped for
  // parsing as ERROR). The fence's own closer is CODE_BLOCK_END and is
  // unaffected.
  {
    Block *in_code = peek_block(s);
    if (in_code && in_code->type == CODE_BLOCK) {
      return false;
    }
  }
  bool can_be_div = valid_symbols[DIV_BEGIN] || valid_symbols[DIV_END] ||
                    valid_symbols[BLOCK_CLOSE];
  bool can_be_definition = valid_symbols[LIST_MARKER_DEFINITION] ||
                           valid_symbols[LIST_MARKER_DESCRIPTION];
  if (!can_be_definition && !can_be_div) {
    return false;
  }
#ifdef DEBUG
  assert(lexer->lookahead == ':');
#endif
  advance(s, lexer);

  // A definition TERM: `::` plus a literal space. Checked before the div
  // branch, which needs THREE colons, so `:::` and deeper still open a
  // container. A `::` with no space is neither - `::t` is a paragraph.
  uint8_t colons_consumed = 1;
  if (lexer->lookahead == ':') {
    advance(s, lexer);
    if (lexer->lookahead == ' ') {
      if (!valid_symbols[LIST_MARKER_DEFINITION]) {
        return false;
      }
      advance(s, lexer);
      // Mark the token end before the content probe (scratch advances must not
      // extend it), then require non-empty content: a content-less `:: ` line
      // is paragraph text, not a term.
      lexer->mark_end(lexer);
      if (!marker_line_has_content(s, lexer)) {
        return false;
      }
      ensure_list_open(s, LIST_DEFINITION, s->indent + 1);
      lexer->result_symbol = LIST_MARKER_DEFINITION;
      return true;
    }
    // Not a term: fall through to the div branch with TWO colons already
    // consumed, so `:::` and deeper still open a container.
    colons_consumed = 2;
  } else if (lexer->lookahead == ' ') {

    // A definition DESCRIPTION: `:` plus TWO or more spaces. ONE space is a
    // term's own lazy continuation (`:: t` / `: d` is `<dt>t\n: d</dt>` in
    // every engine), so the second space is what makes this a marker at all.
    advance(s, lexer);
    if (lexer->lookahead != ' ') {
      return false;
    }
    if (!valid_symbols[LIST_MARKER_DESCRIPTION]) {
      return false;
    }
    // A description attaches to a TERM: with no definition list open above it,
    // `:  d` is an ordinary paragraph, which is what all three engines render.
    // The term marker has no such requirement - it opens the list itself.
    Block *open_list = find_list(s);
    if (!open_list || open_list->type != LIST_DEFINITION) {
      return false;
    }
    while (lexer->lookahead == ' ') {
      advance(s, lexer);
    }
    lexer->mark_end(lexer);
    if (!marker_line_has_content(s, lexer)) {
      return false;
    }
    ensure_list_open(s, LIST_DEFINITION, s->indent + 1);
    lexer->result_symbol = LIST_MARKER_DESCRIPTION;
    return true;
  }

  if (!can_be_div) {
    return false;
  }

  // We consumed one or two colons in the start of the function.
  uint8_t colons = consume_chars(s, lexer, ':') + colons_consumed;
  if (colons < 3) {
    return false;
  }

  // A fence line that CARRIES something - a class, a line-block `|`, a
  // `[label]` - is an OPENER, even when a div of the same width is already
  // open: `:::: note` nests inside `:::: note`, and so does `::: tip` inside
  // `::: note` (corpus 181-openers-past-the-nesting-cap-are-one-paragraph and
  // nested-containers-2, both of which render nested `<aside>` elements). Only
  // a BARE fence closes.
  //
  // Deciding by WIDTH alone made every equal-width opener a closer, and a
  // closer with a class name after it is not a line the grammar has - so the
  // whole document came apart from the second opener on (#59). The separator
  // whitespace is consumed here rather than inside the opener branch, because
  // the answer is needed before the branch is chosen.
  bool spaced = false;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(s, lexer);
    spaced = true;
  }
  int32_t c = lexer->lookahead;
  bool bare = c == '\n' || lexer->eof(lexer);

  size_t from_top = bare ? number_of_blocks_from_top(s, DIV, colons) : 0;

  if (from_top == 0) {
    if (!valid_symbols[DIV_BEGIN]) {
      return false;
    }
    // COLUMN ZERO, the same rule the heading marker and the definition
    // markers follow. An indented `:::` opens nothing: it is paragraph text
    // (corpus 158-indented-colon-fence-blocks-stay-literal). A CLOSER is left
    // alone here -- it is handled below, and `has_extra_indent` already
    // measures against the innermost container, so a fence at a list item's
    // content column is not "indented".
    if (has_extra_indent(s)) {
      return false;
    }
    // Validate what follows the `:::` fence. A bare fence (newline/EOF), a
    // line-block bar (`|`), a hard-break backslash (`\`), a class name (letter
    // or `_`), or a bare grouping label (`[...]`, a typeless tab member; PART 9
    // §12) is fine. A `{` attribute block (`::: {.x}`), a digit-leading class
    // (`::: 123`), or any other lead char makes the line a literal paragraph
    // per the spec, so refuse the div opener there.
    //
    // A CLASS, a line-block bar or a hard-break backslash needs the separator
    // space: `:::note`, `:::|` and `:::\` are paragraphs in every engine, the
    // same rule every other marker follows. A bare fence and a glued `[label]`
    // do not - `:::` alone opens a div and `:::[First]` opens a labelled one,
    // both checked against the engine. The test lives in
    // `colon_fence_tail_opens_block` so the paragraph-closing peek applies the
    // SAME one.
    //
    // For the backslash form the token END lands past the backslash rather
    // than at the separator, because the tail test has to read the rest of the
    // line to answer at all and the lexer cannot rewind. `div_marker_begin`
    // therefore covers the whole `::: \` opener; the other spaced forms keep
    // their tail token (`line_block_marker`, `class_name`) outside it.
    bool ok = colon_fence_tail_opens_block(s, lexer, bare, spaced, c);
    // ...and a bare fence is not an opener at all while the open paragraph is
    // absorbing: after a malformed `::: {.x}` the trailing `:::` is text, at
    // any width (PART 9 §12). The peek above normally keeps the parser inside
    // the paragraph so this branch is not reached, but the two must agree.
    if (ok && bare && (s->state & STATE_FENCE_ABSORBS)) {
      ok = false;
    }
    if (!ok) {
      // EMIT rather than refuse. Refusing leaves the lexer past the colons -
      // `mark_end` above already committed the token to them - and the `{`
      // then read as the start of a line, so `::: {.c}` built a block
      // attribute where every engine renders a paragraph.
      //
      // Emitting a zero-width token is the handoff `try_close_code_block`
      // uses for its ticks: `return true` with the end still at the scan
      // start, so the run is offered again and the line falls through to a
      // paragraph. `BLOCK_CLOSE` cannot be borrowed here because there is no
      // block to close, hence a token of its own that produces no node.
      if (valid_symbols[NOT_A_CONTAINER_OPENER]) {
        // The line starts a paragraph that is now expecting a closer, so a
        // later bare fence inside it is text rather than a new div - the
        // half of §12 that the peek alone cannot see, because the malformed
        // line is BEHIND the position it looks from.
        s->state |= STATE_FENCE_ABSORBS;
        lexer->result_symbol = NOT_A_CONTAINER_OPENER;
        return true;
      }
      return false;
    }
    // Committed. The token ends here rather than at the colons, so the
    // separator whitespace is inside DIV_BEGIN for the spaced forms.
    //
    // That is a deliberate trade, and the alternative was measured: marking at
    // the colons keeps `div_marker_begin` exactly three characters, but then
    // the zero-width handoff below is three characters wide too, and the
    // paragraph for `::: {.c}` starts at column 3 - the tree stops covering
    // the `:::` the engine renders as text. A marker node one space wider on
    // VALID openers is the smaller loss than three characters of source
    // uncovered on invalid ones.
    lexer->mark_end(lexer);
    push_block(s, DIV, colons);
    lexer->result_symbol = DIV_BEGIN;
    return true;
  }

  // Don't let inline escape block boundary.
  if (s->open_inline->size > 0) {
    return false;
  }

  if (valid_symbols[DIV_END]) {
    remove_block(s);
    lexer->mark_end(lexer);
    lexer->result_symbol = DIV_END;
    return true;
  }
  if (valid_symbols[BLOCK_CLOSE]) {
    s->blocks_to_close = from_top - 1;
    lexer->result_symbol = BLOCK_CLOSE;
    return true;
  }
  return false;
}

static bool parse_heading(Scanner *s, TSLexer *lexer,
                          const bool *valid_symbols) {
  // Note that headings don't contain other blocks, only inline.
  Block *top = peek_block(s);

  // Avoids consuming `#` inside code/verbatim contexts.
  if ((top && top->type == CODE_BLOCK)) {
    return false;
  }

  bool top_heading = top && top->type == HEADING;

  uint8_t hash_count = consume_chars(s, lexer, '#');

  // COLUMN ZERO (NORMATIVE). A `#` is only a heading MARKER when it sits at the
  // content column of its line with NO extra leading whitespace; carve does not
  // accept CommonMark's 0-3 space leading indent. See corpus
  // 101-heading-marker-column-zero.
  if (hash_count > 0 && has_extra_indent(s)) {
    // An indented `#` line is NOT a marker: outside a heading it is a
    // paragraph, and an open heading ended at its own newline, so it closes
    // here and the line starts its own block. We leave the `#`s unconsumed (no
    // mark_end) so that block keeps them as text.
    if (top_heading && valid_symbols[BLOCK_CLOSE]) {
      lexer->result_symbol = BLOCK_CLOSE;
      remove_block(s);
      return true;
    }
    return false;
  }

  // We found a `# ` that can start or continue a heading.
  if (hash_count > 0 && lexer->lookahead == ' ') {
    if (!valid_symbols[HEADING_BEGIN] && !valid_symbols[BLOCK_CLOSE]) {
      return false;
    }

    advance(s, lexer); // Consume the ' '.

    if (valid_symbols[BLOCK_CLOSE] && top_heading &&
        s->open_inline->size == 0) {
      // An open heading ended at its own newline, whatever this marker's count
      // is -- a same-count marker used to CONTINUE it (djot) and now simply
      // opens the next heading. Close the previous one before opening it.
      lexer->result_symbol = BLOCK_CLOSE;
      remove_block(s);
      return true;
    }

    // Open a new heading.
    if (valid_symbols[HEADING_BEGIN]) {
      // Sections are created on the root level (or nested inside other
      // sections). A heading with the same or FEWER `#` closes the open
      // section(s) first; this returns a ZERO-WIDTH close, so the marker is
      // re-scanned afterwards -- which is why nothing may mark the token end
      // above this point.
      if (top && top->type == SECTION && top->data >= hash_count) {
        // NOTE closing multiple nested sections requires us to re-scan the
        // heading when we return without saving our work.
        lexer->result_symbol = BLOCK_CLOSE;
        remove_block(s);
        return true;
      }

      // A CONTENT-LESS marker line is paragraph text, not a heading, the same
      // rule the list markers follow: a `#` with nothing after it but spaces
      // renders as `<p>#</p>` in every engine (corpus
      // 82-single-line-headings). The end is pinned at the `# ` first so the
      // probe's scratch advances over the trailing whitespace cannot extend
      // the token, and the probe runs before either push so a refusal leaves
      // no block behind.
      lexer->mark_end(lexer);
      if (!marker_line_has_content(s, lexer)) {
        return false;
      }

      // A heading with MORE `#` than the open section nests a new one.
      if (!top || (top->type == SECTION && top->data < hash_count)) {
        push_block(s, SECTION, hash_count);
      }

      push_block(s, HEADING, hash_count);
      lexer->result_symbol = HEADING_BEGIN;
      return true;
    }
  } else if (hash_count == 0 && top_heading) {
    // No `#`, and a heading is open. It ended at its own newline, so it closes
    // here no matter what this line is -- blank, a container closer, or the
    // plain text that used to fold in.
    if (valid_symbols[BLOCK_CLOSE]) {
      remove_block(s);
      lexer->result_symbol = BLOCK_CLOSE;
      return true;
    }
  }

  return false;
}

static bool parse_footnote_end(Scanner *s, TSLexer *lexer) {
  Block *top = peek_block(s);
  if (!top || top->type != FOOTNOTE) {
    return false;
  }

  if (s->indent >= top->data) {
    return false;
  }

  // Don't let inline escape boundary.
  if (s->open_inline->size > 0) {
    return false;
  }

  remove_block(s);
  lexer->result_symbol = FOOTNOTE_END;
  return true;
}

static bool parse_footnote_continuation(Scanner *s, TSLexer *lexer) {
  Block *footnote = peek_block(s);
  if (!footnote || footnote->type != FOOTNOTE) {
    return false;
  }

  if (s->indent < footnote->data) {
    return false;
  }

  lexer->mark_end(lexer);
  lexer->result_symbol = FOOTNOTE_CONTINUATION;
  return true;
}

// Scan from a `|` to the next `|`, respecting verbatim and escapes.
// May not contain any newline.
// `empty` is set when the cell closes with NO characters at all between the
// pipes (not even whitespace: a whitespace-only gap like `| |` IS a cell per
// the reference engines). A row whose pipe gaps are ALL zero-width is not a
// table row (spec corpus 111-a-pipe-pair-with-no-cell-is-not-a-table: `||`
// alone stays a paragraph).
// `unterminated` reports the one failure the caller has to tell apart: the cell
// ran into the NEWLINE after consuming content, meaning the row never closed on
// a pipe. Hitting the newline with nothing but whitespace consumed is the normal
// way a properly closed row ends, and leaves it false.
static bool scan_table_cell(Scanner *s, TSLexer *lexer, bool *separator,
                            bool *empty, bool *unterminated) {
  uint8_t leading_ws = consume_whitespace(s, lexer);

  *separator = true;
  *empty = false;
  *unterminated = false;

  bool first_char = true;
  while (!lexer->eof(lexer)) {
    switch (lexer->lookahead) {
    case '\\':
      *separator = false;
      advance(s, lexer);
      advance(s, lexer);
      break;
    case '\n':
      *unterminated = !first_char;
      return false;
    case '`':
      *separator = false;
      // We must have ending ticks for this to be a valid table cell.
      if (!scan_verbatim_to_end_no_newline(s, lexer)) {
        return false;
      }
      break;

    case '|':
      *empty = first_char && leading_ws == 0;
      // A whitespace-only gap is an empty DATA cell, not a separator cell
      // (`| A |` + `| |` is header-less body rows in the reference engines,
      // never a header + separator promotion).
      if (first_char && leading_ws > 0) {
        *separator = false;
      }
      return true;
    case ':':
      advance(s, lexer);

      consume_whitespace(s, lexer);
      // A `:` can begin or end a separator cell.
      if (lexer->lookahead == '|') {
        return true;
      } else if (!first_char) {
        *separator = false;
      }
      break;
    case '-':
      advance(s, lexer);
      break;
    default:
      *separator = false;
      advance(s, lexer);
      break;
    }

    first_char = false;
  }
  return false;
}

static bool scan_separator_row(Scanner *s, TSLexer *lexer) {
  uint8_t cell_count = 0;
  bool any_content = false;
  bool curr_separator;
  bool curr_empty;
  bool unterminated = false;
  bool attr_after_pipe = false;
  while (true) {
    attr_after_pipe = lexer->lookahead == '{';
    if (!scan_table_cell(s, lexer, &curr_separator, &curr_empty, &unterminated)) {
      break;
    }
    if (!curr_separator) {
      return false;
    }
    if (!curr_empty) {
      any_content = true;
    }
    ++cell_count;
    if (lexer->lookahead == '|') {
      advance(s, lexer);
    }
  }
  if (attr_after_pipe) {
    unterminated = false;
  }

  if (cell_count == 0 || !any_content || unterminated) {
    return false;
  }

  // Nothing but whitespace and then a newline may follow a table row.
  consume_whitespace(s, lexer);
  return lexer->lookahead == '\n';
}

static bool scan_table_row(Scanner *s, TSLexer *lexer, TokenType *row_type) {
  if (s->state & STATE_TABLE_SEPARATOR_NEXT) {
    s->state &= ~STATE_TABLE_SEPARATOR_NEXT;
    *row_type = TABLE_SEPARATOR_BEGIN;
    return true;
  }

  uint8_t cell_count = 0;
  bool all_separators = true;
  bool any_content = false;
  bool unterminated = false;
  bool curr_separator;
  bool curr_empty;
  // A row attribute block glued to the closing pipe (`| a |{.head}`) sits where
  // a next cell would start. It is not an unterminated final cell; the row-end
  // token validates and consumes it (parse_table_end_newline).
  bool attr_after_pipe = false;
  while (true) {
    attr_after_pipe = lexer->lookahead == '{';
    if (!scan_table_cell(s, lexer, &curr_separator, &curr_empty, &unterminated)) {
      break;
    }
    if (!curr_separator) {
      all_separators = false;
    }
    if (!curr_empty) {
      any_content = true;
    }
    ++cell_count;
    if (lexer->lookahead == '|') {
      advance(s, lexer);
    }
  }
  if (attr_after_pipe) {
    unterminated = false;
  }

  // A row whose pipe gaps are all zero-width (`||`) has no cells and is not
  // a table row (corpus 111: `||` alone stays paragraph text). Whitespace-only
  // gaps (`| |`) are real, empty cells and keep the row valid.
  if (cell_count == 0 || !any_content) {
    return false;
  }

  // A row without its CLOSING pipe is prose, not a row: `| a | b` is a
  // paragraph, and a second row missing the pipe ends the table it followed
  // (corpus 140-table-row-closing-pipe).
  if (unterminated) {
    return false;
  }

  // Nothing but whitespace and then a newline may follow a table row.
  consume_whitespace(s, lexer);
  if (lexer->lookahead != '\n') {
    return false;
  }

  // Consume newline.
  advance(s, lexer);
  if (all_separators) {
    *row_type = TABLE_SEPARATOR_BEGIN;
  } else {
    // We need to check the next row and if that is full of separators then
    // this is a header, otherwise it's a regular row.
    // We also need to check for any block quote markers on that row.
    bool newline = false;
    scan_block_quote_markers(s, lexer, &newline);

    if (!newline && scan_separator_row(s, lexer)) {
      s->state |= STATE_TABLE_SEPARATOR_NEXT;
      *row_type = TABLE_HEADER_BEGIN;
    } else {
      *row_type = TABLE_ROW_BEGIN;
    }
  }
  return true;
}

// Defined below; validates a `{...}` attribute payload. Forward-declared so a
// glued row attribute can reuse the same validation.
static bool scan_valid_inline_attribute(Scanner *s, TSLexer *lexer);

static bool parse_table_begin(Scanner *s, TSLexer *lexer,
                              const bool *valid_symbols) {
  if (lexer->lookahead != '|') {
    return false;
  }
  if (!valid_symbols[TABLE_ROW_BEGIN] &&
      !valid_symbols[TABLE_SEPARATOR_BEGIN] &&
      !valid_symbols[TABLE_HEADER_BEGIN]) {
    return false;
  }

  // The tokens should consume the pipe.
  advance(s, lexer);
  lexer->mark_end(lexer);

  TokenType row_type;
  if (!scan_table_row(s, lexer, &row_type)) {
    return false;
  }

  push_block(s, TABLE_ROW, 0);
  lexer->result_symbol = row_type;
  return true;
}

static bool parse_table_end_newline(Scanner *s, TSLexer *lexer) {
  Block *top = peek_block(s);
  if (!top || top->type != TABLE_ROW) {
    return false;
  }

  // A row attribute block may be glued to the row's closing pipe:
  // `| a | b |{.head}`. Validate the attribute with the same payload grammar
  // as inline/block attributes, then fold it into the row-end token (its
  // payload is part of the token span). An invalid attribute (`|{not!}`) is
  // refused so it is not silently swallowed.
  if (lexer->lookahead == '{') {
    if (!scan_valid_inline_attribute(s, lexer)) {
      return false;
    }
    // Only trailing whitespace may follow the attribute block.
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(s, lexer);
    }
  }

  if (lexer->lookahead != '\n') {
    return false;
  }

  remove_block(s);
  advance(s, lexer);
  lexer->result_symbol = TABLE_ROW_END_NEWLINE;
  lexer->mark_end(lexer);
  return true;
}

static bool parse_table_cell_end(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '|') {
    return false;
  }
  // Can only close a cell (or row) if all inline spans have been closed.
  if (s->open_inline->size > 0) {
    return false;
  }

  Block *top = peek_block(s);
  if (!top || top->type != TABLE_ROW) {
    return false;
  }

  --top->data;
  advance(s, lexer); // Consumes the `|`
  lexer->result_symbol = TABLE_CELL_END;
  lexer->mark_end(lexer);
  return true;
}

static bool parse_table_caption_begin(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '^') {
    return false;
  }

  advance(s, lexer);
  if (lexer->lookahead != ' ') {
    return false;
  }
  advance(s, lexer);
  push_block(s, TABLE_CAPTION, s->indent + 2);
  lexer->mark_end(lexer);
  lexer->result_symbol = TABLE_CAPTION_BEGIN;
  return true;
}

static bool parse_table_caption_end(Scanner *s, TSLexer *lexer) {
  Block *caption = peek_block(s);
  if (!caption || caption->type != TABLE_CAPTION) {
    return false;
  }
  // Don't let inline escape caption.
  if (s->open_inline->size > 0) {
    return false;
  }

  // End is only checked at the beginning of a line, and should stop if we're
  // not indented enough.
  if (s->indent >= caption->data) {
    return false;
  }

  remove_block(s);
  lexer->result_symbol = TABLE_CAPTION_END;
  return true;
}

// Scan until the end of a comment, either consuming the next `%`
// or before the ending `}`.
static bool scan_comment(Scanner *s, TSLexer *lexer, uint8_t indent,
                         bool *must_be_inline_comment) {
  if (lexer->lookahead != '%') {
    return false;
  }
  advance(s, lexer);

  while (!lexer->eof(lexer)) {
    switch (lexer->lookahead) {
    case '%':
      advance(s, lexer);
      return true;
    case '}':
      return true;
    case '\\':
      advance(s, lexer);
      break;
    case '\n':
      advance(s, lexer);
      // Need to match indent for comments inside attributes
      // but not for inline comments.
      if (indent != consume_whitespace(s, lexer)) {
        *must_be_inline_comment = true;
      }
      // Can only have one newline in a row for a valid attribute.
      if (lexer->lookahead == '\n') {
        return false;
      }
      break;
    }
    advance(s, lexer);
  }
  return false;
}

static bool scan_value(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead == '"' || lexer->lookahead == '\'') {
    char quote = (char)lexer->lookahead;
    // Opening quote.
    advance(s, lexer);
    if (!scan_until_unescaped(s, lexer, quote)) {
      return false;
    }
    // Closing quote.
    advance(s, lexer);
    return true;
  } else {
    return scan_identifier(s, lexer);
  }
}

static bool parse_open_curly_bracket(Scanner *s, TSLexer *lexer,
                                     const bool *valid_symbols) {

  if (!valid_symbols[BLOCK_ATTRIBUTE_BEGIN] &&
      !valid_symbols[INLINE_COMMENT_BEGIN]) {
    return false;
  }
  if (lexer->lookahead != '{') {
    return false;
  }
  // Only consume the `{`, if successful.
  advance(s, lexer);
  lexer->mark_end(lexer);

  // Match indent to one past the `{`
  uint8_t indent = s->indent + 1;

  // An inline comment must follow the `{% ... %}` format.
  bool can_be_inline_comment = lexer->lookahead == '%';
  bool must_be_inline_comment = false;

  while (!lexer->eof(lexer)) {
    uint8_t space = consume_whitespace(s, lexer);
    if (space > 0) {
      can_be_inline_comment = false;
    }

    switch (lexer->lookahead) {
    case '\\':
      can_be_inline_comment = false;
      advance(s, lexer);
      advance(s, lexer);
      break;
    case '}':
      if (can_be_inline_comment && valid_symbols[INLINE_COMMENT_BEGIN]) {
        lexer->result_symbol = INLINE_COMMENT_BEGIN;
        return true;
      } else if (!must_be_inline_comment &&
                 valid_symbols[BLOCK_ATTRIBUTE_BEGIN] &&
                 // COLUMN ZERO. An indented `{.x}` line is literal text, not
                 // an attribute for the block below it (corpus
                 // 155-indented-attribute-line-stays-literal). Inline
                 // attributes and `{% comments %}` are unaffected: they are
                 // separate symbols, and only this branch is guarded.
                 //
                 // BOTH directions: short of the column is not an attribute and
                 // neither is past it. Only the first half was checked, so
                 // `{.c}` one space past a list item's content column opened a
                 // real attribute where the corpus says literal text (#84).
                 !has_extra_indent(s) && !has_surplus_indent(s)) {
        // A block attribute must stand alone on its line: after the closing
        // `}` only trailing whitespace and a newline (or EOF) may follow.
        // Otherwise (e.g. `{.c} text`, `para {.c} more`) the braces are
        // ordinary inline text, so refuse the block-attribute token and let
        // the line parse as a paragraph.
        advance(s, lexer);
        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
          advance(s, lexer);
        }
        if (lexer->lookahead == '\n' || lexer->eof(lexer)) {
          lexer->result_symbol = BLOCK_ATTRIBUTE_BEGIN;
          return true;
        }
        return false;
      } else {
        return false;
      }
    case '.':
      can_be_inline_comment = false;
      advance(s, lexer);
      // Class names may not start with a digit (`.123` is not a class).
      if (!scan_name_no_digit_start(s, lexer)) {
        return false;
      }
      break;
    case '#':
      can_be_inline_comment = false;
      advance(s, lexer);
      if (!scan_identifier(s, lexer)) {
        return false;
      }
      break;
    case '%':
      if (!scan_comment(s, lexer, indent, &must_be_inline_comment)) {
        return false;
      }
      break;
    case '\n':
      can_be_inline_comment = false;
      advance(s, lexer);
      // Need to match indent!
      if (indent != consume_whitespace(s, lexer)) {
        return false;
      }
      // Can only have one newline in a row for a valid attribute.
      if (lexer->lookahead == '\n') {
        return false;
      }
      break;
    default: {
      can_be_inline_comment = false;
      // An attribute key may not start with a digit (`12=v` is not a key), and
      // a digit/`_`/`-`-leading token is not a bare boolean key either. This
      // also keeps a curly-emphasis form like `{_text_}` from being mistaken
      // for a bare key.
      if (!scan_name_no_digit_start(s, lexer)) {
        return false;
      }
      // carve-php Boolean Attribute Shorthand: a bare `key` (no `=value`)
      // is accepted as long as it is followed by a valid attribute boundary
      // — `}`, whitespace, or newline.
      if (lexer->lookahead != '=') {
        if (lexer->lookahead == '}' || lexer->lookahead == ' ' ||
            lexer->lookahead == '\t' || lexer->lookahead == '\n') {
          break;
        }
        return false;
      }
      advance(s, lexer);
      // Then scan the value
      if (!scan_value(s, lexer)) {
        return false;
      }
    }
    }
  }
  return false;
}

static bool parse_hard_line_break(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '\\') {
    return false;
  }
  advance(s, lexer);
  lexer->mark_end(lexer);
  if (lexer->lookahead != '\n') {
    return false;
  }
  lexer->result_symbol = HARD_LINE_BREAK;
  return true;
}

static bool end_paragraph_in_block_quote(Scanner *s, TSLexer *lexer) {
  Block *block = find_block(s, BLOCK_QUOTE);
  if (!block) {
    return false;
  }

  // Scan all `> ` markers we can find.
  bool ending_newline;
  uint8_t marker_count = scan_block_quote_markers(s, lexer, &ending_newline);

  // No blockquote marker.
  if (marker_count == 0) {
    return false;
  }

  // We've gone down a blockquote level, we need to close the paragraph.
  if (marker_count < block->data || ending_newline) {
    return true;
  }

  // And UP a level: a deeper quote is a new block, so it interrupts the
  // paragraph rather than continuing it - `> a` / `> > b` is a quote holding a
  // paragraph and a nested quote in every engine (#70). Checked here rather
  // than beside the depth-0 case below, because this function has already
  // consumed the markers the check needs.
  //
  if (marker_count > count_blocks(s, BLOCK_QUOTE)) {
    return true;
  }

  if (block != peek_block(s) &&
      scan_paragraph_closing_marker(s, lexer)) {
    return true;
  }

  // Check if there's a blankline following the blockquote marker.
  consume_whitespace(s, lexer);
  return lexer->lookahead == '\n';
}

static bool scan_block_math_marker(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '$') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != '$') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != '`') {
    return false;
  }
  advance(s, lexer);
  return true;
}

// carve-php standalone caption: a line starting with `^ ` (caret + SPACE) at
// block position must terminate any paragraph that was continuing,
// so the caption rule can fire as a sibling block. The advance() calls here
// are scratch — they don't commit (only mark_end commits), so the caption
// rule itself will still see `^` at the new block-line start.
static bool scan_caption_at_paragraph_end(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '^') {
    return false;
  }
  advance(s, lexer);
  // A TAB does not separate the marker from its content - `^\tcap` is a
  // paragraph in every engine (corpus 176-a-marker-separator-is-a-space-
  // never-a-tab). Accepting one here ended the paragraph above for a line
  // that is not a caption at all.
  if (lexer->lookahead != ' ') {
    return false;
  }
  return true;
}

// carve-php fenced comment opener `%%%` at line start. Matching here lets a
// `%%%` line terminate the previous paragraph so the fenced_comment_block
// token can match it as a sibling block.
static bool scan_fenced_comment_at_paragraph_end(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '%') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != '%') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != '%') {
    return false;
  }
  return true;
}

// A lone `+` continuation marker (PART 9 §17) on the next line must terminate
// the in-progress paragraph so the marker can fire as a sibling continuation
// inside the enclosing list item or block quote (corpus 83 / 100). Only
// meaningful when a list or block quote is open -- a bare top-level `+` stays a
// paragraph. The advance() calls are scratch (only mark_end commits), so the
// `+` is still seen at the new block-line start by `parse_continuation_marker`.
static bool scan_continuation_marker_at_paragraph_end(Scanner *s,
                                                      TSLexer *lexer) {
  if (lexer->lookahead != '+') {
    return false;
  }
  if (find_list(s) == NULL && find_block(s, BLOCK_QUOTE) == NULL) {
    return false;
  }
  advance(s, lexer);
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    advance(s, lexer);
  }
  return lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r';
}

/// A block quote that goes DEEPER than the one we are in interrupts an open
/// paragraph (PART 9 §10: a visible block opener interrupts; only a list does
/// not).
///
/// `end_paragraph_in_block_quote` above handles the other direction - a line
/// that drops to a SHALLOWER depth - and does nothing when no quote is open at
/// all, so a `>` line after a paragraph opened nothing: `x` / `> q` came out as
/// one paragraph, and so did `- a` / `  > q` at a list item's content column,
/// where carve-js and carve-php both open a quote (tree-sitter-carve#70).
///
/// Depth, not presence: `> a` / `> b` is one paragraph in every engine (the
/// second line continues the first at the SAME depth), and `> a` / `b` is a
/// lazy continuation. Only `> a` / `> > b` opens something new.
static bool scan_deeper_block_quote_at_paragraph_end(Scanner *s,
                                                     TSLexer *lexer) {
  if (lexer->lookahead != '>') {
    return false;
  }
  uint8_t open_depth = count_blocks(s, BLOCK_QUOTE);
  bool ending_newline = false;
  uint8_t marker_count = scan_block_quote_markers(s, lexer, &ending_newline);
  return marker_count > open_depth;
}

static bool close_paragraph(Scanner *s, TSLexer *lexer) {
  // Workaround for not including the following blankline when closing a
  // paragraph inside a block.
  Block *top = peek_block(s);
  if (top && top->type == BLOCK_QUOTE && lexer->lookahead == '\n') {
    return true;
  }

  if (end_paragraph_in_block_quote(s, lexer)) {
    return true;
  }

  if (scan_deeper_block_quote_at_paragraph_end(s, lexer)) {
    return true;
  }

  if (scan_paragraph_closing_marker(s, lexer)) {
    return true;
  }

  if (scan_block_math_marker(s, lexer)) {
    return true;
  }

  // carve-php-fork additions: `^ ` (caption) and `%%%` (fenced comment) at the
  // next line's start must close any in-progress paragraph.
  if (scan_caption_at_paragraph_end(s, lexer)) {
    return true;
  }
  if (scan_fenced_comment_at_paragraph_end(s, lexer)) {
    return true;
  }
  if (scan_continuation_marker_at_paragraph_end(s, lexer)) {
    return true;
  }

  return false;
}

static bool parse_close_paragraph(Scanner *s, TSLexer *lexer) {
  // No open inline at paragraph boundary.
  if (s->open_inline->size > 0) {
    return false;
  }
  if (!close_paragraph(s, lexer)) {
    return false;
  }

  // The paragraph is over, so whatever malformed fence it absorbed no longer
  // governs the next one: `::: {.x}` / `x` / blank / `:::` ends with a real
  // div in every engine.
  s->state &= ~STATE_FENCE_ABSORBS;
  lexer->result_symbol = CLOSE_PARAGRAPH;
  return true;
}

// Decide if we should emit a `NEWLINE_INLINE` token.
//
// This should only be allowed inside a paragraph (or inline context),
// not at the end of a paragraph. Therefore there's logic
// here to detect the end of a paragraph.
//
// We should have already advanced over `\n` before calling this function.
static bool emit_newline_inline(Scanner *s, TSLexer *lexer,
                                uint32_t newline_column) {
  // Need a proper `NEWLINE` to end a paragraph.
  if (lexer->eof(lexer)) {
    return false;
  }

  // Is never valid as the first character of a line.
  if (newline_column == 0) {
    return false;
  }

  Block *top = peek_block(s);
  if (disallow_newline(top)) {
    return false;
  }

  // Disallow `NEWLINE_INLINE` inside headings as it uses lines of inline
  // with heading continuations instead.
  if (top && top->type == HEADING) {
    return false;
  }

  // This is a lookahead for the next line, to check if
  // there's a blankline ending the paragraph or not (in which case we
  // shouldn't emit a `NEWLINE_INLINE`).
  uint8_t next_line_whitespace = consume_whitespace(s, lexer);
  if (lexer->lookahead == '\n') {
    return false;
  }

  // Need an extra check so we don't emit a NEWLINE_INLINE at the end
  // of a table caption if there's a mismatched indent.
  if (top && top->type == TABLE_CAPTION && next_line_whitespace < top->data) {
    return false;
  }

  // Paragraph should end, don't continue.
  if (close_paragraph(s, lexer)) {
    return false;
  }

  lexer->result_symbol = NEWLINE_INLINE;
  return true;
}

static bool parse_newline(Scanner *s, TSLexer *lexer,
                          const bool *valid_symbols) {
  if (valid_symbols[TABLE_ROW_END_NEWLINE] &&
      parse_table_end_newline(s, lexer)) {
    return true;
  }
  if (valid_symbols[VERBATIM_END] && try_implicit_close_verbatim(s, lexer)) {
    return true;
  }

  // Various different newline types share the `\n` consumption.
  if (!valid_symbols[NEWLINE] && !valid_symbols[NEWLINE_INLINE] &&
      !valid_symbols[EOF_OR_NEWLINE]) {
    return false;
  }

  Block *top = peek_block(s);
  if (disallow_newline(top)) {
    return false;
  }

  uint32_t newline_column = lexer->get_column(lexer);

  if (lexer->lookahead == '\n') {
    advance(s, lexer);
  }
  lexer->mark_end(lexer);

  // Prefer NEWLINE_INLINE for newlines in inline context.
  // When they're no longer accepted, this marks the end of a paragraph
  // and a regular NEWLINE (or EOF_OR_NEWLINE) can be emitted.
  if (valid_symbols[NEWLINE_INLINE] &&
      emit_newline_inline(s, lexer, newline_column)) {
    lexer->result_symbol = NEWLINE_INLINE;
    return true;
  }

  // Only allow `NEWLINE_INLINE` style of newlines with open inline elements.
  if (s->open_inline->size > 0) {
    return false;
  }

  // We need to handle NEWLINE in the external scanner for our
  // changes to the Scanner state to be saved
  // (the reset of `block_quote_level` at newline in the main scan function).
  // A plain NEWLINE (rather than NEWLINE_INLINE) is the end of the paragraph,
  // which is where the §12 absorption stops - see `parse_close_paragraph`.
  if (valid_symbols[NEWLINE]) {
    s->state &= ~STATE_FENCE_ABSORBS;
    lexer->result_symbol = NEWLINE;
    return true;
  }

  if (valid_symbols[EOF_OR_NEWLINE]) {
    s->state &= ~STATE_FENCE_ABSORBS;
    lexer->result_symbol = EOF_OR_NEWLINE;
    return true;
  }

  // Something should already have matched, but lets not rely on that shall
  // we?
  return false;
}

static bool parse_comment_end(Scanner *s, TSLexer *lexer,
                              const bool *valid_symbols) {
  if (valid_symbols[COMMENT_END_MARKER] && lexer->lookahead == '%') {
    advance(s, lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = COMMENT_END_MARKER;
    return true;
  }
  if (valid_symbols[COMMENT_CLOSE] && lexer->lookahead == '}') {
    lexer->result_symbol = COMMENT_CLOSE;
    return true;
  }
  return false;
}

static SpanType inline_span_type(InlineType type) {
  switch (type) {
  case EMPHASIS:
  case STRONG:
  case UNDERLINE:
  case STRIKETHROUGH:
  case HIGHLIGHTED:
    return SpanBracketedAndSingleNoWhitespace;
  case SUPERSCRIPT:
  case SUBSCRIPT:
    // Braced-only since spec PR 259: bare `^`/`,` are literal text.
  case INSERT:
  case DELETE:
    return SpanBracketed;
  case BOLD_ITALIC:
    return SpanPair;
  case PARENS_SPAN:
  case CURLY_BRACKET_SPAN:
  case SQUARE_BRACKET_SPAN:
    return SpanSingle;
  default:
    return SpanSingle;
  }
}

static char inline_begin_token(InlineType type) {
  switch (type) {
  case VERBATIM:
    return VERBATIM_BEGIN;
  case EMPHASIS:
    return EMPHASIS_MARK_BEGIN;
  case STRONG:
    return STRONG_MARK_BEGIN;
  case UNDERLINE:
    return UNDERLINE_MARK_BEGIN;
  case STRIKETHROUGH:
    return STRIKETHROUGH_MARK_BEGIN;
  case SUPERSCRIPT:
    return SUPERSCRIPT_MARK_BEGIN;
  case SUBSCRIPT:
    return SUBSCRIPT_MARK_BEGIN;
  case HIGHLIGHTED:
    return HIGHLIGHTED_MARK_BEGIN;
  case INSERT:
    return INSERT_MARK_BEGIN;
  case DELETE:
    return DELETE_MARK_BEGIN;
  case BOLD_ITALIC:
    return BOLD_ITALIC_MARK_BEGIN;
  case PARENS_SPAN:
    return PARENS_SPAN_MARK_BEGIN;
  case CURLY_BRACKET_SPAN:
    return CURLY_BRACKET_SPAN_MARK_BEGIN;
  case SQUARE_BRACKET_SPAN:
    return SQUARE_BRACKET_SPAN_MARK_BEGIN;
  default:
    return ERROR;
  }
}

static char inline_end_token(InlineType type) {
  switch (type) {
  case VERBATIM:
    return VERBATIM_END;
  case EMPHASIS:
    return EMPHASIS_END;
  case STRONG:
    return STRONG_END;
  case UNDERLINE:
    return UNDERLINE_END;
  case STRIKETHROUGH:
    return STRIKETHROUGH_END;
  case SUPERSCRIPT:
    return SUPERSCRIPT_END;
  case SUBSCRIPT:
    return SUBSCRIPT_END;
  case HIGHLIGHTED:
    return HIGHLIGHTED_END;
  case INSERT:
    return INSERT_END;
  case DELETE:
    return DELETE_END;
  case BOLD_ITALIC:
    return BOLD_ITALIC_END;
  case PARENS_SPAN:
    return PARENS_SPAN_END;
  case CURLY_BRACKET_SPAN:
    return CURLY_BRACKET_SPAN_END;
  case SQUARE_BRACKET_SPAN:
    return SQUARE_BRACKET_SPAN_END;
  default:
    return ERROR;
  }
}

static char inline_marker(InlineType type) {
  switch (type) {
  case EMPHASIS:
    return '/';
  case STRONG:
    return '*';
  case UNDERLINE:
    return '_';
  case STRIKETHROUGH:
    return '~';
  case SUPERSCRIPT:
    return '^';
  case SUBSCRIPT:
    return ',';
  case HIGHLIGHTED:
    return '=';
  case INSERT:
    return '+';
  case DELETE:
    return '-';
  case BOLD_ITALIC:
    // The FIRST character of the closer; scan_bold_italic_span_end reads the
    // `/` that follows it.
    return '*';
  case PARENS_SPAN:
    return ')';
  case CURLY_BRACKET_SPAN:
    return '}';
  case SQUARE_BRACKET_SPAN:
    return ']';
  default:
    // Not used as verbatim is parsed separately.
    return '`';
  }
}

static Inline *find_inline(Scanner *s, InlineType type) {
  for (int i = s->open_inline->size - 1; i >= 0; --i) {
    Inline *e = *array_get(s->open_inline, i);
    if (e->type == type) {
      return e;
    }
  }
  return NULL;
}

static bool scan_single_span_end(Scanner *s, TSLexer *lexer, char marker) {
  if (lexer->lookahead != marker) {
    return false;
  }
  advance(s, lexer);
  return true;
}

// Match the `*/` that closes a bold-italic span. Two characters, and not a
// mirror of the `/*` that opened it, which is why this span has a kind of its
// own rather than reusing the single/bracketed helpers.
static bool scan_bold_italic_span_end(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '*') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != '/') {
    return false;
  }
  advance(s, lexer);
  return true;
}

// Match a `_}` style token.
static bool scan_bracketed_span_end(Scanner *s, TSLexer *lexer, char marker) {
  if (lexer->lookahead != marker) {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != '}') {
    return false;
  }
  advance(s, lexer);
  return true;
}

// Scan an ending token for a span (`_` or `_}`) if marker == '_'.
//
// This routine is responsible for parsing the trailing whitespace in a span,
// so the token may become a `  _}`.
//
// If `whitespace_sensitive == true` then we should not allow a space
// before the single marker (` _` isn't a valid ending token)
// and only allow spaces with the bracketed variant.
static bool scan_span_end(Scanner *s, TSLexer *lexer, char marker,
                          bool whitespace_sensitive) {
  // Match `_` or `_}`
  if (lexer->lookahead == marker) {
    advance(s, lexer);
    if (lexer->lookahead == '}') {
      advance(s, lexer);
    }
    return true;
  }

  if (whitespace_sensitive && consume_whitespace(s, lexer) == 0) {
    return false;
  }

  // Only match `_}`.
  return scan_bracketed_span_end(s, lexer, marker);
}

static bool scan_span_end_marker(Scanner *s, TSLexer *lexer,
                                 InlineType element) {
  char marker = inline_marker(element);

  switch (inline_span_type(element)) {
  case SpanSingle:
    return scan_single_span_end(s, lexer, marker);
  case SpanBracketed:
    return scan_bracketed_span_end(s, lexer, marker);
  case SpanBracketedAndSingle:
    return scan_span_end(s, lexer, marker, false);
  case SpanBracketedAndSingleNoWhitespace:
    return scan_span_end(s, lexer, marker, true);
  case SpanPair:
    return scan_bold_italic_span_end(s, lexer);
  default:
    return false;
  }
}

// Scan until `c`, aborting if an ending marker for the `top` element is
// found.
static bool scan_until(Scanner *s, TSLexer *lexer, char c, InlineType *top) {
  while (!lexer->eof(lexer)) {
    if (top && scan_span_end_marker(s, lexer, *top)) {
      return false;
    }
    if (lexer->lookahead == c) {
      return true;
    } else if (lexer->lookahead == '\\') {
      advance(s, lexer);
      advance(s, lexer);
    } else if (lexer->lookahead == '\n') {
      // One newline is ok in inline spans, but not several in a row.
      advance(s, lexer);
      consume_whitespace(s, lexer);
      if (lexer->lookahead == '\n') {
        return false;
      }
    } else {
      advance(s, lexer);
    }
  }
  return false;
}

// Validate a `{...}` inline attribute, mirroring the payload grammar used for
// block attributes in `parse_open_curly_bracket` (class `.x`, id `#x`,
// `key=value`, bare boolean `key`, `%comment%`, whitespace, a single newline).
// The lexer must be positioned at the opening `{`. Returns true and leaves the
// lexer just past the closing `}` when the attribute is well-formed; otherwise
// returns false. Used so an unparseable attribute (`[x]{???}`, `[x]{.a!b}`)
// does NOT mark a span, letting the brackets fall back to literal text instead
// of forcing an ERROR/MISSING into the tree.
static bool scan_valid_inline_attribute(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '{') {
    return false;
  }
  advance(s, lexer);
  bool seen_newline = false;
  while (!lexer->eof(lexer)) {
    consume_whitespace(s, lexer);
    switch (lexer->lookahead) {
    case '}':
      advance(s, lexer);
      return true;
    case '\\':
      advance(s, lexer);
      advance(s, lexer);
      break;
    case '.':
      advance(s, lexer);
      // A class name must not start with a digit (`.123` is not a class).
      if (!scan_name_no_digit_start(s, lexer)) {
        return false;
      }
      break;
    case '#':
      advance(s, lexer);
      if (!scan_identifier(s, lexer)) {
        return false;
      }
      break;
    case '%': {
      bool must_be_inline_comment = false;
      if (!scan_comment(s, lexer, s->indent + 1, &must_be_inline_comment)) {
        return false;
      }
      break;
    }
    case '\n':
      // A single embedded newline is allowed, but not a blank line.
      if (seen_newline) {
        return false;
      }
      seen_newline = true;
      advance(s, lexer);
      break;
    default: {
      // An attribute key must not start with a digit (`12=v` is not a key).
      if (!scan_name_no_digit_start(s, lexer)) {
        return false;
      }
      if (lexer->lookahead != '=') {
        // Bare boolean attribute: a key (already known non-digit-leading)
        // followed by a valid boundary (`}`, whitespace, newline).
        if (lexer->lookahead == '}' || lexer->lookahead == ' ' ||
            lexer->lookahead == '\t' || lexer->lookahead == '\n') {
          break;
        }
        return false;
      }
      advance(s, lexer);
      if (!scan_value(s, lexer)) {
        return false;
      }
    }
    }
  }
  return false;
}

// Updates lookahead states that are used to block the acceptance of
// the fallback characters `(` and `{` if there's a valid inline link
// or span to be chosen.
static void update_square_bracket_lookahead_states(Scanner *s, TSLexer *lexer,
                                                   Inline *top) {
  // Reset flags so we can set them later if the scanning succeeds.
  s->state &= ~STATE_BRACKET_STARTS_INLINE_LINK;
  s->state &= ~STATE_BRACKET_STARTS_SPAN;

  InlineType *top_type = NULL;
  if (top) {
    top_type = &top->type;
  }

  // Scan the `[some text]` span.
  if (!scan_until(s, lexer, ']', top_type)) {
    return;
  }
  advance(s, lexer);

  if (lexer->lookahead == '(') {
    // An inline link may follow.
    if (scan_until(s, lexer, ')', top_type)) {
      s->state |= STATE_BRACKET_STARTS_INLINE_LINK;
    }
  } else if (lexer->lookahead == '{') {
    // An inline attribute may follow, turning it into the Carve `span` type.
    //
    // We validate the attribute payload here (same shape as block
    // attributes). Only a well-formed attribute marks a span; an unparseable
    // one (`[x]{???}`, `[x]{.a!b}`) leaves the flag clear so the brackets fall
    // back to literal text instead of forcing an ERROR/MISSING into the tree.
    if (scan_valid_inline_attribute(s, lexer)) {
      s->state |= STATE_BRACKET_STARTS_SPAN;
    }
  }
}

static bool mark_span_begin(Scanner *s, TSLexer *lexer,
                            const bool *valid_symbols, InlineType inline_type,
                            TokenType token) {
  Inline *top = peek_inline(s);
  // If IN_FALLBACK is valid then it means we're processing the
  // `_symbol_fallback` branch (see `grammar.js`).
  if (valid_symbols[IN_FALLBACK]) {
    // There's a challenge when we have multiple elements inside an inline
    // link:
    //
    //     [x](a_b_c_d_e)
    //
    // Because of the dynamic precedence treesitter will not parse this as a
    // link but as some fallback characters and then some emphasis.
    //
    // To prevent this we don't allow the parsing of `(` when it's a fallback
    // symbol if we can scan ahead and see that we should be able to parse it
    // as a link, stopping the contained emphasis from being considered.
    //
    // This is done here at `[` as a fallback character so when we reach `(`
    // we can abort and prune that branch (since we should parse it as a
    // link).
    if (inline_type == SQUARE_BRACKET_SPAN) {
      update_square_bracket_lookahead_states(s, lexer, top);
    }

    // This is where we've reached the `(` in:
    //
    //     [x](a_b_c_d_e)
    //
    // and if `STATE_BRACKET_CAN_START_INLINE_LINK` is true then we should
    // prune the branch and instead treat it as a link.
    if (inline_type == PARENS_SPAN &&
        (s->state & STATE_BRACKET_STARTS_INLINE_LINK)) {
      return false;
    }

    // For spans `[text]{.class}` we use the same mechanism to solve
    // precedence in this example:
    //
    //     [_]{.c}_
    //
    // Where we'll block at `{` if we should instead treat it as a span.
    if (inline_type == CURLY_BRACKET_SPAN &&
        (s->state & STATE_BRACKET_STARTS_SPAN)) {
      return false;
    }

    // If there's multiple valid opening spans, for example:
    //
    //      {_ {_ a_
    //
    // Then we should choose the shorter one and the first `{_`
    // should be regarded as regular text.
    // To handle this case we count the number of opening tags
    // an open element has and when we try to close an element with
    // open tags then we issue an error (in `parse_span_end`).
    //
    // The reason we're not immediately issuing an error here
    // is that spans might be nested, for example:
    //
    //      _a _b_ a_
    //
    // If we issue an error here at `_b` then we won't find the nested
    // emphasis. The solution i found was to do the check when closing the
    // span instead.
    Inline *open = find_inline(s, inline_type);
    if (open != NULL) {
      ++open->data;
    }
    // We need to output the token common to both the fallback symbol and
    // the span so the resolver will detect the collision.
    lexer->result_symbol = token;
    return true;
  } else {
    // Reset blocking states when the correct branch was chosen.
    if (inline_type == PARENS_SPAN) {
      s->state &= ~STATE_BRACKET_STARTS_INLINE_LINK;
    } else if (inline_type == CURLY_BRACKET_SPAN) {
      s->state &= ~STATE_BRACKET_STARTS_SPAN;
    }

    lexer->result_symbol = token;
    push_inline(s, inline_type, 0);
    return true;
  }
}

// Parse a span ending token, either `_` or `_}`.
static bool parse_span_end(Scanner *s, TSLexer *lexer, InlineType element,
                           TokenType token) {
  // if (!scan_span_end_element(s, lexer, element)) {
  //   return false;
  // }
  // Only close the topmost element, so in:
  //
  //    _a *b_
  //
  // The `*` isn't allowed to open a span, and that branch should not be
  // valid.
  Inline *top = peek_inline(s);
  if (!top || top->type != element) {
    return false;
  }
  // If we've chosen any fallback symbols inside the span then we
  // should not accept the span.
  if (top->data > 0) {
    return false;
  }

  if (!scan_span_end_marker(s, lexer, element)) {
    return false;
  }

  lexer->mark_end(lexer);
  lexer->result_symbol = token;
  remove_inline(s);
  return true;
}

// Parse a span delimited with `marker`, with `_`, `{_`, and `_}` being valid
// delimiters.
static bool parse_span(Scanner *s, TSLexer *lexer, const bool *valid_symbols,
                       InlineType element) {
  TokenType begin_token = inline_begin_token(element);
  TokenType end_token = inline_end_token(element);
  if (valid_symbols[end_token] &&
      parse_span_end(s, lexer, element, end_token)) {
    return true;
  }
  if (valid_symbols[begin_token] &&
      mark_span_begin(s, lexer, valid_symbols, element, begin_token)) {
    return true;
  }
  return false;
}

static bool check_non_whitespace(Scanner *s, TSLexer *lexer) {
  switch (lexer->lookahead) {
  case ' ':
  case '\t':
  case '\r':
  case '\n':
    return false;
  default:
    lexer->result_symbol = NON_WHITESPACE_CHECK;
    return true;
  }
}

// A bare `=` opens a highlight only when the next char can start content.
// It must NOT open on whitespace, nor on `=> =~ =< ==`: in Carve those are
// smart-typography ligatures (`=>` is `⇒`) or table alignment / header markers
// (`|=>`, `|=~`, `|=<`, `|=`), not a highlight. Matches carve-js.
static bool check_highlighted_open(Scanner *s, TSLexer *lexer) {
  switch (lexer->lookahead) {
  case ' ':
  case '\t':
  case '\r':
  case '\n':
  case '>':
  case '~':
  case '<':
  case '=':
    return false;
  default:
    lexer->result_symbol = HIGHLIGHTED_OPEN_CHECK;
    return true;
  }
}

bool tree_sitter_carve_external_scanner_scan(void *payload, TSLexer *lexer,
                                            const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

#ifdef DEBUG
  printf("SCAN\n");
  dump(s, lexer);
  dump_some_valid_symbols(valid_symbols);
#endif

  // Mark end right from the start and then when outputting results
  // we mark it again to make it consume.
  // I found it easier to opt-in to consume tokens.
  lexer->mark_end(lexer);
  // Important to remember to skip all carriage returns.
  if (lexer->lookahead == '\r') {
    advance(s, lexer);
  }
  if (lexer->get_column(lexer) == 0) {
    s->indent = consume_whitespace(s, lexer);
    // A new line starts a new marker chain (see `marker_end_col`).
    s->marker_end_col = 0;
    // A new line also starts a fresh block-quote marker count. Normally a
    // trailing NEWLINE token clears `block_quote_level` (below) before the
    // next line is scanned, but a construct whose own token swallows its
    // trailing newline in one lexer match - `comment_line`, an empty
    // `fenced_comment_block` with no closer - never yields control back to
    // the scanner at that boundary, so the count from the quote's opening
    // marker line survives into the next line untouched. On a dedent with
    // no open paragraph to absorb it (tree-sitter-carve#77), that stale
    // count reads as "still at the quote's own depth" and blocks the
    // BLOCK_CLOSE branch in `parse_block_quote`. Clearing it here, at every
    // line's first character, makes the reset unconditional on reaching a
    // new line rather than on how the previous line's last token happened
    // to be shaped.
    s->block_quote_level = 0;
  }
  bool is_newline = lexer->lookahead == '\n';

  if (is_newline) {
    s->block_quote_level = 0;
  }

#ifdef DEBUG
  printf("Setup whitespace\n");
  printf("  block_quote_level: %u\n", s->block_quote_level);
  printf("  indent: %u\n", s->indent);
  printf("  is_newline: %b\n", is_newline);
  printf("---\n");
#endif

  if (valid_symbols[ERROR]) {
    lexer->result_symbol = ERROR;
    return true;
  }

  if (valid_symbols[BLOCK_CLOSE] && handle_blocks_to_close(s, lexer)) {
    return true;
  }
  // The above shouldn't allow us to continue past this point,
  // but it may happen if we've encountered a bug somewhere.
#ifdef DEBUG
  assert(s->blocks_to_close == 0);
#else
  if (s->blocks_to_close > 0) {
    return ERROR;
  }
#endif

  // Please note that the parse ordering here is quite messy and there's
  // a lot of order dependencies implicit in the implementation.
  // One day we should clean it up but for now just be aware that
  // it's not possible to simply reorder these however we want.

  if (valid_symbols[BLOCK_CLOSE] &&
      close_list_nested_block_if_needed(s, lexer, !is_newline)) {
    return true;
  }

  if (is_newline && parse_newline(s, lexer, valid_symbols)) {
    return true;
  }

  // A row attribute block glued to a row's closing pipe (`| a | b |{.head}`)
  // is consumed by the row-end-newline token even though it does not start on
  // a newline.
  if (lexer->lookahead == '{' && valid_symbols[TABLE_ROW_END_NEWLINE] &&
      parse_table_end_newline(s, lexer)) {
    return true;
  }

  // Needs to be done before indented content spacer and list item continuation
  // Before the block-quote scan: inside an open comment fence the `> ` on a
  // body or closer line belongs to the comment, not to the quote's own
  // structure, and only this function knows a fence is open.
  if (parse_comment_fence(s, lexer, valid_symbols)) {
    return true;
  }
  if (lexer->lookahead == '`' && parse_backtick(s, lexer, valid_symbols)) {
    return true;
  }
  // A colon line that ENDS the open paragraph is decided before the colon
  // scanner runs, because that scanner consumes as it classifies: when it gets
  // as far as `:: ` and the term marker is not valid in this state, the lexer
  // has already moved past the marker and the close-paragraph probe below sees
  // the middle of a line. A sibling `:: term` was swallowed by the term above
  // it for exactly that reason (tree-sitter-carve#48). Both probes start at the
  // same character, and only one of them can go first.
  if (valid_symbols[CLOSE_PARAGRAPH] && lexer->lookahead == ':' &&
      parse_close_paragraph(s, lexer)) {
    return true;
  }
  if (lexer->lookahead == ':' && parse_colon(s, lexer, valid_symbols)) {
    return true;
  }

  if (valid_symbols[INDENTED_CONTENT_SPACER] &&
      parse_indented_content_spacer(s, lexer, is_newline)) {
    return true;
  }

  if (valid_symbols[LIST_ITEM_CONTINUATION] &&
      parse_list_item_continuation(s, lexer)) {
    return true;
  }
  if (valid_symbols[FOOTNOTE_CONTINUATION] &&
      parse_footnote_continuation(s, lexer)) {
    return true;
  }

  // Verbatim content parsing is responsible for setting VERBATIM_END
  // for normal instances as well.
  if (valid_symbols[VERBATIM_CONTENT] && parse_verbatim_content(s, lexer)) {
    return true;
  }

  if (valid_symbols[CLOSE_PARAGRAPH] && parse_close_paragraph(s, lexer)) {
    return true;
  }
  if (valid_symbols[FOOTNOTE_END] && parse_footnote_end(s, lexer)) {
    return true;
  }
  if (valid_symbols[LINK_REF_DEF_LABEL_END] &&
      parse_link_ref_def_label_end(s, lexer)) {
    return true;
  }

  // A lone `+` continuation marker must win over closing the list item: it
  // attaches the next flush-left block to the current item/quote instead of
  // ending it. Only valid where the grammar expects it.
  if (lexer->lookahead == '+' && valid_symbols[LIST_CONTINUATION_MARKER] &&
      parse_continuation_marker(s, lexer)) {
    return true;
  }

  // End previous list item before opening new ones.
  if (valid_symbols[LIST_ITEM_END] &&
      parse_list_item_end(s, lexer, valid_symbols)) {
    return true;
  }

  if (parse_block_quote(s, lexer, valid_symbols)) {
    return true;
  }
  if (parse_heading(s, lexer, valid_symbols)) {
    return true;
  }
  if (parse_comment_end(s, lexer, valid_symbols)) {
    return true;
  }

  switch (lexer->lookahead) {
  case '[':
    if (parse_open_bracket(s, lexer, valid_symbols)) {
      return true;
    }
    break;
  case '-':
    if (parse_dash(s, lexer, valid_symbols)) {
      return true;
    }
    break;
  case '*':
    if (parse_star(s, lexer, valid_symbols)) {
      return true;
    }
    break;
  case '|':
    if (parse_table_begin(s, lexer, valid_symbols)) {
      return true;
    }
    break;
  case '{':
    if (parse_open_curly_bracket(s, lexer, valid_symbols)) {
      return true;
    }
    break;
  default:
    break;
  }

  if (valid_symbols[HIGHLIGHTED_OPEN_CHECK] &&
      check_highlighted_open(s, lexer)) {
    return true;
  }

  if (valid_symbols[NON_WHITESPACE_CHECK] && check_non_whitespace(s, lexer)) {
    return true;
  }

  // Span scanning for inline elements, implemented
  // in the same way to have consistent precedence handling.
  // Before STRONG: an open bold-italic must be offered the `*/` closer before
  // the `*` in it can be read as a strong delimiter.
  if (parse_span(s, lexer, valid_symbols, BOLD_ITALIC)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, EMPHASIS)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, STRONG)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, UNDERLINE)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, STRIKETHROUGH)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, SUPERSCRIPT)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, SUBSCRIPT)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, HIGHLIGHTED)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, INSERT)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, DELETE)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, PARENS_SPAN)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, CURLY_BRACKET_SPAN)) {
    return true;
  }
  if (parse_span(s, lexer, valid_symbols, SQUARE_BRACKET_SPAN)) {
    return true;
  }

  // Scan ordered list markers outside because the parsing may conflict with
  // closing of lists (both may try to parse the same characters).
  TokenType ordered_list_marker = scan_ordered_list_marker_token(s, lexer);
  if (ordered_list_marker != IGNORED &&
      handle_ordered_list_marker(s, lexer, valid_symbols,
                                 ordered_list_marker)) {
    return true;
  }

  if (valid_symbols[TABLE_CAPTION_END] && parse_table_caption_end(s, lexer)) {
    return true;
  }
  if (valid_symbols[TABLE_CAPTION_BEGIN] &&
      parse_table_caption_begin(s, lexer)) {
    return true;
  }

  if (valid_symbols[TABLE_CELL_END] && parse_table_cell_end(s, lexer)) {
    return true;
  }

  if (valid_symbols[HARD_LINE_BREAK] && parse_hard_line_break(s, lexer)) {
    return true;
  }

  // May scan a complete list marker, which we can't do before checking if
  // we should output the list marker itself.
  // Yeah, the order dependencies aren't very nice.
  if (valid_symbols[BLOCK_CLOSE] &&
      try_close_different_typed_list(s, lexer, ordered_list_marker)) {
    return true;
  }

  if (valid_symbols[EOF_OR_NEWLINE] && lexer->eof(lexer)) {
    lexer->result_symbol = EOF_OR_NEWLINE;
    return true;
  }

  // LAST: the opener's own probe reads forward to the end of the document
  // looking for a closer, and a probe that consumes and then declines leaves
  // every later probe in the same call reading from where it stopped. Nothing
  // runs after this one, so there is nothing left to poison.
  if (lexer->lookahead == '%' &&
      parse_comment_fence_begin(s, lexer, valid_symbols)) {
    return true;
  }
  return false;
}

static void init(Scanner *s) {
  array_init(s->open_inline);
  array_init(s->open_blocks);
  s->blocks_to_close = 0;
  s->block_quote_level = 0;
  s->indent = 0;
  s->marker_end_col = 0;
  s->state = 0;
}

void *tree_sitter_carve_external_scanner_create() {
  Scanner *s = (Scanner *)ts_malloc(sizeof(Scanner));
  s->open_blocks = ts_malloc(sizeof(Array(Block *)));
  s->open_inline = ts_malloc(sizeof(Array(Inline *)));
  init(s);
  return s;
}

void tree_sitter_carve_external_scanner_destroy(void *payload) {
  Scanner *s = (Scanner *)payload;
  for (size_t i = 0; i < s->open_blocks->size; ++i) {
    ts_free(*array_get(s->open_blocks, i));
  }
  array_delete(s->open_blocks);
  for (size_t i = 0; i < s->open_inline->size; ++i) {
    ts_free(*array_get(s->open_inline, i));
  }
  array_delete(s->open_inline);
  ts_free(s);
}

unsigned tree_sitter_carve_external_scanner_serialize(void *payload,
                                                     char *buffer) {
  Scanner *s = (Scanner *)payload;
  unsigned size = 0;
  buffer[size++] = (char)s->blocks_to_close;
  buffer[size++] = (char)s->block_quote_level;
  buffer[size++] = (char)s->indent;
  buffer[size++] = (char)s->marker_end_col;
  buffer[size++] = (char)s->state;

  buffer[size++] = (char)s->open_blocks->size;
  for (size_t i = 0; i < s->open_blocks->size; ++i) {
    Block *b = *array_get(s->open_blocks, i);
    buffer[size++] = (char)b->type;
    buffer[size++] = (char)b->data;
    buffer[size++] = (char)b->content_col;
  }

  for (size_t i = 0; i < s->open_inline->size; ++i) {
    Inline *x = *array_get(s->open_inline, i);
    buffer[size++] = (char)x->type;
    buffer[size++] = (char)x->data;
  }

  return size;
}

void tree_sitter_carve_external_scanner_deserialize(void *payload, char *buffer,
                                                   unsigned length) {
  Scanner *s = (Scanner *)payload;
  init(s);
  if (length > 0) {
    size_t size = 0;
    s->blocks_to_close = (uint8_t)buffer[size++];
    s->block_quote_level = (uint8_t)buffer[size++];
    s->indent = (uint8_t)buffer[size++];
    s->marker_end_col = (uint8_t)buffer[size++];
    s->state = (uint8_t)buffer[size++];

    uint8_t open_blocks = (uint8_t)buffer[size++];
    while (open_blocks-- > 0) {
      BlockType type = (BlockType)buffer[size++];
      uint8_t level = (uint8_t)buffer[size++];
      uint8_t content_col = (uint8_t)buffer[size++];
      Block *b = create_block(type, level);
      b->content_col = content_col;
      array_push(s->open_blocks, b);
    }
    while (size < length) {
      InlineType type = (InlineType)buffer[size++];
      uint8_t data = (uint8_t)buffer[size++];
      array_push(s->open_inline, create_inline(type, data));
    }
  }
}

#ifdef DEBUG

static char *token_type_s(TokenType t) {
  switch (t) {
  case IGNORED:
    return "IGNORED";

  case BLOCK_CLOSE:
    return "BLOCK_CLOSE";
  case EOF_OR_NEWLINE:
    return "EOF_OR_NEWLINE";
  case NEWLINE:
    return "NEWLINE";
  case NEWLINE_INLINE:
    return "NEWLINE_INLINE";
  case NON_WHITESPACE_CHECK:
    return "NON_WHITESPACE_CHECK";
  case HIGHLIGHTED_OPEN_CHECK:
    return "HIGHLIGHTED_OPEN_CHECK";

  case FRONTMATTER_MARKER:
    return "FRONTMATTER_MARKER";

  case HEADING_BEGIN:
    return "HEADING";
  case DIV_BEGIN:
    return "DIV_BEGIN";
  case DIV_END:
    return "DIV_END";
  case CODE_BLOCK_BEGIN:
    return "CODE_BLOCK_BEGIN";
  case CODE_BLOCK_END:
    return "CODE_BLOCK_END";
  case COMMENT_FENCE_BEGIN:
    return "COMMENT_FENCE_BEGIN";
  case COMMENT_FENCE_CONTENT:
    return "COMMENT_FENCE_CONTENT";
  case COMMENT_FENCE_END:
    return "COMMENT_FENCE_END";
  case NOT_A_CONTAINER_OPENER:
    return "NOT_A_CONTAINER_OPENER";
  case LIST_MARKER_DASH:
    return "LIST_MARKER_DASH";
  case LIST_MARKER_STAR:
    return "LIST_MARKER_STAR";
  case LIST_MARKER_TASK_BEGIN:
    return "LIST_MARKER_TASK_BEGIN";
  case LIST_MARKER_DEFINITION:
    return "LIST_MARKER_DEFINITION";
  case LIST_MARKER_DESCRIPTION:
    return "LIST_MARKER_DESCRIPTION";
  case LIST_MARKER_DECIMAL_PERIOD:
    return "LIST_MARKER_DECIMAL_PERIOD";
  case LIST_MARKER_LOWER_ALPHA_PERIOD:
    return "LIST_MARKER_LOWER_ALPHA_PERIOD";
  case LIST_MARKER_UPPER_ALPHA_PERIOD:
    return "LIST_MARKER_UPPER_ALPHA_PERIOD";
  case LIST_MARKER_LOWER_ROMAN_PERIOD:
    return "LIST_MARKER_LOWER_ROMAN_PERIOD";
  case LIST_MARKER_UPPER_ROMAN_PERIOD:
    return "LIST_MARKER_UPPER_ROMAN_PERIOD";
  case LIST_MARKER_DECIMAL_PAREN:
    return "LIST_MARKER_DECIMAL_PAREN";
  case LIST_MARKER_LOWER_ALPHA_PAREN:
    return "LIST_MARKER_LOWER_ALPHA_PAREN";
  case LIST_MARKER_UPPER_ALPHA_PAREN:
    return "LIST_MARKER_UPPER_ALPHA_PAREN";
  case LIST_MARKER_LOWER_ROMAN_PAREN:
    return "LIST_MARKER_LOWER_ROMAN_PAREN";
  case LIST_MARKER_UPPER_ROMAN_PAREN:
    return "LIST_MARKER_UPPER_ROMAN_PAREN";
  case LIST_MARKER_DECIMAL_PARENS:
    return "LIST_MARKER_DECIMAL_PARENS";
  case LIST_MARKER_LOWER_ALPHA_PARENS:
    return "LIST_MARKER_LOWER_ALPHA_PARENS";
  case LIST_MARKER_UPPER_ALPHA_PARENS:
    return "LIST_MARKER_UPPER_ALPHA_PARENS";
  case LIST_MARKER_LOWER_ROMAN_PARENS:
    return "LIST_MARKER_LOWER_ROMAN_PARENS";
  case LIST_MARKER_UPPER_ROMAN_PARENS:
    return "LIST_MARKER_UPPER_ROMAN_PARENS";
  case LIST_ITEM_CONTINUATION:
    return "LIST_ITEM_CONTINUATION";
  case LIST_ITEM_END:
    return "LIST_ITEM_END";
  case INDENTED_CONTENT_SPACER:
    return "INDENTED_CONTENT_SPACER";
  case CLOSE_PARAGRAPH:
    return "CLOSE_PARAGRAPH";
  case BLOCK_QUOTE_BEGIN:
    return "BLOCK_QUOTE_BEGIN";
  case BLOCK_QUOTE_CONTINUATION:
    return "BLOCK_QUOTE_CONTINUATION";
  case THEMATIC_BREAK_DASH:
    return "THEMATIC_BREAK_DASH";
  case THEMATIC_BREAK_STAR:
    return "THEMATIC_BREAK_STAR";
  case FOOTNOTE_MARK_BEGIN:
    return "FOOTNOTE_MARK_BEGIN";
  case FOOTNOTE_CONTINUATION:
    return "FOOTNOTE_CONTINUATION";
  case FOOTNOTE_END:
    return "FOOTNOTE_END";
  case LINK_REF_DEF_MARK_BEGIN:
    return "LINK_REF_DEF_MARK_BEGIN";
  case LINK_REF_DEF_LABEL_END:
    return "LINK_REF_DEF_LABEL_END";
  case TABLE_HEADER_BEGIN:
    return "TABLE_HEADER_BEGIN";
  case TABLE_SEPARATOR_BEGIN:
    return "TABLE_SEPARATOR_BEGIN";
  case TABLE_ROW_BEGIN:
    return "TABLE_ROW_BEGIN";
  case TABLE_ROW_END_NEWLINE:
    return "TABLE_ROW_END_NEWLINE";
  case TABLE_CELL_END:
    return "TABLE_CELL_END";
  case TABLE_CAPTION_BEGIN:
    return "TABLE_CAPTION_BEGIN";
  case TABLE_CAPTION_END:
    return "TABLE_CAPTION_END";
  case BLOCK_ATTRIBUTE_BEGIN:
    return "BLOCK_ATTRIBUTE_BEGIN";
  case COMMENT_END_MARKER:
    return "COMMENT_END_MARKER";
  case COMMENT_CLOSE:
    return "COMMENT_CLOSE";

  case VERBATIM_BEGIN:
    return "VERBATIM_BEGIN";
  case VERBATIM_END:
    return "VERBATIM_END";
  case VERBATIM_CONTENT:
    return "VERBATIM_CONTENT";

  case EMPHASIS_MARK_BEGIN:
    return "EMPHASIS_MARK_BEGIN";
  case EMPHASIS_END:
    return "EMPHASIS_END";
  case STRONG_MARK_BEGIN:
    return "STRONG_MARK_BEGIN";
  case STRONG_END:
    return "STRONG_END";
  case UNDERLINE_MARK_BEGIN:
    return "UNDERLINE_MARK_BEGIN";
  case UNDERLINE_END:
    return "UNDERLINE_END";
  case STRIKETHROUGH_MARK_BEGIN:
    return "STRIKETHROUGH_MARK_BEGIN";
  case STRIKETHROUGH_END:
    return "STRIKETHROUGH_END";
  case SUPERSCRIPT_MARK_BEGIN:
    return "SUPERSCRIPT_MARK_BEGIN";
  case SUPERSCRIPT_END:
    return "SUPERSCRIPT_END";
  case SUBSCRIPT_MARK_BEGIN:
    return "SUBSCRIPT_MARK_BEGIN";
  case SUBSCRIPT_END:
    return "SUBSCRIPT_END";
  case HIGHLIGHTED_MARK_BEGIN:
    return "HIGHLIGHTED_MARK_BEGIN";
  case HIGHLIGHTED_END:
    return "HIGHLIGHTED_END";
  case INSERT_MARK_BEGIN:
    return "INSERT_MARK_BEGIN";
  case INSERT_END:
    return "INSERT_END";
  case DELETE_MARK_BEGIN:
    return "DELETE_MARK_BEGIN";
  case DELETE_END:
    return "DELETE_END";

  case PARENS_SPAN_MARK_BEGIN:
    return "PARENS_SPAN_MARK_BEGIN";
  case PARENS_SPAN_END:
    return "PARENS_SPAN_END";
  case CURLY_BRACKET_SPAN_MARK_BEGIN:
    return "CURLY_BRACKET_SPAN_MARK_BEGIN";
  case CURLY_BRACKET_SPAN_END:
    return "CURLY_BRACKET_SPAN_END";
  case SQUARE_BRACKET_SPAN_MARK_BEGIN:
    return "SQUARE_BRACKET_SPAN_MARK_BEGIN";
  case SQUARE_BRACKET_SPAN_END:
    return "SQUARE_BRACKET_SPAN_END";

  case IN_FALLBACK:
    return "IN_FALLBACK";

  case ERROR:
    return "ERROR";

  case BOLD_ITALIC_MARK_BEGIN:
    return "BOLD_ITALIC_MARK_BEGIN";
  case BOLD_ITALIC_END:
    return "BOLD_ITALIC_END";
  case LIST_CONTINUATION_MARKER:
    return "LIST_CONTINUATION_MARKER";
    // default:
    //   return "NOT IMPLEMENTED";
  }
}

static char *block_type_s(BlockType t) {
  switch (t) {
  case SECTION:
    return "SECTION";
  case HEADING:
    return "HEADING";
  case DIV:
    return "DIV";
  case BLOCK_QUOTE:
    return "BLOCK_QUOTE";
  case CODE_BLOCK:
    return "CODE_BLOCK";
  case FOOTNOTE:
    return "FOOTNOTE";
  case LINK_REF_DEF:
    return "LINK_REF_DEF";
  case TABLE_ROW:
    return "TABLE_ROW";
  case TABLE_CAPTION:
    return "TABLE_CAPTION";
  case LIST_DASH:
    return "LIST_DASH";
  case LIST_STAR:
    return "LIST_STAR";
  case LIST_TASK:
    return "LIST_TASK";
  case LIST_DEFINITION:
    return "LIST_DEFINITION";
  case LIST_DECIMAL_PERIOD:
    return "LIST_DECIMAL_PERIOD";
  case LIST_LOWER_ALPHA_PERIOD:
    return "LIST_LOWER_ALPHA_PERIOD";
  case LIST_UPPER_ALPHA_PERIOD:
    return "LIST_UPPER_ALPHA_PERIOD";
  case LIST_LOWER_ROMAN_PERIOD:
    return "LIST_LOWER_ROMAN_PERIOD";
  case LIST_UPPER_ROMAN_PERIOD:
    return "LIST_UPPER_ROMAN_PERIOD";
  case LIST_DECIMAL_PAREN:
    return "LIST_DECIMAL_PAREN";
  case LIST_LOWER_ALPHA_PAREN:
    return "LIST_LOWER_ALPHA_PAREN";
  case LIST_UPPER_ALPHA_PAREN:
    return "LIST_UPPER_ALPHA_PAREN";
  case LIST_LOWER_ROMAN_PAREN:
    return "LIST_LOWER_ROMAN_PAREN";
  case LIST_UPPER_ROMAN_PAREN:
    return "LIST_UPPER_ROMAN_PAREN";
  case LIST_DECIMAL_PARENS:
    return "LIST_DECIMAL_PARENS";
  case LIST_LOWER_ALPHA_PARENS:
    return "LIST_LOWER_ALPHA_PARENS";
  case LIST_UPPER_ALPHA_PARENS:
    return "LIST_UPPER_ALPHA_PARENS";
  case LIST_LOWER_ROMAN_PARENS:
    return "LIST_LOWER_ROMAN_PARENS";
  case LIST_UPPER_ROMAN_PARENS:
    return "LIST_UPPER_ROMAN_PARENS";
    // default:
    //   return "NOT IMPLEMENTED";
  }
}

static char *inline_type_s(InlineType t) {
  switch (t) {
  case VERBATIM:
    return "VERBATIM";
  case BOLD_ITALIC:
    return "BOLD_ITALIC";
  case EMPHASIS:
    return "EMPHASIS";
  case STRONG:
    return "STRONG";
  case UNDERLINE:
    return "UNDERLINE";
  case STRIKETHROUGH:
    return "STRIKETHROUGH";
  case SUPERSCRIPT:
    return "SUPERSCRIPT";
  case SUBSCRIPT:
    return "SUBSCRIPT";
  case HIGHLIGHTED:
    return "HIGHLIGHTED";
  case INSERT:
    return "INSERT";
  case DELETE:
    return "DELETE";
  case PARENS_SPAN:
    return "PARENS_SPAN";
  case CURLY_BRACKET_SPAN:
    return "CURLY_BRACKET_SPAN";
  case SQUARE_BRACKET_SPAN:
    return "SQUARE_BRACKET_SPAN";
  default:
    return "NOT IMPLEMENTED";
  }
}

static void dump_scanner(Scanner *s) {
  if (s->open_blocks->size == 0) {
    printf("0 open blocks\n");
  } else {

    printf("--- Open blocks: %u (last -> first)\n", s->open_blocks->size);
    for (size_t i = 0; i < s->open_blocks->size; ++i) {
      Block *b = *array_get(s->open_blocks, i);
      printf("  %d %s\n", b->data, block_type_s(b->type));
    }
    printf("---\n");
  }
  if (s->open_inline->size == 0) {
    printf("0 open inline\n");
  } else {
    printf("--- Open inline: %u (last -> first)\n", s->open_inline->size);
    for (size_t i = 0; i < s->open_inline->size; ++i) {
      Inline *x = *array_get(s->open_inline, i);
      printf("  %d %s\n", x->data, inline_type_s(x->type));
    }
    printf("---\n");
  }
  printf("  blocks_to_close: %d\n", s->blocks_to_close);
  printf("  block_quote_level: %u\n", s->block_quote_level);
  printf("  indent: %u\n", s->indent);
  printf("  state: %u\n", s->state);
  if (s->state & STATE_BRACKET_STARTS_SPAN) {
    printf("    STATE_BRACKET_STARTS_SPAN\n");
  }
  if (s->state & STATE_BRACKET_STARTS_INLINE_LINK) {
    printf("    STATE_BRACKET_STARTS_INLINE_LINK\n");
  }
  printf("===\n");
}

static void dump(Scanner *s, TSLexer *lexer) {
  printf("=== Lookahead: ");
  if (lexer->eof(lexer)) {
    printf("eof\n");
  } else {
    printf("`%c`\n", lexer->lookahead);
  }
  dump_scanner(s);
}

static void dump_some_valid_symbols(const bool *valid_symbols) {
  if (valid_symbols[ERROR]) {
    printf("# In error recovery ALL SYMBOLS ARE VALID\n");
    return;
  }
  printf("# valid_symbols (shortened):\n");
  for (int i = 0; i <= ERROR; ++i) {
    switch (i) {
    case BLOCK_CLOSE:
    // case BLOCK_QUOTE_BEGIN:
    // case BLOCK_QUOTE_CONTINUATION:
    // case CLOSE_PARAGRAPH:
    case FOOTNOTE_MARK_BEGIN:
    case FOOTNOTE_END:
    case EOF_OR_NEWLINE:
    case NEWLINE:
    case NEWLINE_INLINE:
    case LINK_REF_DEF_MARK_BEGIN:
    case LINK_REF_DEF_LABEL_END:
    case SQUARE_BRACKET_SPAN_MARK_BEGIN:
    case SQUARE_BRACKET_SPAN_END:
      // case TABLE_HEADER_BEGIN:
      // case TABLE_SEPARATOR_BEGIN:
      // case TABLE_ROW_BEGIN:
      // case TABLE_ROW_END_NEWLINE:
      // case TABLE_CELL_END:
      // case TABLE_CAPTION_BEGIN:
      // case TABLE_CAPTION_END:
      // case LIST_MARKER_TASK_BEGIN:
      // case LIST_MARKER_DASH:
      // case LIST_MARKER_STAR:
      // case LIST_MARKER_PLUS:
      // case LIST_ITEM_CONTINUATION:
      // case LIST_ITEM_END:
      // case DIV_BEGIN:
      // case DIV_END:
      // case TABLE_CAPTION_BEGIN:
      // case TABLE_CAPTION_END:
      if (valid_symbols[i]) {
        printf("%s\n", token_type_s(i));
      }
      break;
    default:
      continue;
    }
  }
  printf("#\n");
}

static void dump_all_valid_symbols(const bool *valid_symbols) {
  if (valid_symbols[ERROR]) {
    printf("# In error recovery ALL SYMBOLS ARE VALID\n");
    return;
  }
  printf("# all valid_symbols:\n");
  for (int i = 0; i <= ERROR; ++i) {
    if (valid_symbols[i]) {
      printf("%s\n", token_type_s(i));
    }
  }
  printf("#\n");
}

#endif
