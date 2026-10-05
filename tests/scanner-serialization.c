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
  // the largest count that still fits the fixed buffer is 251, not the
  // count byte's own UINT8_MAX=255 - the buffer-size guard binds first.
  for (unsigned i = 0; i < 5; ++i) {
    Block *last = array_pop(scanner->open_blocks);
    ts_free(last);
  }
  unsigned length = tree_sitter_carve_external_scanner_serialize(scanner, buffer);
  if (length != 1022 || (uint8_t)buffer[15] != 251) {
    fprintf(stderr, "251 blocks encoded as %u bytes with count %u\n", length,
            (uint8_t)buffer[15]);
    return 1;
  }

  Scanner *restored = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(restored, buffer, length);
  if (restored->open_blocks->size != 251 || restored->open_inline->size != 0) {
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
  spans->after_literal_star = true;
  spans->missing_closers = (1 << 0) | (1 << 13);
  spans->state |= STATE_LITERAL_QUOTE_BAND;
  unsigned inline_length =
      tree_sitter_carve_external_scanner_serialize(spans, buffer);
  Scanner *spans_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(spans_back, buffer,
                                                 inline_length);
  if (spans_back->missing_closers != spans->missing_closers || !spans_back->after_literal_star || !(spans_back->state & STATE_LITERAL_QUOTE_BAND) ||
      spans_back->open_inline->size != 2) {
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

  Scanner *cut_label = tree_sitter_carve_external_scanner_create();
  push_inline_flagged(cut_label, SQUARE_BRACKET_SPAN, 0,
                      INLINE_BRACED | INLINE_EXTENSION_CUT);
  peek_inline(cut_label)->literal_closes = INLINE_CUT_CODE | 300;
  unsigned cut_label_length = tree_sitter_carve_external_scanner_serialize(cut_label, buffer);
  Scanner *cut_label_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(cut_label_back, buffer, cut_label_length);
  if (!peek_inline(cut_label_back) || square_literal_closes(peek_inline(cut_label_back)) != 300 ||
      span_verbatim_stop_marker(peek_inline(cut_label_back)) != 2) {
    fputs("extension code boundary did not survive label serialization\n", stderr);
    return 1;
  }
  peek_inline(cut_label)->literal_closes = 0;
  peek_inline(cut_label)->flags &= ~INLINE_EXTENSION_CUT;
  cut_label_length = tree_sitter_carve_external_scanner_serialize(cut_label, buffer);
  tree_sitter_carve_external_scanner_deserialize(cut_label_back, buffer, cut_label_length);
  if (!peek_inline(cut_label_back) || peek_inline(cut_label_back)->flags != INLINE_BRACED ||
      peek_inline(cut_label_back)->literal_closes || span_verbatim_stop_marker(peek_inline(cut_label_back))) {
    fputs("cleared extension label state did not survive serialization\n", stderr);
    return 1;
  }
  tree_sitter_carve_external_scanner_destroy(cut_label_back);
  tree_sitter_carve_external_scanner_destroy(cut_label);

  const uint32_t cuts[] = {254, 255, 256, 16384, UINT32_MAX};
  for (unsigned i = 0; i < sizeof(cuts) / sizeof(cuts[0]); ++i) {
    Scanner *cut = tree_sitter_carve_external_scanner_create();
    push_inline_flagged(cut, STRONG, 0, 0);
    peek_inline(cut)->literal_closes = cuts[i];
    unsigned cut_length = tree_sitter_carve_external_scanner_serialize(cut, buffer);
    Scanner *cut_back = tree_sitter_carve_external_scanner_create();
    tree_sitter_carve_external_scanner_deserialize(cut_back, buffer, cut_length);
    if (!peek_inline(cut_back) || peek_inline(cut_back)->literal_closes != cuts[i]) {
      fputs("extension residual depth did not survive serialization\n", stderr);
      return 1;
    }
    tree_sitter_carve_external_scanner_destroy(cut_back);
    for (unsigned j = 0; j < 250; ++j) push_block(cut, DIV, 0);
    if (cuts[i] >= UINT8_MAX) {
      memset(buffer, 0x5a, sizeof(buffer));
      if (tree_sitter_carve_external_scanner_serialize(cut, buffer) != 0) {
        fputs("wide extension state exceeded the fixed buffer\n", stderr);
        return 1;
      }
      for (unsigned j = 0; j < sizeof(buffer); ++j) if ((unsigned char)buffer[j] != 0x5a) {
        fputs("refused extension state wrote a partial serialization\n", stderr);
        return 1;
      }
    }
    tree_sitter_carve_external_scanner_destroy(cut);
  }

  Scanner *row_state = tree_sitter_carve_external_scanner_create();
  push_block(row_state, TABLE_ROW, 0);
  peek_block(row_state)->cell_boundary_col = 0x12345678;
  peek_block(row_state)->cell_carry_ticks = 257;
  peek_block(row_state)->bracket_cell_col = 0x23456789;
  peek_block(row_state)->flags = BLOCK_FLAG_TABLE_ROW_BOUNDARY_SAFE;
  unsigned row_length = tree_sitter_carve_external_scanner_serialize(row_state, buffer);
  Scanner *row_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(row_back, buffer, row_length);
  Block *restored_row = peek_block(row_back);
  if (!restored_row || restored_row->type != TABLE_ROW || row_length != 34 ||
      restored_row->cell_boundary_col != 0x12345678 || restored_row->cell_carry_ticks != 257 ||
      restored_row->bracket_cell_col != 0x23456789 ||
      restored_row->flags != BLOCK_FLAG_TABLE_ROW_BOUNDARY_SAFE) {
    fputs("raw cell boundary did not survive serialization\n", stderr);
    return 1;
  }
  tree_sitter_carve_external_scanner_destroy(row_back);
  tree_sitter_carve_external_scanner_destroy(row_state);

  Scanner *label_state = tree_sitter_carve_external_scanner_create();
  push_inline_flagged(label_state, SQUARE_BRACKET_SPAN, 0, INLINE_LABEL);
  peek_inline(label_state)->literal_closes = 0x12345678;
  unsigned label_length = tree_sitter_carve_external_scanner_serialize(label_state, buffer);
  Scanner *label_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(label_back, buffer, label_length);
  Inline *restored_label = peek_inline(label_back);
  if (!restored_label || restored_label->flags != INLINE_LABEL ||
      restored_label->literal_closes != 0x12345678 || label_length != 24) {
    fputs("wide label bracket depth did not survive serialization\n", stderr);
    return 1;
  }
  tree_sitter_carve_external_scanner_destroy(label_back);
  tree_sitter_carve_external_scanner_destroy(label_state);

  Scanner *literal_state = tree_sitter_carve_external_scanner_create();
  push_inline_flagged(literal_state, LITERAL_BRACKET, 0, 0);
  peek_inline(literal_state)->literal_closes = 16384;
  unsigned literal_length = tree_sitter_carve_external_scanner_serialize(literal_state, buffer);
  Scanner *literal_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(literal_back, buffer, literal_length);
  if (peek_inline(literal_back)->literal_closes != 16384 || literal_length != 24) {
    fputs("literal bracket depth did not survive serialization\n", stderr);
    return 1;
  }
  tree_sitter_carve_external_scanner_destroy(literal_back);
  tree_sitter_carve_external_scanner_destroy(literal_state);

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

  Scanner *term = tree_sitter_carve_external_scanner_create();
  Block *definition = create_block(LIST_DEFINITION, 3);
  definition->flags = BLOCK_FLAG_DEFINITION_TERM;
  definition->content_col = 5;
  stack_push(term->open_blocks, definition);
  unsigned term_length = tree_sitter_carve_external_scanner_serialize(term, buffer);
  Scanner *term_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(term_back, buffer, term_length);
  Block *restored_term = *array_get(term_back->open_blocks, 0);
  if (restored_term->type != LIST_DEFINITION || restored_term->data != 3 ||
      restored_term->content_col != 5 ||
      restored_term->flags != BLOCK_FLAG_DEFINITION_TERM) {
    fputs("definition term state did not survive serialization\n", stderr);
    return 1;
  }
  tree_sitter_carve_external_scanner_destroy(term_back);
  tree_sitter_carve_external_scanner_destroy(term);

  const BlockType boundary_types[] = {BLOCK_QUOTE, LIST_DASH, CODE_BLOCK};
  const uint8_t boundary_flags[] = {
      BLOCK_FLAG_QUOTE_CONTINUATION_PENDING | BLOCK_FLAG_OPAQUE_QUOTE_TAIL,
      BLOCK_FLAG_COMMENT_RESTORES_LAZY,
      BLOCK_FLAG_DESCRIPTION_FENCE_HAS_CLOSER | BLOCK_FLAG_LATER_OPAQUE_FENCE,
  };
  Scanner *boundaries = tree_sitter_carve_external_scanner_create();
  for (unsigned i = 0; i < 3; ++i) {
    Block *block = create_block(boundary_types[i], 3);
    block->flags = boundary_flags[i];
    stack_push(boundaries->open_blocks, block);
  }
  unsigned boundary_length = tree_sitter_carve_external_scanner_serialize(boundaries, buffer);
  Scanner *boundaries_back = tree_sitter_carve_external_scanner_create();
  tree_sitter_carve_external_scanner_deserialize(boundaries_back, buffer, boundary_length);
  for (unsigned i = 0; i < 3; ++i) {
    Block *block = *array_get(boundaries_back->open_blocks, i);
    if (block->type != boundary_types[i] || block->flags != boundary_flags[i]) {
      fputs("block boundary flags did not survive serialization\n", stderr);
      return 1;
    }
  }
  tree_sitter_carve_external_scanner_destroy(boundaries_back);
  tree_sitter_carve_external_scanner_destroy(boundaries);

  tree_sitter_carve_external_scanner_destroy(restored);
  tree_sitter_carve_external_scanner_destroy(scanner);
  puts("scanner serialization: 251 blocks round-trip, an inline entry and a "
       "block's own flags keep them, and 256 blocks are refused cleanly.");
  return 0;
}
