#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tree_sitter/api.h>

extern const TSLanguage *tree_sitter_carve(void);
extern unsigned long long carve_scanner_advances;
extern unsigned long long carve_lexer_advances;

int main(int argc, char **argv) {
  TSParser *parser = ts_parser_new();
  assert(ts_parser_set_language(parser, tree_sitter_carve()));
  const unsigned sizes[] = {128, 256, 512, 1024, 4096, 16384};
  const char *tails[] = {"z\n", "z\r\n", "z\r", "z", "z [x]\n", "z {x}\n", "z `x`\n", "z ...\n", "z.\n"};
  const char *prefixes[] = {"/*a ", "/*a [x] ", "/*a {x} ", "/*a `x` ", "/*a \\x "};
  bool baseline = argc > 1 && strcmp(argv[1], "baseline") == 0;
  for (unsigned prefix = 0; prefix < sizeof(prefixes)/sizeof(prefixes[0]); ++prefix)
  for (unsigned tail = 0; tail < sizeof(tails)/sizeof(tails[0]); ++tail)
  for (unsigned i = 0; i < sizeof(sizes)/sizeof(sizes[0]); ++i) {
    unsigned n = sizes[i], width = strlen(prefixes[prefix]);
    unsigned bytes = width * n + strlen(tails[tail]);
    if (baseline && n > 1024) break;
    if (prefix > 0 && n > 512) break;
    if (prefix > 0 && tail > 0) break;
    char *source = malloc(bytes + 1);
    assert(source);
    for (unsigned j = 0; j < n; ++j) memcpy(source + width*j, prefixes[prefix], width);
    memcpy(source + width*n, tails[tail], strlen(tails[tail]));
    source[bytes] = 0;
    carve_scanner_advances = 0;
    carve_lexer_advances = 0;
    TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
    assert(tree && !ts_node_has_error(ts_tree_root_node(tree)));
    TSNode root = ts_tree_root_node(tree);
    assert(ts_node_named_child_count(root) == 1);
    TSNode paragraph = ts_node_named_child(root, 0);
    assert(strcmp(ts_node_type(paragraph), "paragraph") == 0);
    unsigned rich_count = prefix == 3 || prefix == 4 ? n : 0;
    assert(ts_node_named_child_count(paragraph) == rich_count + (tail == 6 || tail == 7 ? 1 : 0));
    if (rich_count) for (unsigned j = 0; j < n; ++j) {
      assert(strcmp(ts_node_type(ts_node_named_child(paragraph, j)),
                    prefix == 3 ? "verbatim" : "backslash_escape") == 0);
    }
    if (tail == 6) assert(strcmp(ts_node_type(ts_node_named_child(paragraph, 0)), "verbatim") == 0);
    if (tail == 7) assert(strcmp(ts_node_type(ts_node_named_child(paragraph, 0)), "ellipsis") == 0);
    printf("prefix=%u tail=%u n=%u bytes=%u scanner=%llu lexer=%llu\n", prefix, tail, n, bytes, carve_scanner_advances, carve_lexer_advances);
    if (!baseline) {
      assert(carve_scanner_advances <= 32ULL * bytes);
      if (prefix == 0) assert(carve_lexer_advances <= 64ULL * bytes);
      else assert(carve_lexer_advances <= 256ULL * n * n + 64ULL * bytes);
    }
    ts_tree_delete(tree);
    free(source);
  }
  ts_parser_delete(parser);
}
