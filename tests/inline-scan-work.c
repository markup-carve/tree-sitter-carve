#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tree_sitter/api.h>

extern const TSLanguage *tree_sitter_carve(void);
extern unsigned long long carve_scanner_advances, carve_lexer_advances;

// Each family repeats one fragment. Doubling it may at most double the work
// plus slack, so a reader that rescans the rest of the line or paragraph per
// opener fails here long before it shows up as wall-clock time.
typedef struct {
  const char *name, *fragment, *tail;
  double scanner_ratio, lexer_ratio;
} Family;

int main(int argc, char **argv) {
  bool baseline = argc > 1 && strcmp(argv[1], "baseline") == 0;
  TSParser *parser = ts_parser_new();
  assert(ts_parser_set_language(parser, tree_sitter_carve()));
  const Family families[] = {
    {"unclosed link tails", "[a](", "\n", 2.5, 2.5},
    {"unclosed strong", "*a ", "\n", 2.5, 2.5},
    {"unclosed emphasis", "/a ", "\n", 2.5, 2.5},
    {"one strong opener per line", "a *b\n", "", 2.5, 2.5},
    {"one long word", "abcde", "\n", 2.5, 2.5},
  };
  const unsigned sizes[] = {512, 1024, 2048, 4096};
  for (unsigned f = 0; f < sizeof(families) / sizeof(families[0]); ++f) {
    unsigned long long previous_scanner = 0, previous_lexer = 0;
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
      unsigned n = sizes[i];
      if (baseline && n > 1024) break;
      size_t width = strlen(families[f].fragment), bytes = width * n + strlen(families[f].tail);
      char *source = malloc(bytes + 1);
      assert(source);
      for (unsigned j = 0; j < n; ++j) memcpy(source + j * width, families[f].fragment, width);
      strcpy(source + n * width, families[f].tail);
      carve_scanner_advances = carve_lexer_advances = 0;
      TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
      assert(tree && !ts_node_has_error(ts_tree_root_node(tree)));
      printf("%s n=%u bytes=%zu scanner=%llu lexer=%llu\n", families[f].name, n, bytes,
             carve_scanner_advances, carve_lexer_advances);
      fflush(stdout);
      if (!baseline && previous_scanner) {
        assert(carve_scanner_advances <= previous_scanner * families[f].scanner_ratio);
        assert(carve_lexer_advances <= previous_lexer * families[f].lexer_ratio);
      }
      previous_scanner = carve_scanner_advances;
      previous_lexer = carve_lexer_advances;
      ts_tree_delete(tree);
      free(source);
    }
  }
  ts_parser_delete(parser);
}
