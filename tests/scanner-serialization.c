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

  // A block now serializes as 4 bytes (type, data, content_col, flags), so
  // the largest count that still fits the fixed buffer is 252, not the
  // count byte's own UINT8_MAX=255 - the buffer-size guard binds first.
  for (unsigned i = 0; i < 4; ++i) {
    Block *last = array_pop(scanner->open_blocks);
    ts_free(last);
  }
  unsigned length = tree_sitter_carve_external_scanner_serialize(scanner, buffer);
  if (length != 1024 || (uint8_t)buffer[15] != 252) {
    fprintf(stderr, "252 blocks encoded as %u bytes with count %u\n", length,
            (uint8_t)buffer[15]);
    return 1;
  }

  Scanner *restored = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(restored, buffer, length);
  if (restored->open_blocks->size != 252 || restored->open_inline->size != 0) {
    fprintf(stderr, "restored %u blocks and %u inline entries\n",
            restored->open_blocks->size, restored->open_inline->size);
    return 1;
  }

  // An inline entry packs its flags into the type byte's spare bits, so a
  // round trip has to bring back the flags as well as the type and the data.
  // Nothing else here reads the inline half of the wire format.
  Scanner *spans = tree_sitter_carve_external_scanner_create();
  push_inline_flagged(spans, STRONG, 0, INLINE_BRACED);
  push_inline_flagged(spans, VERBATIM, 2, INLINE_STOPS_AT_SPAN_CLOSER);
  unsigned inline_length =
      tree_sitter_carve_external_scanner_serialize(spans, buffer);
  Scanner *spans_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(spans_back, buffer,
                                                 inline_length);
  if (spans_back->open_inline->size != 2) {
    fprintf(stderr, "restored %u inline entries, wanted 2\n",
            spans_back->open_inline->size);
    return 1;
  }
  Inline *outer = *array_get(spans_back->open_inline, 0);
  Inline *inner = *array_get(spans_back->open_inline, 1);
  if (outer->type != STRONG || outer->flags != INLINE_BRACED ||
      inner->type != VERBATIM || inner->data != 2 ||
      inner->flags != INLINE_STOPS_AT_SPAN_CLOSER) {
    fprintf(stderr,
            "restored (%d,%u,%u) over (%d,%u,%u)\n", (int)inner->type,
            inner->data, inner->flags, (int)outer->type, outer->data,
            outer->flags);
    return 1;
  }
  tree_sitter_carve_external_scanner_destroy(spans_back);
  tree_sitter_carve_external_scanner_destroy(spans);

  // A block's own flags (BLOCK_FLAG_LINE_BLOCK) round-trip the same way.
  Scanner *div = tree_sitter_carve_external_scanner_create();
  Block *line_block = create_block(DIV, 3);
  line_block->flags = BLOCK_FLAG_LINE_BLOCK;
  stack_push(div->open_blocks, line_block);
  unsigned div_length = tree_sitter_carve_external_scanner_serialize(div, buffer);
  Scanner *div_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(div_back, buffer, div_length);
  Block *restored_div = *array_get(div_back->open_blocks, 0);
  if (div_back->open_blocks->size != 1 ||
      restored_div->flags != BLOCK_FLAG_LINE_BLOCK) {
    fprintf(stderr, "restored %u blocks with flags %u, wanted 1 with %u\n",
            div_back->open_blocks->size, restored_div->flags,
            BLOCK_FLAG_LINE_BLOCK);
    return 1;
  }
  tree_sitter_carve_external_scanner_destroy(div_back);
  tree_sitter_carve_external_scanner_destroy(div);

  tree_sitter_carve_external_scanner_destroy(restored);
  tree_sitter_carve_external_scanner_destroy(scanner);
  puts("scanner serialization: 252 blocks round-trip, an inline entry and a "
       "block's own flags keep them, and 256 blocks are refused cleanly.");
  return 0;
}
