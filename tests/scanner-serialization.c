#include <stdio.h>
#include <string.h>

// Include the implementation so this focused wire-format test can construct
// the otherwise-private scanner state. Production still compiles scanner.c as
// its own translation unit.
#include "../src/scanner.c"

int main(void) {
  Scanner *scanner = tree_sitter_carve_external_scanner_create();
  char buffer[TREE_SITTER_SERIALIZATION_BUFFER_SIZE];
  memset(buffer, 0x5a, sizeof(buffer));

  for (unsigned i = 0; i < 256; ++i) {
    stack_push(scanner->open_blocks, create_block(DIV, (uint8_t)i));
  }

  if (tree_sitter_carve_external_scanner_serialize(scanner, buffer) != 0) {
    fputs("a 256-block state must be refused\n", stderr);
    return 1;
  }
  for (size_t i = 0; i < sizeof(buffer); ++i) {
    if ((unsigned char)buffer[i] != 0x5a) {
      fputs("a refused state wrote a partial serialization\n", stderr);
      return 1;
    }
  }

  Block *last = array_pop(scanner->open_blocks);
  ts_free(last);
  unsigned length = tree_sitter_carve_external_scanner_serialize(scanner, buffer);
  if (length != 776 || (uint8_t)buffer[10] != 255) {
    fprintf(stderr, "255 blocks encoded as %u bytes with count %u\n", length,
            (uint8_t)buffer[10]);
    return 1;
  }

  Scanner *restored = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(restored, buffer, length);
  if (restored->open_blocks->size != 255 || restored->open_inline->size != 0) {
    fprintf(stderr, "restored %u blocks and %u inline entries\n",
            restored->open_blocks->size, restored->open_inline->size);
    return 1;
  }

  tree_sitter_carve_external_scanner_destroy(restored);
  tree_sitter_carve_external_scanner_destroy(scanner);
  puts("scanner serialization: 255 blocks round-trip; 256 is refused cleanly.");
  return 0;
}
