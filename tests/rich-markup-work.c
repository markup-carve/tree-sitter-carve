#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <tree_sitter/api.h>

extern const TSLanguage *tree_sitter_carve(void);
extern unsigned long long carve_scanner_advances, carve_lexer_advances;

static uint32_t read_u32(FILE *input) {
  unsigned char bytes[4];
  assert(fread(bytes, 1, 4, input) == 4);
  return (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 |
         (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}

static uint64_t micros(void) {
  struct timespec t;
  assert(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
  return (uint64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000;
}

int main(int argc, char **argv) {
  assert(argc == 2);
  FILE *input = fopen(argv[1], "rb");
  assert(input);
  uint32_t count = read_u32(input);
  TSParser *parser = ts_parser_new();
  assert(ts_parser_set_language(parser, tree_sitter_carve()));
  ts_parser_set_timeout_micros(parser, 10000000);
  for (uint32_t i = 0; i < count; ++i) {
    uint32_t family = read_u32(input), n = read_u32(input);
    uint32_t ending = read_u32(input), bytes = read_u32(input);
    assert(bytes > 0 && bytes < 1024 * 1024);
    char *source = malloc(bytes + 1);
    assert(source && fread(source, 1, bytes, input) == bytes);
    source[bytes] = 0;
    carve_scanner_advances = carve_lexer_advances = 0;
    uint64_t start = micros();
    TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
    uint64_t elapsed = micros() - start;
    unsigned paragraphs = 0, spans = 0, strong = 0, emphasis = 0, verbatim = 0, combined = 0;
    if (tree) {
      TSTreeCursor cursor = ts_tree_cursor_new(ts_tree_root_node(tree));
      for (;;) {
        const char *type = ts_node_type(ts_tree_cursor_current_node(&cursor));
        if (!strcmp(type, "paragraph")) ++paragraphs;
        else if (!strcmp(type, "span")) ++spans;
        else if (!strcmp(type, "strong")) ++strong;
        else if (!strcmp(type, "emphasis")) ++emphasis;
        else if (!strcmp(type, "verbatim")) ++verbatim;
        else if (!strcmp(type, "bold_italic")) ++combined;
        if (ts_tree_cursor_goto_first_child(&cursor)) continue;
        while (!ts_tree_cursor_goto_next_sibling(&cursor)) {
          if (!ts_tree_cursor_goto_parent(&cursor)) goto counted;
        }
      }
    counted:
      ts_tree_cursor_delete(&cursor);
    }
    printf("family=%u n=%u ending=%u bytes=%u scanner=%llu lexer=%llu micros=%llu status=%s p=%u span=%u strong=%u em=%u code=%u bi=%u\n",
           family, n, ending, bytes, carve_scanner_advances,
           carve_lexer_advances, (unsigned long long)elapsed,
           !tree ? "timeout" : ts_node_has_error(ts_tree_root_node(tree)) ? "error" : "ok",
           paragraphs, spans, strong, emphasis, verbatim, combined);
    fflush(stdout);
    if (tree) ts_tree_delete(tree);
    else ts_parser_reset(parser);
    free(source);
  }
  assert(fgetc(input) == EOF);
  fclose(input);
  ts_parser_delete(parser);
}
