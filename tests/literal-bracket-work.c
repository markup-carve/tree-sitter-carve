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
  const char *bodies[] = {"x", "*x*", "/x/", "x", "x](u)", "x\ny", "^1", "@k"};
  const char *types[] = {NULL, "strong", "emphasis", NULL, "inline_link", NULL, "footnote_reference", "citation_group"};
  const char *names[] = {"plain", "strong", "emphasis", "spaced", "inner-link", "multiline", "footnote", "citation"};
  for (unsigned body = 0; body < 8; ++body) for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    unsigned n = sizes[i];
    if (baseline && n > 1024) break;
    unsigned body_bytes = strlen(bodies[body]);
    unsigned width = body == 3 ? 2 : 1;
    unsigned closes = n - (body == 4 ? 1 : 0);
    unsigned bytes = width * (n + closes) + body_bytes + 1;
    char *source = malloc(bytes + 1);
    assert(source);
    unsigned offset = 0;
    for (unsigned j = 0; j < n; ++j) {
      source[offset++] = '[';
      if (width == 2) source[offset++] = ' ';
    }
    memcpy(source + offset, bodies[body], body_bytes);
    offset += body_bytes;
    for (unsigned j = 0; j < closes; ++j) {
      if (width == 2) source[offset++] = ' ';
      source[offset++] = ']';
    }
    source[offset++] = '\n';
    assert(offset == bytes);
    source[offset] = 0;
    carve_scanner_advances = 0;
    TSTree *tree = ts_parser_parse_string(parser, NULL, source, bytes);
    assert(tree);
    TSNode root = ts_tree_root_node(tree);
    assert(!ts_node_has_error(root));
    assert(ts_node_named_child_count(root) == 1);
    TSNode paragraph = ts_node_named_child(root, 0);
    assert(strcmp(ts_node_type(paragraph), "paragraph") == 0);
    assert(ts_node_named_child_count(paragraph) == (types[body] ? 1 : 0));
    if (types[body]) assert(strcmp(ts_node_type(ts_node_named_child(paragraph, 0)), types[body]) == 0);
    printf("%s %u %u %llu\n", names[body], n, bytes, carve_scanner_advances);
    fflush(stdout);
    if (!baseline) assert(carve_scanner_advances <= 32ULL * bytes);
    ts_tree_delete(tree);
    free(source);
  }
  ts_parser_delete(parser);
}
