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
  const unsigned sizes[] = {64, 256, 1024, 4096, 16384, 32768};
  const char *fragments[] = {"[[a. ", "[[a,b ", "[[a; ", "[[a? ", "[[a.\tb ", "[[ž. "};
  const char *tails[] = {"z", "z\n", "z\r\n", "z\r", "z\n\nnext\n", "z\r\n\r\nnext\r\n", "z\r\rnext\r", "z\n \t\nnext\n", "z\nnext\n", "z\r\nnext\r\n", "z\rnext\r", "z\nb-c\n", "z\r\nb-c\r\n", "z\rb-c\r", "z\n> next\n"};
  bool baseline = argc > 1 && strcmp(argv[1], "baseline") == 0;
  for (unsigned family = 0; family < sizeof(fragments)/sizeof(fragments[0]); ++family)
  for (unsigned tail = 0; tail < sizeof(tails)/sizeof(tails[0]); ++tail)
  for (unsigned i = 0; i < sizeof(sizes)/sizeof(sizes[0]); ++i) {
    if (baseline && tail != 0) continue;
    unsigned n = sizes[i];
    if (baseline && n > 1024) break;
    unsigned width = strlen(fragments[family]);
    unsigned bytes = 2 + width * n + strlen(tails[tail]);
    char *source = malloc(bytes + 1);
    assert(source);
    memcpy(source, "x ", 2);
    for (unsigned j = 0; j < n; ++j) memcpy(source + 2 + width*j, fragments[family], width);
    memcpy(source + 2 + width*n, tails[tail], strlen(tails[tail]) + 1);
    carve_scanner_advances = carve_lexer_advances = 0;
    TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
    assert(tree && !ts_node_has_error(ts_tree_root_node(tree)));
    TSNode root = ts_tree_root_node(tree);
    assert(ts_node_named_child_count(root) == ((tail >= 4 && tail <= 7) || tail == 14 ? 2 : 1));
    TSNode paragraph = ts_node_named_child(root, 0);
    assert(strcmp(ts_node_type(paragraph), "paragraph") == 0);
    assert(ts_node_named_child_count(paragraph) == 0);
    if ((tail >= 4 && tail <= 7) || tail == 14) {
      TSNode next = ts_node_named_child(root, 1);
      assert(strcmp(ts_node_type(next), tail == 14 ? "block_quote" : "paragraph") == 0);
      assert(ts_node_start_byte(next) >= ts_node_end_byte(paragraph));
    }
    printf("family=%u tail=%u n=%u bytes=%u scanner=%llu lexer=%llu\n", family, tail, n, bytes, carve_scanner_advances, carve_lexer_advances);
    fflush(stdout);
    if (!baseline) {
      assert(carve_scanner_advances <= 32ULL * bytes);
      assert(carve_lexer_advances <= 64ULL * bytes);
    }
    ts_tree_delete(tree);
    free(source);
  }
  if (!baseline) for (unsigned i = 0; i < sizeof(sizes)/sizeof(sizes[0]); ++i) {
    unsigned n = sizes[i], bytes = 2*n + 6;
    char *source = malloc(bytes + 1);
    assert(source);
    memset(source, '[', n);
    memcpy(source + n, "x.\ny", 4);
    memset(source + n + 4, ']', n);
    source[2*n+4] = '\n';
    source[2*n+5] = '\n';
    source[bytes] = 0;
    carve_scanner_advances = carve_lexer_advances = 0;
    TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
    assert(tree && !ts_node_has_error(ts_tree_root_node(tree)));
    TSNode root = ts_tree_root_node(tree);
    assert(ts_node_named_child_count(root) == 1);
    assert(ts_node_named_child_count(ts_node_named_child(root, 0)) == 0);
    printf("multiline n=%u bytes=%u scanner=%llu lexer=%llu\n", n, bytes, carve_scanner_advances, carve_lexer_advances);
    fflush(stdout);
    assert(carve_scanner_advances <= 32ULL * bytes);
    assert(carve_lexer_advances <= 64ULL * bytes);
    ts_tree_delete(tree);
    free(source);
  }
  ts_parser_delete(parser);
}
