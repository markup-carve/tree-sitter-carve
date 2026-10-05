#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../src/scanner.c"

typedef struct {
  TSLexer lexer;
  const char *source;
  unsigned position, advances, columns;
} Input;

static void input_advance(TSLexer *lexer, bool skip) {
  (void)skip;
  Input *input = (Input *)lexer;
  if (input->source[input->position]) {
    ++input->position;
    ++input->advances;
  }
  lexer->lookahead = (unsigned char)input->source[input->position];
}
static void input_mark(TSLexer *lexer) { (void)lexer; }
static uint32_t input_column(TSLexer *lexer) {
  Input *input = (Input *)lexer;
  ++input->columns;
  unsigned start = input->position;
  while (start && input->source[start - 1] != '\n') --start;
  return input->position - start;
}
static bool input_range(const TSLexer *lexer) { (void)lexer; return false; }
static bool input_eof(const TSLexer *lexer) { return !lexer->lookahead; }

int main(void) {
  const char *fragments[] = {"{% x ", "{# x ", "{% {# x ", "`a]b` ", "{% a`b %} ", "{# a`b #} "};
  const unsigned sizes[] = {32, 64, 128, 256, 512, 1024, 4096};
  unsigned cases = 0;
  for (unsigned f = 0; f < sizeof(fragments) / sizeof(fragments[0]); ++f)
  for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    unsigned n = sizes[i], width = strlen(fragments[f]);
    unsigned bytes = width * n + strlen("]{.k}\n");
    char *source = malloc(bytes + 1);
    assert(source);
    for (unsigned k = 0; k < n; ++k) memcpy(source + width * k, fragments[f], width);
    strcpy(source + width * n, "]{.k}\n");
    Input input = {0};
    input.source = source;
    input.lexer = (TSLexer){source[0], 0, input_advance, input_mark,
      input_column, input_range, input_eof};
    Scanner *scanner = tree_sitter_carve_external_scanner_create();
    assert(update_square_bracket_lookahead_states(scanner, &input.lexer, NULL));
    assert(scanner->state & STATE_BRACKET_STARTS_SPAN);
    assert(scanner->advances <= 6 * bytes);
    assert(input.advances <= bytes);
    assert(input.columns <= 1);
    printf("family=%u n=%u bytes=%u scanner=%u host=%u columns=%u\n",
      f, n, bytes, scanner->advances, input.advances, input.columns);
    tree_sitter_carve_external_scanner_destroy(scanner);
    free(source);
    ++cases;
  }
  for (unsigned shape = 0; shape < 3; ++shape)
  for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    unsigned n = sizes[i];
    const char *tail = shape == 0 ? " b" : shape == 1 ? "] b" : " b*";
    unsigned bytes = 2 + 2 * n + strlen(tail);
    char *source = malloc(bytes + 1);
    assert(source);
    strcpy(source, "a ");
    for (unsigned k = 0; k < n; ++k) memcpy(source + 2 + 2 * k, "[ ", 2);
    strcpy(source + 2 + 2 * n, tail);
    Input input = {0};
    input.source = source;
    input.lexer = (TSLexer){source[0], 0, input_advance, input_mark,
      input_column, input_range, input_eof};
    Scanner *scanner = tree_sitter_carve_external_scanner_create();
    assert(bare_closer_skips_brackets(scanner, &input.lexer, '*', NULL) == (shape == 2));
    assert(scanner->advances <= 6 * bytes);
    assert(input.advances <= bytes);
    assert(input.columns <= 1);
    printf("bare=%u n=%u bytes=%u scanner=%u host=%u columns=%u\n",
      shape, n, bytes, scanner->advances, input.advances, input.columns);
    tree_sitter_carve_external_scanner_destroy(scanner);
    free(source);
    ++cases;
  }
  const char *payloads[] = {"a `b*} c` d] ", "a \\*} b] ", "a {*b c*}] "};
  for (unsigned shape = 0; shape < sizeof(payloads) / sizeof(payloads[0]); ++shape)
  for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    unsigned n = sizes[i], width = strlen(payloads[shape]);
    char *source = malloc(width + 2 * n + 4);
    assert(source);
    memcpy(source, payloads[shape], width);
    for (unsigned k = 0; k < n; ++k) memcpy(source + width + 2 * k, "z ", 2);
    strcpy(source + width + 2 * n, "*}\n");
    Input input = {0};
    input.source = source;
    input.lexer = (TSLexer){source[0], 0, input_advance, input_mark,
      input_column, input_range, input_eof};
    Scanner *scanner = tree_sitter_carve_external_scanner_create();
    push_inline_flagged(scanner, STRONG, 0, INLINE_BRACED);
    uint32_t remaining;
    bool changes_scope, opaque_cut;
    assert(extension_payload_closed(scanner, &input.lexer, &remaining, &changes_scope, &opaque_cut) == (shape != 2));
    assert(scanner->advances <= 4 * width);
    assert(input.advances <= width);
    assert(input.columns <= 1);
    printf("extension=%u n=%u scanner=%u host=%u columns=%u\n",
      shape, n, scanner->advances, input.advances, input.columns);
    tree_sitter_carve_external_scanner_destroy(scanner);
    free(source);
    ++cases;
  }
  printf("Bracket qualification work: %u probes retain linear work.\n", cases);
}
