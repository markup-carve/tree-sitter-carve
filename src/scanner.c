#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"
#include <stdio.h>

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
  HEADING_CONTINUATION,
  DIV_BEGIN,
  DIV_END,
  CODE_BLOCK_BEGIN,
  CODE_BLOCK_END,
  LIST_MARKER_DASH,
  LIST_MARKER_STAR,
  LIST_MARKER_TASK_BEGIN,
  LIST_MARKER_DEFINITION,
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
} TokenType;

// The different blocks in Carve that we track,
// in order to match or close them properly.
// Note that paragraphs are anonymous and aren't tracked.
typedef enum {
  BLOCK_QUOTE,
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

static TokenType scan_list_marker_token(Scanner *s, TSLexer *lexer);
static TokenType scan_unordered_list_marker_token(Scanner *s, TSLexer *lexer);

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
      indent += 4;
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
static bool has_extra_indent(Scanner *s) {
  for (int i = s->open_blocks->size - 1; i >= 0; --i) {
    Block *b = *array_get(s->open_blocks, i);
    if (is_list(b->type) || b->type == FOOTNOTE || b->type == TABLE_CAPTION) {
      // Inside such a container, any indent at or above its content threshold
      // is the container's own margin, not heading-disqualifying fuzz.
      return s->indent < b->data;
    }
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

static bool scan_div_marker(Scanner *s, TSLexer *lexer, uint8_t *colons,
                            size_t *from_top) {
  *colons = consume_chars(s, lexer, ':');
  if (*colons < 3) {
    return false;
  }
  *from_top = number_of_blocks_from_top(s, DIV, *colons);
  return true;
}

static bool is_div_marker_next(Scanner *s, TSLexer *lexer) {
  uint8_t colons;
  size_t from_top;
  return scan_div_marker(s, lexer, &colons, &from_top);
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

static bool try_end_code_block(Scanner *s, TSLexer *lexer, uint8_t ticks) {
  Block *top = peek_block(s);
  if (!top || top->type != CODE_BLOCK) {
    return false;
  }
  if (top->data != ticks) {
    return false;
  }
  remove_block(s);
  lexer->mark_end(lexer);
  lexer->result_symbol = CODE_BLOCK_END;
  return true;
}

static bool try_close_code_block(Scanner *s, TSLexer *lexer, uint8_t ticks) {
  Block *top = peek_block(s);
  if (!top || top->type != CODE_BLOCK) {
    return false;
  }
  if (top->data != ticks) {
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
    // Pin the token end at the ticks before `try_begin_code_block` peeks past
    // them to validate the fence info string: that validation may advance the
    // lexer before failing, and the verbatim fallback below must not swallow
    // the lookahead (it intentionally does not re-mark).
    lexer->mark_end(lexer);
    if (valid_symbols[CODE_BLOCK_BEGIN] &&
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
static bool scan_bullet_list_marker(Scanner *s, TSLexer *lexer, char marker) {
  if (lexer->lookahead != marker) {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != ' ') {
    return false;
  }
  advance(s, lexer);
  return true;
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
  // A marker can be `(a)` or `a)`.
  bool surrounding_parens = false;
  if (lexer->lookahead == '(') {
    surrounding_parens = true;
    advance(s, lexer);
  }

  OrderedListType list_type;
  if (!scan_ordered_list_type(s, lexer, &list_type)) {
    return IGNORED;
  }

  switch (lexer->lookahead) {
  case ')':
    advance(s, lexer);
    if (surrounding_parens) {
      // (a)
      switch (list_type) {
      case DECIMAL:
        return LIST_MARKER_DECIMAL_PARENS;
      case LOWER_ALPHA:
        return LIST_MARKER_LOWER_ALPHA_PARENS;
      case UPPER_ALPHA:
        return LIST_MARKER_UPPER_ALPHA_PARENS;
      case LOWER_ROMAN:
        return LIST_MARKER_LOWER_ROMAN_PARENS;
      case UPPER_ROMAN:
        return LIST_MARKER_UPPER_ROMAN_PARENS;
      default:
        return IGNORED;
      }
    } else {
      // a)
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
  if (scan_bullet_list_marker(s, lexer, ':')) {
    return LIST_MARKER_DEFINITION;
  }
  return IGNORED;
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

// Can we scan a block closing marker?
// For example, if we see a valid div marker.
static bool scan_containing_block_closing_marker(Scanner *s, TSLexer *lexer) {
  return is_div_marker_next(s, lexer) || scan_list_marker(s, lexer);
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
// When a list IS already open, a marker is a list operation, not a fold: it
// continues the list with a sibling item (or, for a different type/indent,
// closes it and opens a new one), so it still ends the item's paragraph -- e.g.
// consecutive "- a \n - b" stay separate items. Pinned by carve corpus
// 76-paragraph-interruption, 77/81 lazy-continuation, and 05-lists.
static bool scan_paragraph_closing_marker(Scanner *s, TSLexer *lexer) {
  if (is_div_marker_next(s, lexer)) {
    return true;
  }
  return find_list(s) != NULL && scan_list_marker(s, lexer);
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

  // We should prioritize a thematic break over lists.
  // We need to remember if a '- ' is found, which means we can open a list.
  bool can_be_list_marker =
      (valid_symbols[marker_type] || valid_symbols[LIST_MARKER_TASK_BEGIN]) &&
      lexer->lookahead == ' ';

  // We have now checked the two first characters.
  uint32_t marker_count = lexer->lookahead == marker ? 2 : 1;

  bool can_be_thematic_break = valid_symbols[thematic_break_type] &&
                               (marker_count == 2 || lexer->lookahead == ' ');

  // We might have scanned a '- ', we need to mark the end here
  // so we can go back to simply returning a list marker that
  // only consumes these two characters.
  advance(s, lexer);
  lexer->mark_end(lexer);

  // Check frontmatter, if needed.
  if (check_frontmatter) {
    marker_count += consume_chars(s, lexer, marker);
    if (marker_count >= 3) {
      lexer->result_symbol = FRONTMATTER_MARKER;
      lexer->mark_end(lexer);
      return true;
    }
  }

  // Check a thematic break that can span the entire line.
  if (can_be_thematic_break) {
    marker_count += consume_line_with_char_or_whitespace(s, lexer, marker);
    if (marker_count >= 3) {
      lexer->result_symbol = thematic_break_type;
      lexer->mark_end(lexer);
      return true;
    }
  }

  if (can_be_list_marker) {
    if (valid_symbols[LIST_MARKER_TASK_BEGIN]) {
      if (scan_task_list_marker(s, lexer)) {
        ensure_list_open(s, LIST_TASK, list_indent + 1);
        // The committed token is the two-char `<bullet> ` (the checkbox is
        // grammar-level), so the chain column is right after it.
        s->marker_end_col = (uint8_t)(start_col + 2);
        lexer->result_symbol = LIST_MARKER_TASK_BEGIN;
        return true;
      }
    }

    if (valid_symbols[marker_type]) {
      // A content-less marker line is paragraph text, not a list (the token end
      // is already marked above, so this lookahead is scratch).
      if (!marker_line_has_content(s, lexer)) {
        return false;
      }
      ensure_list_open(s, list_type, list_indent + 1);
      s->marker_end_col = (uint8_t)(start_col + 2);
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

  // Don't actually have to have anything else after the colon.
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

static bool scan_footnote_begin(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '^') {
    return false;
  }
  advance(s, lexer);

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

  // Don't actually have to have anything else after the colon.
  return true;
}

static bool parse_footnote_begin(Scanner *s, TSLexer *lexer,
                                 const bool *valid_symbols) {
  if (!valid_symbols[FOOTNOTE_MARK_BEGIN]) {
    return false;
  }
  if (!scan_footnote_begin(s, lexer)) {
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

  // Scan initial `[^`
  if (lexer->lookahead != '[') {
    return false;
  }
  advance(s, lexer);

  if (lexer->lookahead == '^') {
    return parse_footnote_begin(s, lexer, valid_symbols);
  } else {
    return parse_ref_def_begin(s, lexer, valid_symbols);
  }
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
  bool can_be_div = valid_symbols[DIV_BEGIN] || valid_symbols[DIV_END] ||
                    valid_symbols[BLOCK_CLOSE];
  if (!valid_symbols[LIST_MARKER_DEFINITION] && !can_be_div) {
    return false;
  }
#ifdef DEBUG
  assert(lexer->lookahead == ':');
#endif
  advance(s, lexer);

  if (lexer->lookahead == ' ') {
    // Found a `: `, can only be a list.
    if (valid_symbols[LIST_MARKER_DEFINITION]) {
      // Mark the token end before the content probe (scratch advances must not
      // extend it), then require non-empty content: a content-less `: ` line is
      // paragraph text, not a definition item.
      lexer->mark_end(lexer);
      if (!marker_line_has_content(s, lexer)) {
        return false;
      }
      ensure_list_open(s, LIST_DEFINITION, s->indent + 1);
      lexer->result_symbol = LIST_MARKER_DEFINITION;
      return true;
    } else {
      // Can't be a div anymore.
      return false;
    }
  }

  if (!can_be_div) {
    return false;
  }

  // We consumed a colon in the start of the function.
  uint8_t colons = consume_chars(s, lexer, ':') + 1;
  if (colons < 3) {
    return false;
  }

  size_t from_top = number_of_blocks_from_top(s, DIV, colons);

  if (from_top == 0) {
    if (!valid_symbols[DIV_BEGIN]) {
      return false;
    }
    // The token ends at the colons; mark it before peeking further so the
    // lookahead used to validate the rest of the fence line is not folded
    // into the DIV_BEGIN token.
    lexer->mark_end(lexer);
    // Validate what follows the `:::` fence. A bare fence (newline/EOF), a
    // line-block bar (`|`), a class name (letter or `_`), or a bare grouping
    // label (`[...]`, a typeless tab member; PART 9 §12) is fine. A `{`
    // attribute block (`::: {.x}`), a digit-leading class (`::: 123`), or any
    // other lead char makes the line a literal paragraph per the spec, so
    // refuse the div opener there.
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      advance(s, lexer);
    }
    int32_t c = lexer->lookahead;
    bool ok = c == '\n' || lexer->eof(lexer) || c == '|' || c == '[' ||
              (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_';
    if (!ok) {
      return false;
    }
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
    // An indented `#` line is NOT a marker. Inside an open heading it folds in
    // as PLAIN TEXT (an indented `#` continuation line is ordinary text, not a
    // same-`#` continuation marker), exactly like a no-`#` lazy line; outside a
    // heading it is a paragraph. We leave the `#`s unconsumed (no mark_end) so
    // the following inline line keeps them as text.
    if (top_heading && valid_symbols[HEADING_CONTINUATION]) {
      lexer->result_symbol = HEADING_CONTINUATION;
      return true;
    }
    return false;
  }

  // We found a `# ` that can start or continue a heading.
  if (hash_count > 0 && lexer->lookahead == ' ') {
    if (!valid_symbols[HEADING_BEGIN] && !valid_symbols[HEADING_CONTINUATION] &&
        !valid_symbols[BLOCK_CLOSE]) {
      return false;
    }

    advance(s, lexer); // Consume the ' '.

    if (valid_symbols[HEADING_CONTINUATION] && top_heading &&
        top->data == hash_count) {
      // We're in a heading matching the same number of '#'.
      lexer->mark_end(lexer);
      lexer->result_symbol = HEADING_CONTINUATION;
      return true;
    }

    if (valid_symbols[BLOCK_CLOSE] && top_heading && top->data != hash_count &&
        s->open_inline->size == 0) {
      // Found a mismatched heading level, need to close the previous
      // before opening this one.
      lexer->result_symbol = BLOCK_CLOSE;
      remove_block(s);
      return true;
    }

    // Open a new heading. (A same-`#` continuation was already handled above,
    // so any marker reaching here differs from the open heading's count and
    // starts a NEW heading -- djot's same-`#` rule, NOT the old same-or-fewer
    // continuation leniency.)
    if (valid_symbols[HEADING_BEGIN]) {
      // Sections are created on the root level (or nested inside other
      // sections). A heading with MORE `#` nests a new section; one with the
      // same or FEWER `#` closes the open section(s) and opens a sibling.
      if (!top || (top->type == SECTION && top->data < hash_count)) {
        push_block(s, SECTION, hash_count);
      } else if (top && top->type == SECTION && top->data >= hash_count) {
        // NOTE closing multiple nested sections requires us to re-scan the
        // heading when we return without saving our work.
        lexer->result_symbol = BLOCK_CLOSE;
        remove_block(s);
        return true;
      }

      push_block(s, HEADING, hash_count);
      lexer->mark_end(lexer);
      lexer->result_symbol = HEADING_BEGIN;
      return true;
    }
  } else if (hash_count == 0 && top_heading) {
    // We didn't find any `#`, but we might be able to continue
    // the heading lazily.

    // We need to always provide a BLOCK_CLOSE to end headings.
    // We do this here, either when a blankline is followed or
    // by the end of a container block.
    if (valid_symbols[BLOCK_CLOSE] &&
        (scan_eof_or_blankline(s, lexer) ||
         scan_containing_block_closing_marker(s, lexer))) {
      remove_block(s);
      lexer->result_symbol = BLOCK_CLOSE;
      return true;
    }

    // We should continue the heading, if it's open.
    if (valid_symbols[HEADING_CONTINUATION]) {
      lexer->result_symbol = HEADING_CONTINUATION;
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
static bool scan_table_cell(Scanner *s, TSLexer *lexer, bool *separator,
                            bool *empty) {
  uint8_t leading_ws = consume_whitespace(s, lexer);

  *separator = true;
  *empty = false;

  bool first_char = true;
  while (!lexer->eof(lexer)) {
    switch (lexer->lookahead) {
    case '\\':
      *separator = false;
      advance(s, lexer);
      advance(s, lexer);
      break;
    case '\n':
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
  while (scan_table_cell(s, lexer, &curr_separator, &curr_empty)) {
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

  if (cell_count == 0 || !any_content) {
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
  bool curr_separator;
  bool curr_empty;
  while (scan_table_cell(s, lexer, &curr_separator, &curr_empty)) {
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

  // A row whose pipe gaps are all zero-width (`||`) has no cells and is not
  // a table row (corpus 111: `||` alone stays paragraph text). Whitespace-only
  // gaps (`| |`) are real, empty cells and keep the row valid.
  if (cell_count == 0 || !any_content) {
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
                 valid_symbols[BLOCK_ATTRIBUTE_BEGIN]) {
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

// carve-php standalone caption: a line starting with `^ ` (caret + space or
// tab) at block position must terminate any paragraph that was continuing,
// so the caption rule can fire as a sibling block. The advance() calls here
// are scratch — they don't commit (only mark_end commits), so the caption
// rule itself will still see `^` at the new block-line start.
static bool scan_caption_at_paragraph_end(Scanner *s, TSLexer *lexer) {
  if (lexer->lookahead != '^') {
    return false;
  }
  advance(s, lexer);
  if (lexer->lookahead != ' ' && lexer->lookahead != '\t') {
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
  if (valid_symbols[NEWLINE]) {
    lexer->result_symbol = NEWLINE;
    return true;
  }

  if (valid_symbols[EOF_OR_NEWLINE]) {
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
  if (lexer->lookahead == '`' && parse_backtick(s, lexer, valid_symbols)) {
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
      array_push(s->open_blocks, create_block(type, level));
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
  case HEADING_CONTINUATION:
    return "HEADING_CONTINUATION";
  case DIV_BEGIN:
    return "DIV_BEGIN";
  case DIV_END:
    return "DIV_END";
  case CODE_BLOCK_BEGIN:
    return "CODE_BLOCK_BEGIN";
  case CODE_BLOCK_END:
    return "CODE_BLOCK_END";
  case LIST_MARKER_DASH:
    return "LIST_MARKER_DASH";
  case LIST_MARKER_STAR:
    return "LIST_MARKER_STAR";
  case LIST_MARKER_TASK_BEGIN:
    return "LIST_MARKER_TASK_BEGIN";
  case LIST_MARKER_DEFINITION:
    return "LIST_MARKER_DEFINITION";
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
