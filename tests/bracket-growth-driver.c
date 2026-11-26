// Parse time of long `[` runs grows linearly (#770): each shape at 16k
// characters may cost at most RATIO_LIMIT times its 4k time. A quadratic
// path costs about 16x. One parser is reused, as an editor does, and each
// size keeps its fastest of ROUNDS parses so a busy runner does not fail it.
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "tree_sitter/api.h"

const TSLanguage *tree_sitter_carve(void);

// The work is exactly linear; the wall time of a 4x larger tree runs a few
// percent over 4x from memory effects alone.
#define RATIO_LIMIT 4.5
#define ROUNDS 7
#define SMALL 4000
#define LARGE 16000

typedef struct {
  const char *name;
  const char *head, *unit, *tail;
} Shape;

static const Shape SHAPES[] = {
    {"[ run", "", "[", "\n"},
    {"[ run, then a] (x) (CC-1477)", "", "[", "a] (x)\n"},
    {"[! run (CC-1489)", "", "[!", "\n"},
    {"[[[x](u) repeated", "", "[[[x](u)", "\n"},
    {"[ run in a cell", "| a | ", "[", " |\n"},
    {"[ run in a cell, then a] (x)", "| a | ", "[", "a] (x) |\n"},
    {"[! run in a cell", "| a | ", "[!", " |\n"},
    {"refused ^[ [b] notes", "", "^[ [b] x ", "\n"},
    {"refused ^[ [^[b]] notes", "", "^[ [^[b]] x ", "\n"},
    {"refused ^[ notes, one per line", "", "^[ b x\n", "\n"},
    {"[b] in a block quote (#790)", "> ", "[b] ", "\n"},
    {"refused notes in a block quote (#790)", "> ", "^[ [^b] ] ", "\n"},
    {"braced comments in a list item (#790)", "1. ", "{%c%}. ", "\n"},
    {"refused notes, one per quoted line", "", "> ^[ [ b ]\n", "\n"},
    {"refused notes holding a braced comment (#791)", "", "^[ {%c%} x ", "\n"},
    {"refused glued ^[^ notes (#791)", "", "^[^[b] x ", "\n"},
    {"escaped caret before [^] (#791)", "", "\\^[ [^] ", "\n"},
    {"refused notes, one per list item (#793)", "", "- \\^[ [ b ]\n", "\n"},
    {"open labels, one per list item (#793)", "", "- ^[ [^[b\n", "\n"},
    {"refused notes in a list item (#793)", "- ", "^[ [^[b]] x ", "\n"},
    {"refused notes in a heading (#795)", "# ", "^[ [b] x ", "\n"},
    {"refused notes, one per table row (#795)", "", "| ^[ [b] x |\n", "\n"},
    {"escaped caret before [^], one per item (#793)", "", "1. \\^[ [^]\n", "\n"},
};

static char *build(const Shape *shape, size_t chars, uint32_t *length) {
  size_t head = strlen(shape->head), unit = strlen(shape->unit), tail = strlen(shape->tail);
  size_t units = chars / unit;
  char *source = malloc(head + units * unit + tail + 1);
  if (!source) exit(2);
  char *at = source;
  memcpy(at, shape->head, head);
  at += head;
  for (size_t i = 0; i < units; ++i, at += unit) memcpy(at, shape->unit, unit);
  memcpy(at, shape->tail, tail);
  at += tail;
  *at = '\0';
  *length = (uint32_t)(at - source);
  return source;
}

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static double parse_ms(TSParser *parser, const char *source, uint32_t length) {
  double start = now_ms();
  TSTree *tree = ts_parser_parse_string(parser, NULL, source, length);
  double elapsed = now_ms() - start;
  if (!tree) exit(2);
  ts_tree_delete(tree);
  ts_parser_reset(parser);
  return elapsed;
}

int main(void) {
  TSParser *parser = ts_parser_new();
  if (!parser || !ts_parser_set_language(parser, tree_sitter_carve())) return 2;
  int failed = 0;
  for (size_t i = 0; i < sizeof(SHAPES) / sizeof(SHAPES[0]); ++i) {
    uint32_t small_length, large_length;
    char *small = build(&SHAPES[i], SMALL, &small_length);
    char *large = build(&SHAPES[i], LARGE, &large_length);
    double small_ms = 1e18, large_ms = 1e18;
    // Interleaved, so a load spike hits both sizes alike.
    for (int round = 0; round < ROUNDS; ++round) {
      double s = parse_ms(parser, small, small_length);
      double l = parse_ms(parser, large, large_length);
      if (s < small_ms) small_ms = s;
      if (l < large_ms) large_ms = l;
    }
    double ratio = large_ms / small_ms;
    bool over = ratio > RATIO_LIMIT;
    printf("%s %-30s 4k %8.2f ms  16k %8.2f ms  ratio %5.2f\n", over ? "FAIL" : "ok  ",
           SHAPES[i].name, small_ms, large_ms, ratio);
    failed |= over;
    free(small);
    free(large);
  }

  // Nested links inside text brackets: a note that splits parse versions the
  // grammar merges made this hang (CC-1567).
  const char *nested = "^*[*[[*^*[*[[*^*[*[[*^*[*x](u)^]]](u)^]]](u)^]]](u)\n";
  double nested_ms = 1e18;
  for (int round = 0; round < ROUNDS; ++round) {
    double ms = parse_ms(parser, nested, (uint32_t)strlen(nested));
    if (ms < nested_ms) nested_ms = ms;
  }
  bool slow = nested_ms > 50.0;
  printf("%s %-30s %8.2f ms (limit 50 ms)\n", slow ? "FAIL" : "ok  ", "CC-1567 nested links",
         nested_ms);
  failed |= slow;

  ts_parser_delete(parser);
  return failed ? 1 : 0;
}
