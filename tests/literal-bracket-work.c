#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <tree_sitter/api.h>

extern const TSLanguage *tree_sitter_carve(void);
extern unsigned long long carve_scanner_advances;

int main(int argc, char **argv) {
  TSParser *parser = ts_parser_new();
  assert(ts_parser_set_language(parser, tree_sitter_carve()));
  const unsigned sizes[] = {64, 256, 1024, 4096, 16384};
  bool baseline = argc > 1 && strcmp(argv[1], "baseline") == 0;
  const char *bodies[] = {"x", "*x*", "/x/"};
  for (unsigned body = 0; body < 3; ++body) for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    unsigned n = sizes[i];
    if (baseline && n > 1024) break;
    unsigned body_bytes = strlen(bodies[body]);
    unsigned bytes = 2 * n + body_bytes + 1;
    char *source = malloc(bytes + 1);
    assert(source);
    memset(source, '[', n);
    memcpy(source + n, bodies[body], body_bytes);
    memset(source + n + body_bytes, ']', n);
    source[bytes - 1] = '\n';
    source[bytes] = 0;
    carve_scanner_advances = 0;
    TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
    assert(tree);
    TSNode root = ts_tree_root_node(tree);
    assert(!ts_node_has_error(root));
    assert(ts_node_named_child_count(root) == 1);
    TSNode paragraph = ts_node_named_child(root, 0);
    assert(strcmp(ts_node_type(paragraph), "paragraph") == 0);
    assert(ts_node_named_child_count(paragraph) == (body == 0 ? 0 : 1));
    if (body) assert(strcmp(ts_node_type(ts_node_named_child(paragraph, 0)), body == 1 ? "strong" : "emphasis") == 0);
    printf("%s %u %u %llu\n", bodies[body], n, bytes, carve_scanner_advances);
    if (!baseline) assert(carve_scanner_advances <= 32ULL * bytes);
    ts_tree_delete(tree);
    free(source);
  }
  ts_parser_delete(parser);
}
