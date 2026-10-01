#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tree_sitter/api.h>

extern const TSLanguage *tree_sitter_carve(void);
extern unsigned long long carve_scanner_advances, carve_lexer_advances;

static unsigned count(TSNode node, const char *kind) {
  unsigned total = strcmp(ts_node_type(node), kind) == 0;
  for (unsigned i = 0; i < ts_node_named_child_count(node); ++i)
    total += count(ts_node_named_child(node, i), kind);
  return total;
}

int main(int argc, char **argv) {
  bool baseline = argc > 1 && strcmp(argv[1], "baseline") == 0;
  TSParser *parser = ts_parser_new();
  assert(ts_parser_set_language(parser, tree_sitter_carve()));
  const char *fragments[] = {"[a {%b%}] ", "[a {%b%}]{.k} ", "a|", "[a\\|b]{.k} ", "a|"};
  const unsigned sizes[] = {32, 64, 128, 256, 512, 1024, 4096};
  for (unsigned family = 0; family < 5; ++family) {
    unsigned long long previous = 0;
    unsigned previous_n = 0;
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
      unsigned n = sizes[i];
      if (n > (family == 2 || family == 4 ? 128 : 512)) break;
      const char *head = family >= 2 ? "|" : "";
      const char *tail = family == 4 ? "[x]{.k} |\n" : family == 3 ? "|\n" : "\n";
      size_t width = strlen(fragments[family]);
      size_t bytes = strlen(head) + width * n + strlen(tail);
      char *source = malloc(bytes + 1);
      assert(source);
      memcpy(source, head, strlen(head));
      for (unsigned j = 0; j < n; ++j)
        memcpy(source + strlen(head) + j * width, fragments[family], width);
      strcpy(source + strlen(head) + n * width, tail);
      carve_scanner_advances = carve_lexer_advances = 0;
      TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
      assert(tree && !ts_node_has_error(ts_tree_root_node(tree)));
      TSNode root = ts_tree_root_node(tree);
      assert(count(root, "span") == (family == 4 ? 1 : family == 1 || family == 3 ? n : 0));
      if (family >= 2) assert(count(root, "table_cell") == (family == 4 ? n + 1 : family == 2 ? n : 1));
      printf("family=%u n=%u bytes=%zu scanner=%llu lexer=%llu\n", family, n, bytes,
             carve_scanner_advances, carve_lexer_advances);
      fflush(stdout);
      if (!baseline) {
        assert(carve_scanner_advances <= 32ULL * bytes);
        unsigned long long budget = family == 2 || family == 4 ? 64ULL * bytes :
            (family == 0 ? 6ULL : 3ULL) * bytes * n;
        assert(carve_lexer_advances <= budget);
        if (previous_n && n == previous_n * 2)
          assert(carve_lexer_advances <= previous * (family == 2 || family == 4 ? 3 : 5));
      }
      previous = carve_lexer_advances;
      previous_n = n;
      ts_tree_delete(tree);
      free(source);
    }
  }
  ts_parser_delete(parser);
}
