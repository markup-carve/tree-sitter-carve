#include <stdio.h>
#include <stdlib.h>

#include "tree_sitter/api.h"

const TSLanguage *tree_sitter_carve(void);

static char *read_file(const char *path, uint32_t *length) {
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) return NULL;
  long size = ftell(file);
  if (size < 0 || fseek(file, 0, SEEK_SET) != 0) return NULL;
  char *source = malloc((size_t)size + 1);
  if (!source) return NULL;
  if (fread(source, 1, (size_t)size, file) != (size_t)size) {
    free(source);
    return NULL;
  }
  fclose(file);
  source[size] = '\0';
  *length = (uint32_t)size;
  return source;
}

int main(int argc, char **argv) {
  TSParser *parser = ts_parser_new();
  if (!parser || !ts_parser_set_language(parser, tree_sitter_carve())) return 2;
  for (int i = 1; i < argc; ++i) {
    uint32_t length = 0;
    char *source = read_file(argv[i], &length);
    if (!source) {
      fprintf(stderr, "cannot read %s\n", argv[i]);
      return 2;
    }
    TSTree *tree = ts_parser_parse_string(parser, NULL, source, length);
    if (!tree) return 2;
    ts_tree_delete(tree);
    free(source);
    ts_parser_reset(parser);
  }
  ts_parser_delete(parser);
  printf("asan: parsed %d document(s)\n", argc - 1);
  return 0;
}
