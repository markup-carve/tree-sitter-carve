const ELEMENT_PRECEDENCE = 100;

module.exports = grammar({
  name: "carve",

  // A carriage return stays an EXTRA. It reads like the other half of the
  // "carriage returns should simply be ignored" model `advance` used to carry,
  // and dropping it was tried: it costs 45 SECONDS on
  // `248-an-attribute-name-admits-no-colon-3`, a document whose ERROR is
  // recorded and pre-existing, because error recovery then has nothing it may
  // skip. That is reproducible with main's own scanner and an empty list, so it
  // is the extras entry alone and not the scanner (#143). The external scanner
  // sees the terminators it needs to: every regex here stops at a '\r' now, and
  // an extra is only ever taken where no token can start.
  extras: (_) => ["\r"],

  conflicts: ($) => [
    [$.bold_italic_begin, $._symbol_fallback],
    [$.emphasis_begin, $._symbol_fallback],
    [$.strong_begin, $._symbol_fallback],
    [$.underline_begin, $._symbol_fallback],
    [$.strikethrough_begin, $._symbol_fallback],
    [$.superscript_begin, $._symbol_fallback],
    [$.subscript_begin, $._symbol_fallback],
    [$.highlighted_begin, $._symbol_fallback],
    [$.insert_begin, $._symbol_fallback],
    [$.delete_begin, $._symbol_fallback],
    [$._bracketed_text_begin, $._symbol_fallback],
    [$._image_description_begin, $._symbol_fallback],
    [$.footnote_marker_begin, $._symbol_fallback],
    [$.inline_math, $._symbol_fallback],
    [$.block_math, $.inline_math, $._symbol_fallback],
    [$.inline_literal, $._symbol_fallback],
    [$.link_text, $._symbol_fallback],
    [$._curly_bracket_span_begin, $._curly_bracket_span_fallback],
  ],

  rules: {
    document: ($) =>
      seq(optional($.frontmatter), repeat($._block_with_section)),

    frontmatter: ($) =>
      seq(
        $.frontmatter_marker,
        $._whitespace,
        optional(field("language", $.language)),
        $._newline,
        field("content", $.frontmatter_content),
        $.frontmatter_marker,
        $._newline,
      ),
    frontmatter_content: ($) => repeat1($._line),

    // A section is only valid on the top level, or nested inside other sections.
    // Otherwise standalone headings are used (inside divs for example).
    //
    // `abbreviation_definition` is added here, and NOT in `_block_element`,
    // because it is recognized only at document level (PART 5, NORMATIVE):
    // written inside a block quote, a list item or a div, `*[TERM]: expansion`
    // is not a definition at all, just paragraph text (corpus 179/180/181).
    // A reference/footnote/citation definition is different - those ARE
    // recognized inside a container and hoisted to the document - so they stay
    // in `_block_element`, reachable from every container path. Document level
    // is reached only through this rule (`document` and `section`), never
    // through `_block_with_heading` (list items, divs, footnotes) or a block
    // quote's own content rule, so this single choice point is what keeps an
    // abbreviation definition out of every container in one place.
    _block_with_section: ($) =>
      choice(
        $.section,
        $._block_element,
        $.abbreviation_definition,
        $._newline,
      ),
    _block_with_heading: ($) =>
      seq(
        optional($._block_quote_continuation),
        choice($.heading, $._block_element, $._newline),
      ),
    _block_element: ($) =>
      choice(
        $.list,
        $.definition_list,
        $.table,
        $.footnote,
        $.div,
        $.raw_block,
        $.code_block,
        $.thematic_break,
        $.block_quote,
        alias($.block_math, $.math),
        $.citation_definition,
        $.link_reference_definition,
        $.comment_line,
        $.fenced_comment_block,
        $.caption,
        $.block_attribute,
        $.callout_list,
        $._paragraph,
      ),

    // A heading ends at its newline and nothing folds into it (SINGLE-LINE
    // HEADINGS, carve#451): every following line, `#`-marked or not, begins
    // whatever block it begins. A marker with MORE `#` nests a new section, one
    // with the same or FEWER closes the open section(s) and opens a sibling.
    // (See carve grammar PART 2 and corpus 82-single-line-headings.)
    section: ($) =>
      seq(
        field("heading", $.heading),
        field(
          "content",
          alias(repeat($._block_with_section), $.section_content),
        ),
        $._block_close,
      ),

    // The external scanner allows for an arbitrary number of `#`. The heading
    // is one line: `_block_close` arrives at the newline.
    heading: ($) =>
      seq(
        field("marker", alias($._heading_begin, $.marker)),
        field("content", alias($._heading_content, $.content)),
        $._block_close,
        optional($._eof_or_newline),
      ),
    _heading_content: ($) => $._inline_line,

    // Carve has a crazy number of different list types
    // that we need to keep separate from each other.
    list: ($) =>
      prec.left(
        choice(
          $._list_dash,
          $._list_star,
          $._list_task,
          $._list_decimal_period,
          $._list_decimal_paren,
          $._list_decimal_parens,
          $._list_lower_alpha_period,
          $._list_lower_alpha_paren,
          $._list_lower_alpha_parens,
          $._list_upper_alpha_period,
          $._list_upper_alpha_paren,
          $._list_upper_alpha_parens,
          $._list_lower_roman_period,
          $._list_lower_roman_paren,
          $._list_lower_roman_parens,
          $._list_upper_roman_period,
          $._list_upper_roman_paren,
          $._list_upper_roman_parens,
        ),
      ),
    _list_dash: ($) =>
      seq(repeat1(alias($._list_item_dash, $.list_item)), $._block_close),
    _list_item_dash: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_dash),
        field("content", $.list_item_content),
      ),

    _list_star: ($) =>
      seq(repeat1(alias($._list_item_star, $.list_item)), $._block_close),
    _list_item_star: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_star),
        field("content", $.list_item_content),
      ),

    _list_task: ($) =>
      seq(repeat1(alias($._list_item_task, $.list_item)), $._block_close),
    _list_item_task: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_task),
        field("content", $.list_item_content),
      ),
    list_marker_task: ($) =>
      seq(
        $._list_marker_task_begin,
        // The scanner commits `<bullet> ` and leaves any FURTHER spaces before
        // the checkbox to the grammar. `-   [ ] a` is a task item in every
        // engine, and requiring the checkbox to sit against the marker put an
        // ERROR inside this node (corpus 75-list-nesting-and-looseness-9).
        optional($._whitespace1),
        field("checkmark", choice($.checked, $.unchecked)),
        $._whitespace1,
      ),
    checked: (_) => seq("[", choice("x", "X"), "]"),
    // Unchecked task states per the spec's task_state rule: ` `, `_`, `-`,
    // `>`, `?` all render as an UNCHECKED checkbox (matches djot-php). The
    // grammar emits a single `unchecked` node for every form; the state
    // character stays recoverable from the node text for consumers that
    // want to distinguish them.
    unchecked: (_) => seq("[", choice(" ", "_", "-", ">", "?"), "]"),

    // A definition list is its own node, not a `list`: it renders `<dl>` and
    // its items are `<dt>`/`<dd>`, so a consumer that highlights or folds lists
    // wants to tell them apart. It holds TERMS (`:: t`) and DESCRIPTIONS
    // (`:  d`) as sibling items, because the language lets either stand alone:
    // a term with no description is a `<dl>` holding one `<dt>`, and a run of
    // terms shares the description that follows them (corpus
    // 25-definition-lists).
    definition_list: ($) =>
      seq(
        repeat1(
          alias(
            choice($._list_item_definition, $._list_item_description),
            $.list_item,
          ),
        ),
        $._block_close,
      ),
    _list_item_description: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_description),
        field("definition", alias($._paragraph_content, $.definition)),
        choice($._eof_or_newline, $._close_paragraph),
        // A description holds BLOCKS, not just the line it starts on: corpus
        // 25-definition-lists-2 continues one into a second paragraph, and a
        // `+` marker attaches a FLUSH-LEFT block the same way it does for a
        // bullet item (PART 9 §17), which is the second branch here.
        optional(
          repeat(
            choice(
              seq(
                optional($._block_quote_prefix),
                $._list_item_continuation,
                $._block_with_heading,
              ),
              $._list_continuation,
            ),
          ),
        ),
        $._list_item_end,
      ),
    _list_item_definition: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_definition),
        field("term", alias($._paragraph_content, $.term)),
        choice($._eof_or_newline, $._close_paragraph),
        field(
          "definition",
          alias(
            optional(
              repeat(
                seq(
                  optional($._block_quote_prefix),
                  $._list_item_continuation,
                  $._block_with_heading,
                ),
              ),
            ),
            $.definition,
          ),
        ),
        $._list_item_end,
      ),

    _list_decimal_period: ($) =>
      seq(
        repeat1(alias($._list_item_decimal_period, $.list_item)),
        $._block_close,
      ),
    _list_item_decimal_period: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_decimal_period),
        field("content", $.list_item_content),
      ),
    _list_decimal_paren: ($) =>
      seq(
        repeat1(alias($._list_item_decimal_paren, $.list_item)),
        $._block_close,
      ),
    _list_item_decimal_paren: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_decimal_paren),
        field("content", $.list_item_content),
      ),
    _list_decimal_parens: ($) =>
      seq(
        repeat1(alias($._list_item_decimal_parens, $.list_item)),
        $._block_close,
      ),
    _list_item_decimal_parens: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_decimal_parens),
        field("content", $.list_item_content),
      ),

    _list_lower_alpha_period: ($) =>
      seq(
        repeat1(alias($._list_item_lower_alpha_period, $.list_item)),
        $._block_close,
      ),
    _list_item_lower_alpha_period: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_lower_alpha_period),
        field("content", $.list_item_content),
      ),
    _list_lower_alpha_paren: ($) =>
      seq(
        repeat1(alias($._list_item_lower_alpha_paren, $.list_item)),
        $._block_close,
      ),
    _list_item_lower_alpha_paren: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_lower_alpha_paren),
        field("content", $.list_item_content),
      ),
    _list_lower_alpha_parens: ($) =>
      seq(
        repeat1(alias($._list_item_lower_alpha_parens, $.list_item)),
        $._block_close,
      ),
    _list_item_lower_alpha_parens: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_lower_alpha_parens),
        field("content", $.list_item_content),
      ),

    _list_upper_alpha_period: ($) =>
      seq(
        repeat1(alias($._list_item_upper_alpha_period, $.list_item)),
        $._block_close,
      ),
    _list_item_upper_alpha_period: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_upper_alpha_period),
        field("content", $.list_item_content),
      ),
    _list_upper_alpha_paren: ($) =>
      seq(
        repeat1(alias($._list_item_upper_alpha_paren, $.list_item)),
        $._block_close,
      ),
    _list_item_upper_alpha_paren: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_upper_alpha_paren),
        field("content", $.list_item_content),
      ),
    _list_upper_alpha_parens: ($) =>
      seq(
        repeat1(alias($._list_item_upper_alpha_parens, $.list_item)),
        $._block_close,
      ),
    _list_item_upper_alpha_parens: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_upper_alpha_parens),
        field("content", $.list_item_content),
      ),

    _list_lower_roman_period: ($) =>
      seq(
        repeat1(alias($._list_item_lower_roman_period, $.list_item)),
        $._block_close,
      ),
    _list_item_lower_roman_period: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_lower_roman_period),
        field("content", $.list_item_content),
      ),
    _list_lower_roman_paren: ($) =>
      seq(
        repeat1(alias($._list_item_lower_roman_paren, $.list_item)),
        $._block_close,
      ),
    _list_item_lower_roman_paren: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_lower_roman_paren),
        field("content", $.list_item_content),
      ),
    _list_lower_roman_parens: ($) =>
      seq(
        repeat1(alias($._list_item_lower_roman_parens, $.list_item)),
        $._block_close,
      ),
    _list_item_lower_roman_parens: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_lower_roman_parens),
        field("content", $.list_item_content),
      ),

    _list_upper_roman_period: ($) =>
      seq(
        repeat1(alias($._list_item_upper_roman_period, $.list_item)),
        $._block_close,
      ),
    _list_item_upper_roman_period: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_upper_roman_period),
        field("content", $.list_item_content),
      ),
    _list_upper_roman_paren: ($) =>
      seq(
        repeat1(alias($._list_item_upper_roman_paren, $.list_item)),
        $._block_close,
      ),
    _list_item_upper_roman_paren: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_upper_roman_paren),
        field("content", $.list_item_content),
      ),
    _list_upper_roman_parens: ($) =>
      seq(
        repeat1(alias($._list_item_upper_roman_parens, $.list_item)),
        $._block_close,
      ),
    _list_item_upper_roman_parens: ($) =>
      seq(
        optional($._block_quote_prefix),
        field("marker", $.list_marker_upper_roman_parens),
        field("content", $.list_item_content),
      ),

    list_item_content: ($) =>
      seq(
        choice(
          seq($._block_with_heading, $._indented_content_spacer),
          // The item may begin directly with a `+` continuation marker
          // (e.g. `- +`), giving an item whose only content is the attached
          // flush-left block (corpus 83-list-continuation-marker-3).
          $._list_continuation,
        ),
        optional(
          repeat(
            choice(
              seq(
                optional($._block_quote_prefix),
                $._list_item_continuation,
                $._block_with_heading,
                $._indented_content_spacer,
              ),
              $._list_continuation,
            ),
          ),
        ),
        $._list_item_end,
      ),
    // A `+` continuation marker (PART 9 §17) plus the single flush-left block it
    // attaches to the enclosing list item (corpus 83-list-continuation-marker).
    // No `_indented_content_spacer` here: the attached block sits flush left, and
    // a zero-width spacer would force a terminator-less block (a table) to reduce
    // after its first row.
    _list_continuation: ($) =>
      seq($.list_continuation_marker, $._block_with_heading),

    table: ($) =>
      prec.right(
        seq(
          repeat1($._table_row),
          optional($._newline),
          optional($.table_caption),
        ),
      ),
    _table_row: ($) =>
      seq(
        optional($._block_quote_prefix),
        choice($.table_header, $.table_separator, $.table_row),
      ),
    table_header: ($) =>
      seq(
        alias($._table_header_begin, "|"),
        repeat($._table_cell),
        $._table_row_end_newline,
      ),
    table_separator: ($) =>
      seq(
        alias($._table_separator_begin, "|"),
        repeat($._table_cell_alignment),
        $._table_row_end_newline,
      ),
    table_row: ($) =>
      seq(
        alias($._table_row_begin, "|"),
        repeat($._table_cell),
        $._table_row_end_newline,
      ),
    _table_cell: ($) =>
      seq(alias($._inline, $.table_cell), alias($._table_cell_end, "|")),
    _table_cell_alignment: ($) =>
      seq(
        // Note that alignment appearance is already checked in the external
        // scanner when `_table_separator_begin` is output.
        // Therefore this regex can be simplified.
        alias(token.immediate(/[^|]+/), $.table_cell_alignment),
        alias($._table_cell_end, "|"),
      ),
    table_caption: ($) =>
      seq(
        field("marker", alias($._table_caption_begin, $.marker)),
        field("content", alias(repeat1($._inline_line), $.content)),
        choice($._table_caption_end, "\0"),
      ),

    footnote: ($) =>
      seq(
        $._footnote_mark_begin,
        $.footnote_marker_begin,
        field("label", $.reference_label),
        alias("]:", $.footnote_marker_end),
        $._whitespace1,
        field("content", $.footnote_content),
      ),
    footnote_content: ($) =>
      seq(
        $._block_with_heading,
        $._indented_content_spacer,
        optional(
          repeat(
            seq(
              optional($._block_quote_prefix),
              $._footnote_continuation,
              $._block_with_heading,
              $._indented_content_spacer,
            ),
          ),
        ),
        $._footnote_end,
      ),

    div: ($) =>
      seq(
        $._div_marker_begin,
        $._newline,
        field("content", alias(repeat($._block_with_heading), $.content)),
        optional($._block_quote_prefix),
        $._block_close,
        optional(seq(alias($._div_end, $.div_marker_end), $._newline)),
      ),
    _div_marker_begin: ($) =>
      seq(
        alias($._div_begin, $.div_marker_begin),
        optional(
          choice(
            // THE FENCE-ADJACENT SEPARATOR IS NOT SPELLED HERE. The external
            // scanner owns it: `_div_begin` marks its token end PAST the
            // separator, so by the time any of these branches is reached the
            // whitespace is already inside `div_marker_begin` and a slot here
            // could never match. It used to be spelled `optional($._whitespace1)`
            // in all three branches; deleting it moved nothing across the tree-
            // sitter corpus, the block battery, 668 conformance documents, the
            // 2700-document no-error sweep or under-acceptance.
            //
            // It is deleted rather than narrowed because it also MISDESCRIBED
            // the rule. That slot is a MARKER SEPARATOR (grammar.ebnf PART 7,
            // MARKER SEPARATORS AND PADDING SLOTS) and takes a literal `space`,
            // while `_whitespace1` is `/[ \t]+/` and admits a tab - so it read
            // as permission for exactly the parse carve#886 settled against. A
            // narrowed token would have been just as dead and no more checkable.
            // `colon_fence_tail_opens_block` in `src/scanner.c` is the one place
            // that answers, for both the opener and the paragraph-closing peek.
            //
            // Line block: `::: |` (the separator space is required before the
            // bar, and enforced there).
            seq(field("line_block_marker", alias("|", $.line_block_marker))),
            // Named div / admonition, with an optional quoted custom title and
            // an optional bracketed [label] (a grouping id; PART 9 §12).
            //
            // The class needs a SPACE after the fence. `:::note` glued is a
            // paragraph in every engine - the separator rule that governs every
            // other marker governs this one - and accepting it coloured a
            // malformed opener as a real container. A glued [label] is a
            // different case and stays valid below: `:::[First]` does open.
            //
            // The `"title"` and `[label]` slots below are the OTHER role: the
            // type word has already decided the block, so they are PADDING. The
            // ROLES differ, the terminal does not - a padding slot sits after
            // the first non-whitespace character of the line, where a tab is not
            // syntax - so all three slots are spelled `space` and only the
            // cardinality differs: `space` at the separator, `space+` here
            // (`::: note` + two spaces + `"T"` opens). carve#907 settled it;
            // corpus category 255 carries the four tab cases.
            //
            // Whether the line OPENS at all is `colon_fence_named_tail_is_modeled`
            // in `src/scanner.c`, because a slot that rejects its separator has
            // to leave the line as PROSE and a rule here can only fail into an
            // ERROR. These tokens are the same rule at the shape level.
            seq(
              field("class", $.class_name),
              optional(seq($._padding_spaces, field("title", $.div_title))),
              optional(
                seq($._padding_spaces, field("label", $.code_block_label)),
              ),
            ),
            // Bare [label] with no type word (a typeless tab member); it may
            // sit directly against the fence (`:::[First]`) or after a space.
            seq(field("label", $.code_block_label)),
          ),
        ),
      ),
    class_name: ($) => $._id_no_digit_start,
    div_title: (_) =>
      choice(seq('"', /[^"\r\n]*/, '"'), seq("'", /[^'\r\n]*/, "'")),

    code_block: ($) =>
      seq(
        alias($._code_block_begin, $.code_block_marker_begin),
        // `fenced_code_block = code_fence_open, [space], [code_fence_info]`:
        // exactly one space, never a tab and never a run. The scanner declines
        // the fence outright for anything else, so this token never has to
        // reject - it states the same rule at the shape level.
        optional($._one_space),
        // Info string (PART 9 §2): an optional language, then an optional
        // quoted "header", then an optional bracketed [label] -- in that order,
        // each whitespace-separated from the preceding token. The first token
        // may sit against the fence, so a bare header or label is also valid.
        optional(
          choice(
            seq(
              field("language", $.language),
              // `code_fence_info = language_info, [space+, quoted_title],
              // [space+, label]`: the two metadata slots take a RUN, and still
              // no tab.
              optional(
                seq(
                  $._padding_spaces,
                  choice(
                    seq(
                      field("header", $.code_block_header),
                      optional(
                        seq(
                          $._padding_spaces,
                          field("label", $.code_block_label),
                        ),
                      ),
                    ),
                    field("label", $.code_block_label),
                  ),
                ),
              ),
            ),
            seq(
              field("header", $.code_block_header),
              optional(
                seq($._padding_spaces, field("label", $.code_block_label)),
              ),
            ),
            field("label", $.code_block_label),
          ),
        ),
        $._newline,
        optional(field("code", $.code)),
        $._block_close,
        optional(
          seq(
            alias($._code_block_end, $.code_block_marker_end),
            // A closer may carry trailing whitespace: the scanner's own closer
            // test treats a whitespace-only tail as blank (#96), and every
            // engine closes `\u0060\u0060\u0060   ` as a fence.
            $._whitespace,
            $._newline,
          ),
        ),
      ),
    raw_block: ($) =>
      seq(
        alias($._code_block_begin, $.raw_block_marker_begin),
        // `raw_block = code_fence_open, [space], "=", format_name`: the same
        // one-space slot the code fence takes, spelled the same way.
        optional($._one_space),
        field("info", $.raw_block_info),
        $._newline,
        field("content", optional(alias($.code, $.content))),
        $._block_close,
        optional(
          seq(
            alias($._code_block_end, $.raw_block_marker_end),
            $._whitespace,
            $._newline,
          ),
        ),
      ),
    raw_block_info: ($) =>
      choice(
        // Carve form: ```raw FORMAT
        seq(
          field("marker", alias("raw", $.language_marker)),
          $._whitespace1,
          field("language", $.language),
        ),
        // Djot form: ```=FORMAT (the `=` is glued to the fence, no space)
        seq(
          field("marker", alias(token.immediate("="), $.language_marker)),
          field("language", $.language),
        ),
      ),

    // Excludes `"` and `[` so a glued header/label (```php"x", ```php[x]) is
    // not swallowed into the language token -- the info string then needs the
    // space the spec requires, and a glued form falls back (matches the impls).
    language: (_) => /[^\r\n\t \{\}=\["]+/,
    code_block_label: (_) => seq("[", /[^\]\r\n]*/, "]"),
    // Quoted "header" on a code fence opener (PART 9 §2). A single token so it
    // lexes cleanly right after the immediate inter-token whitespace.
    // Double-quoted only, matching the carve impls' code-fence header (the
    // `language` token excludes `"` and the external scanner gates on `"`).
    code_block_header: (_) => token(seq('"', /[^"\r\n]*/, '"')),
    code: ($) =>
      prec.left(repeat1(seq(optional($._block_quote_prefix), $._line))),
    _line: ($) => seq(/[^\r\n]*/, $._newline),

    thematic_break: ($) =>
      seq(
        choice(
          $._thematic_break_dash,
          $._thematic_break_star,
          // The underscore spelling needs no external token: unlike `-` and
          // `*`, `_` is not a list marker, so there is nothing for the scanner
          // to disambiguate against. It was simply missing - and a line of
          // underscores has an obvious fallback (a paragraph), so the corpus
          // conformance run, which fails only on ERROR and MISSING nodes, saw
          // nothing wrong with `___`.
          $._thematic_break_underscore,
        ),
        $._newline,
      ),
    _thematic_break_underscore: (_) => token(prec(2, /_{3,}[ \t]*/)),

    block_quote: ($) =>
      seq(
        alias($._block_quote_begin, $.block_quote_marker),
        // A quote whose marker line carries nothing, and which nothing
        // continues, is an EMPTY quote: `blockquote = blockquote_line, {...}`
        // and `blockquote_line = '>', (newline | ...)` in the spec's
        // grammar.ebnf both admit the bare marker on its own, and every engine
        // renders `>` at end of input as an empty <blockquote> (#96).
        optional(
          choice(
            field("content", alias($._block_quote_content, $.content)),
            // An empty quote may carry FURTHER content-less marker lines:
            // `blockquote = blockquote_line, {blockquote_line | ...}` repeats
            // the bare line, so `>` / `>` is one empty quote, not two. Without
            // this arm the second marker had nowhere to attach - the
            // continuations inside `_block_quote_content` sit behind a first
            // real block - so it errored, or folded into a paragraph that
            // swallowed whatever followed the quote (#126).
            $._block_quote_prefix,
          ),
        ),
        $._block_close,
      ),
    _block_quote_content: ($) =>
      seq(
        choice($.heading, $._block_element),
        repeat(
          choice(
            seq($._block_quote_prefix, optional($._block_element)),
            // A `+` continuation marker (PART 9 §17) attaches a flush-left block
            // (not `>`-prefixed) to the quote (corpus 100-block-quote-continuation-marker).
            seq($.list_continuation_marker, $._block_element),
          ),
        ),
      ),
    _block_quote_prefix: ($) =>
      prec.left(
        repeat1(
          prec.left(alias($._block_quote_continuation, $.block_quote_marker)),
        ),
      ),

    block_math: ($) =>
      seq(
        field("math_marker", alias("$$", $.math_marker)),
        field("begin_marker", alias($._verbatim_begin, $.math_marker_begin)),
        field("content", alias($._verbatim_content, $.content)),
        field("end_marker", alias($._verbatim_end, $.math_marker_end)),
        $._newline,
      ),

    link_reference_definition: ($) =>
      seq(
        $._link_ref_def_mark_begin,
        "[",
        field("label", alias($._inline, $.link_label)),
        $._link_ref_def_label_end,
        "]",
        ":",
        optional(
          seq(
            $._whitespace1,
            field("destination", $.link_destination),
            optional(seq($._whitespace1, field("title", $.link_title))),
            // Unquoted trailing text after the destination (or title) is
            // dropped by the renderer (corpus 34-reference-link-5:
            // `[r]: a b c` resolves to href="a"). Consume it so the
            // definition still parses without ERROR; the low lexical
            // precedence keeps a quoted `link_title` winning when present.
            optional(
              seq(
                $._whitespace1,
                alias(token(prec(-1, /[^ \t\r\n][^\r\n]*/)), $.ignored_text),
              ),
            ),
          ),
        ),
        // Trailing whitespace after the `:` (or the destination) is allowed:
        // `[r]:   ` stays a definition-shaped line with no destination
        // (corpus 34-reference-link-9).
        optional($._whitespace1),
        $._newline,
      ),
    link_destination: (_) => /\S+/,

    // Citation definition block (Carve §22, Tier-2). `[@key]: entry text`.
    //
    // The spec reserves a leading `@` label here: `[@key]:` is NEVER a link
    // reference definition, it is a bibliography entry (parallels the `[^...]:`
    // footnote-definition precedence). The external scanner emits the same
    // `_link_ref_def_mark_begin` / `_link_ref_def_label_end` pair as a link ref
    // def (it matches any `[...]:`), so this rule shares that opener and is
    // disambiguated by the `@`-prefixed citation label. Unlike a link ref def
    // (whose destination is a single `\S+` token), the entry runs free-form to
    // end of line, so a multi-word entry (`Smith, J. (2020). Title.`) is kept
    // whole. The `prec(1)` makes this branch win over `link_reference_definition`
    // (whose `_inline` label would otherwise also match the `@key`). The label
    // is the SAME Pandoc citation-key charset that `citation_group` accepts, so
    // a key with internal punctuation (`[@smith.2020]`, `[@doi/10.1]`) is
    // defined consistently with the way it is cited.
    citation_definition: ($) =>
      prec(
        1,
        seq(
          $._link_ref_def_mark_begin,
          "[",
          field("label", $.citation_label),
          $._link_ref_def_label_end,
          "]",
          ":",
          optional(
            seq(
              $._whitespace1,
              field("entry", alias(/[^\r\n]+/, $.citation_entry)),
            ),
          ),
          $._newline,
        ),
      ),
    // `@` + Pandoc citation key (first char \w, then \w or internal punctuation).
    citation_label: (_) => token(seq("@", /[\w][\w:.#$%&+?<>~\/-]*/)),
    // A backslash escapes the next character inside a title, so
    // `"a\"b\"c"` is one title (corpus 34-reference-link-7).
    link_title: (_) =>
      choice(
        seq('"', /(?:[^"\\\r\n]|\\[^\r\n])*/, '"'),
        seq("'", /(?:[^'\\\r\n]|\\[^\r\n])*/, "'"),
      ),

    // carve-php caption block: `^ caption text` on its own line.
    //
    // In carve-php this is semantically a caption for the immediately
    // preceding image / table / blockquote. Tree-sitter has no lookback for
    // that context, so we recognize `^ TEXT` at block-line start regardless
    // of what precedes; the renderer (carve-php) decides whether to associate
    // it with a sibling block. Worst case for editors: a stray `^ foo` away
    // from a target block gets caption-style coloring without being a
    // real caption.
    //
    // v1 limitation: requires a blank line above the caption for highlight
    // recognition (so it starts a new block rather than continuing the
    // previous paragraph). carve-php itself renders both forms correctly;
    // a future fork commit can route this through the external scanner to
    // make `^ ` at line start always terminate paragraph continuation.
    //
    // Table captions remain handled by the existing table_caption rule via
    // the external scanner — this caption block is the standalone form.
    caption: ($) =>
      seq(
        alias(token(seq("^", " ")), $.caption_marker),
        field("content", alias(/[^\r\n]+/, $.caption_content)),
        $._newline,
      ),

    // THE ONE LINE ENDING THE EXTERNAL SCANNER DOES NOT CONSUME. Every other
    // terminator reaches `consume_line_end`, which is where `col_base` - the
    // column tree-sitter believes the current line starts at, see `scanner.c` -
    // is maintained. This token takes its own, so after a comment line ended by
    // a LONE '\r' the base is stale and an INDENTED construct on a following
    // line can be misread. Excluding the lone '\r' here is worse, not better:
    // the comment line then degrades to a paragraph in every '\r'-terminated
    // document, and `%% c` CR `- a` CR `  - b` collapses into one paragraph
    // instead of only the one shape that fails now. Closing it properly means
    // handing the terminator back to `$._newline`, which several call sites in
    // `scanner.c` are written around (#143).
    comment_line: (_) => token(seq(/[ \t]*/, "%%", /[^\r\n]*/, /\r\n|\r|\n/)),

    // Carve fenced comment block.
    // semantics — opener is N `%` (N >= 3), closer is a run of EXACTLY N `%`,
    // body may contain shorter `%`-runs as content (including pure `%%%`
    // lines as content inside a `%%%%` block).
    //
    // BOTH fence lines are a delimiter plus an INSIGNIFICANT TAIL (spec PART 9
    // section 28): only the leading run of `%` is structural, so `%%% TODO`
    // opens and `%%% end` closes. The opener already allowed a tail; the closer
    // did not, so ` end` used to fall out of the block and parse as a paragraph.
    //
    // The closer tail is written as "optionally, a non-% character then the
    // rest of the line" rather than as a negative lookahead, which this regex
    // subset does not have.
    //
    // A body line may carry a run of FEWER `%` than the fence or MORE of them,
    // just never exactly the fence width - that is what "the closer matches on
    // exact length" means from the body's side. Spelling only the "fewer" half,
    // as this rule first did, left a longer run unmatchable: the token could
    // not cover a `%%%%` line inside a `%%%` block, so the block closed on the
    // line's first three percent signs and the fourth fell out as a paragraph
    // (issue #28). Stating both halves removes the need for an end-of-input
    // anchor, which a `token()` regex cannot express anyway.
    //
    // Tree-sitter regex has no backreferences, so we encode each supported
    // fence length as a separate alternative. The lexer picks the longest
    // match overall, so an outer `%%%%` wins over an inner `%%%` close-
    // attempt. Lengths 3–6 cover real usage.
    //
    // Body line pattern for length N: optional indent, then up to N-1
    // leading `%`s, optionally followed by non-`%` content. Blank lines
    // also allowed.
    // A `%%%` comment fence. The SCANNER reads its body line by line and
    // decides where it ends, so this rule is three plain tokens with no
    // ambiguity to resolve.
    //
    // It used to be one multi-line `token()` regex, which cannot survive a
    // block quote: an internal token consumes its own text, so it would eat the
    // `> ` prefixes and the scanner would never see those lines - its per-line
    // bookkeeping went stale and the quote parsed as ERROR from the fence
    // onward (#45). Modelling the body as `optional(block_quote_prefix) line`,
    // the way a code block's is, does not work either: after the prefix token
    // the parser is committed to a content line and the closer is never
    // offered, so the fence ran to the end of the document.
    fenced_comment_block: ($) =>
      seq(
        alias($._comment_fence_begin, $.comment_fence_marker_begin),
        optional(field("info", alias(/[^\r\n]+/, $.comment_fence_info))),
        $._newline,
        optional(field("content", alias($._comment_fence_content, $.content))),
        $._block_close,
        optional(
          seq(
            alias($._comment_fence_end, $.comment_fence_marker_end),
            $._eof_or_newline,
          ),
        ),
      ),

    // The marker carries its own separator SPACE. The spec requires U+0020
    // after `]:` for all three definition markers and names carve-rs as the
    // reference: `*[HTML]:<TAB>Hyper` is an ordinary paragraph, not a
    // definition (corpus 137-abbreviation-definition-separator-must-be-a-space).
    //
    // The space has to be inside the TOKEN rather than a separate one after it.
    // A separate space-first token still lets `token(seq("*[", ..., "]:"))`
    // match and commit, and the rule then fails with an ERROR node instead of
    // falling back to a paragraph. Folding it in means the marker simply does
    // not tokenize without it, and the line stays prose (tree-sitter-carve#83).
    abbreviation_definition: ($) =>
      seq(
        // `abbreviation_term = (letter | digit)+`, and `letter` is enumerated
        // ASCII in the spec. `[^\]]+` accepted `*[e.g.]:` and `*[ß]:`, which
        // stay paragraph text in every engine - and a definition renders
        // NOTHING, so this highlighted a line as one that disappears from the
        // rendered document when it does not (carve#791).
        alias(token(seq("*[", /[A-Za-z0-9]+/, "]: ")), $.abbreviation_marker),
        optional(
          seq(
            optional($._whitespace1),
            field("expansion", alias(/[^\r\n]+/, $.abbreviation_expansion)),
          ),
        ),
        $._newline,
      ),

    // Citation group inline: `[@key]`, `[+@key]`, `[-@key]`, `[@a; see @b, p.4]`
    // (Carve §22, Tier-2 extension; Pandoc-compatible citation syntax.)
    //
    // The token is a single regex that matches the whole `[...]` construct so it
    // wins over `_bracketed_text_begin` in the lexer without needing the external
    // scanner.  Key charset follows Pandoc: first char \w, subsequent chars
    // \w or any of  :  .  #  $  %  &  +  ?  <  >  ~  /  -
    //
    // TAIL-LOOKAHEAD LIMITATION (tree-sitter 0.22 regex has no lookahead). The
    // spec / carve-js reference rule is: a `[...]` with a `@key` is a citation
    // ONLY when it has NO `(url)` / `[ref]` / `{attrs}` tail; with a tail it is a
    // link or span. A single lexer token cannot look past its own `]` to test the
    // following char, and a structural rule that reuses the bracket-span scanner
    // tokens collides irreconcilably with `link_text` / `span` over the inline
    // body. So two deliberate trade-offs keep this a clean lexer token:
    //
    //   1. CONSERVATIVE FIRST ITEM (no leading prefix text). `[see @a]` and a
    //      real link `[contact @support](url)` are lexically identical up to the
    //      `]`; matching arbitrary first-item prefix would steal such links. The
    //      first item therefore begins with `@` straight after `[`, `[+`, or
    //      `[-`. Prefix text IS supported on SECOND and later `;`-items
    //      (`[@a; see @b]`) where no link tail can follow a `;`. The dropped
    //      `[prefix @key]` single-item form falls back to text + a `mention`.
    //
    //   2. RESIDUAL `[@key](url)` / `[@key][ref]` OVERLAP. A bracket that is
    //      EXACTLY `[@key]` followed by a `(url)` or `[ref]` link tail is matched
    //      here as a citation, leaving the tail as separate text. This narrow
    //      mention-only-link form is the one case that still diverges; it is rare
    //      (a profile link is normally written `[@user]` then a separate link, or
    //      `[user](url)`), and the cost is cosmetic highlighting, not a parse
    //      failure. A `{attrs}` tail still attaches as an `inline_attribute`
    //      after the citation token (so `[@k]{.x}` stays citation + attribute).
    citation_group: (_) =>
      token(
        prec(
          1,
          seq(
            "[",
            optional("+"),
            // First item: `@key` immediately (optional `-` suppress-author).
            optional("-"),
            "@",
            /[\w][\w:.#$%&+?<>~\/-]*/,
            // optional locator text after the key
            /[^\[\]@\r\n]*/,
            // zero or more additional citation items separated by `;`; these MAY
            // carry prefix text since no link tail can follow a `;`.
            repeat(
              seq(
                ";",
                /[^\[\]@\r\n]*/,
                optional("-"),
                "@",
                /[\w][\w:.#$%&+?<>~\/-]*/,
                /[^\[\]@\r\n]*/,
              ),
            ),
            "]",
          ),
        ),
      ),

    // Callout list block (§10 / Tier-2 extension).
    //
    // A run of lines each starting with `<N> ` (one or more digits, then a
    // space, then prose). Each item self-terminates with its own newline, so the
    // list is just a `repeat1` of items: it ends naturally as soon as the next
    // line is not a `<N> ` token (a plain prose line, a list marker, EOF, ...),
    // and that following line is then parsed as its own block. (An earlier shape
    // that consumed a shared `_newline_inline` between items errored when a
    // non-callout line followed the last item, because the scanner offered the
    // paragraph-continuation newline and the rule then demanded another item.)
    callout_list: ($) => prec.right(repeat1($.callout_list_item)),
    callout_list_item: ($) =>
      seq(
        alias(token(seq("<", /[0-9]+/, ">", " ", /[^\r\n]+/)), $.content),
        $._eof_or_newline,
      ),

    block_attribute: ($) =>
      seq(
        alias($._block_attribute_begin, "{"),
        field(
          "args",
          alias(
            repeat(
              choice(
                $.class,
                $.identifier,
                $.key_value,
                // carve-php Boolean Attribute Shorthand: a bare key like
                // `{reversed}` is equivalent to `{reversed=reversed}` /
                // `{reversed=true}`. Must come after key_value in the
                // grammar's resolution order so `flag=value` still picks
                // key_value (the parser looks ahead for `=`).
                $.boolean_attribute,
                alias($._comment, $.comment),
                $._whitespace1,
                $._newline,
              ),
            ),
            $.args,
          ),
        ),
        "}",
        $._newline,
      ),
    class: ($) => seq(".", alias($.class_name, "class")),
    identifier: (_) => token(seq("#", token.immediate(/[^\s\}]+/))),
    key_value: ($) => seq(field("key", $.key), "=", field("value", $.value)),
    boolean_attribute: ($) => $.key,
    key: ($) => $._id_no_digit_start,
    value: (_) =>
      choice(
        // Double-quoted: allow escaped quotes (`\"`) and any other char,
        // including braces (`"{y}"`).
        seq('"', /([^"\\\r\n]|\\[^\r\n])*/, '"'),
        // Single-quoted: same, with `'` as the delimiter.
        seq("'", /([^'\\\r\n]|\\[^\r\n])*/, "'"),
        /\w+/,
      ),

    // Paragraphs are a bit special parsing wise as it's the "fallback"
    // block, where everything that doesn't fit will go.
    // There's no "start" token and they're not tracked by the external scanner.
    //
    // Instead they're ended by either a blankline or by an explicit
    // `_close_paragraph` token (by for instance div markers).
    //
    // Lines inside paragraphs are handled by the `_newline_inline` token
    // that's a newline character only valid inside an `_inline` context.
    // When the `newline_inline` token is no longer valid, the `_newline`
    // token can be emitted which closes the paragraph content.
    _paragraph: ($) =>
      seq(
        // Zero-width, and only ever present where the scanner declined a
        // container opener - it hands the run back so this paragraph can take
        // it. Produces no node.
        optional($._not_a_container_opener),
        alias($._paragraph_content, $.paragraph),
        // Blankline is split out from paragraph to enable textobject
        // to not select newline up to following text.
        choice($._eof_or_newline, $._close_paragraph),
      ),
    _paragraph_content: ($) =>
      // Newlines inside inline blocks should be of the `_newline_inline` type.
      seq(
        optional($._block_quote_prefix),
        $._inline,
        repeat(
          seq($._newline_inline, optional($._block_quote_prefix), $._inline),
        ),
        // Last newline can be of the normal variant to signal the end of the paragraph.
        $._eof_or_newline,
      ),

    _whitespace: (_) => token.immediate(/[ \t]*/),
    _whitespace1: (_) => token.immediate(/[ \t]+/),

    // A SLOT SPELLED `space`, in its two cardinalities. grammar.ebnf PART 7
    // (MARKER SEPARATORS AND PADDING SLOTS) spells every separator and every
    // padding slot with the literal space terminal; a tab is syntax only in a
    // line's leading indentation run, and each of these slots sits after the
    // first non-whitespace character of its line. `_whitespace`/`_whitespace1`
    // stay for the places that really do take both spellings - trailing
    // whitespace, and inline text.
    //
    // Kept distinct from the scanner's own answer rather than duplicating it:
    // `code_fence_info_is_modeled` in `src/scanner.c` decides whether the fence
    // OPENS at all, because a slot that rejects its separator has to leave the
    // line as prose, and a grammar rule can only fail into an ERROR. These
    // tokens are the same rule at the SHAPE level, so the two spellings agree
    // instead of the looser one silently authorizing what the scanner declines.
    _one_space: (_) => token.immediate(" "),
    _padding_spaces: (_) => token.immediate(/ +/),

    _inline: ($) =>
      prec.left(
        repeat1(choice($._inline_element, $._newline_inline, $._whitespace1)),
      ),

    _inline_without_trailing_space: ($) =>
      seq(
        prec.left(
          repeat(choice($._inline_element, $._newline_inline, $._whitespace1)),
        ),
        $._inline_element,
      ),

    _inline_element: ($) =>
      prec.left(
        choice(
          // Span is declared separately because it always parses an `inline_attribute`,
          // while the attribute is optional for everything else.
          $.span,
          seq(
            choice(
              $._smart_punctuation,
              $.backslash_escape,
              $.hard_line_break,
              // Elements containing other inline elements needs to have the same precedence level
              // so we can choose the element that's closed first.
              //
              // For example:
              //
              //     *[x](y*)
              //
              // Should parse a strong element instead of a link because it's closed before the link.
              //
              // They also need a higher precedence than the fallback tokens so that:
              //
              //     _a_
              //
              // Is parsed as emphasis instead of just text with `_symbol_fallback` tokens.
              prec.dynamic(2 * ELEMENT_PRECEDENCE, $.bold_italic),
              prec.dynamic(ELEMENT_PRECEDENCE, $.emphasis),
              prec.dynamic(ELEMENT_PRECEDENCE, $.strong),
              prec.dynamic(ELEMENT_PRECEDENCE, $.underline),
              prec.dynamic(ELEMENT_PRECEDENCE, $.strikethrough),
              prec.dynamic(ELEMENT_PRECEDENCE, $.highlighted),
              prec.dynamic(ELEMENT_PRECEDENCE, $.superscript),
              prec.dynamic(ELEMENT_PRECEDENCE, $.subscript),
              prec.dynamic(ELEMENT_PRECEDENCE, $.insert),
              prec.dynamic(ELEMENT_PRECEDENCE, $.delete),
              $.substitution,
              $.editorial_comment,
              prec.dynamic(ELEMENT_PRECEDENCE, $.footnote_reference),
              prec.dynamic(ELEMENT_PRECEDENCE, $._image),
              prec.dynamic(ELEMENT_PRECEDENCE, $._link),
              prec.dynamic(ELEMENT_PRECEDENCE, $.extension_inline),
              prec.dynamic(ELEMENT_PRECEDENCE, $.mention),
              prec.dynamic(ELEMENT_PRECEDENCE, $.tag),
              prec.dynamic(ELEMENT_PRECEDENCE, $.citation_group),
              $.autolink,
              $.verbatim,
              alias($.inline_math, $.math),
              $.inline_literal,
              $.raw_inline,
              $.symbol,
              $.inline_comment,
              $.trailing_comment,
              $._todo_highlights,
              // Word runs that ABSORB a glued mention / tag / symbol, which is
              // how the leading word-boundary guard is enforced without
              // lookbehind (see _glued_* below).
              $._glued_mention,
              $._glued_tag,
              $._glued_symbol,
              // Text and the symbol fallback matches everything not matched elsewhere.
              $._symbol_fallback,
              $._text,
            ),
            optional(
              // We need a separate fallback token for the opening `{`
              // for the parser to recognize the conflict.
              choice(
                // Use precedence for inline attribute as well to allow
                // closure before other elements.
                prec.dynamic(
                  2 * ELEMENT_PRECEDENCE,
                  field("attribute", $.inline_attribute),
                ),
                $._curly_bracket_span_fallback,
              ),
            ),
          ),
        ),
      ),

    _inline_line: ($) => seq($._inline, $._eof_or_newline),

    _smart_punctuation: ($) =>
      choice($.quotation_marks, $.ellipsis, $.em_dash, $.en_dash),
    // It would be nice to be able to mark bare " and ', but then we'd have to be smarter
    // so we don't mark the ' in `it's`. Not sure if we can do that in a correct way.
    quotation_marks: (_) => token(choice('{"', '"}', "{'", "'}", '\\"', "\\'")),
    ellipsis: (_) => "...",
    em_dash: (_) => "---",
    en_dash: (_) => "--",

    backslash_escape: (_) => /\\[^\r\n]/,

    autolink: (_) => seq("<", /[^>\s]+/, ">"),

    mention: (_) => token(seq("@", /[a-zA-Z0-9][a-zA-Z0-9_-]*/)),

    tag: (_) => token(seq("#", /[a-zA-Z0-9][a-zA-Z0-9_-]*/)),

    extension_inline: (_) =>
      token(seq(":", /[a-zA-Z][a-zA-Z0-9_-]*/, "[", /[^\]\r\n]*/, "]")),

    // A `:name:` symbol: the first name char is a letter, digit, `+` or `-`
    // (so `:+1:` / `:-1:` parse), never `_`; the rest may add `_`. (carve#261)
    symbol: (_) => token(seq(":", /[a-zA-Z0-9+-][\w+-]*/, ":")),

    // Emphasis and strong are a little special as they don't allow spaces next
    // to begin and end markers unless using the bracketed variant.
    // The strategy to solve this:
    //
    // Begin: Use the zero-width `$._non_whitespace_check` token to avoid the `_ ` case.
    // End: Use `$._inline_without_trailing_space` to match inline without a trailing space
    //      and let the end token in the external scanner consume space for the `_}` case
    //      and not for the `_` case.
    emphasis: ($) =>
      seq(
        field("begin_marker", $.emphasis_begin),
        $._emphasis_mark_begin,
        field("content", alias($._inline_without_trailing_space, $.content)),
        field("end_marker", $.emphasis_end),
      ),
    emphasis_begin: ($) => choice("{/", seq("/", $._non_whitespace_check)),

    bold_italic: ($) =>
      seq(
        field("begin_marker", $.bold_italic_begin),
        $._bold_italic_mark_begin,
        field("content", alias($._inline_without_trailing_space, $.content)),
        field("end_marker", $.bold_italic_end),
      ),
    bold_italic_begin: ($) => seq("/*", $._non_whitespace_check),

    strong: ($) =>
      seq(
        field("begin_marker", $.strong_begin),
        $._strong_mark_begin,
        field("content", alias($._inline_without_trailing_space, $.content)),
        field("end_marker", $.strong_end),
      ),
    strong_begin: ($) => choice("{*", seq("*", $._non_whitespace_check)),

    underline: ($) =>
      seq(
        field("begin_marker", $.underline_begin),
        $._underline_mark_begin,
        field("content", alias($._inline_without_trailing_space, $.content)),
        field("end_marker", $.underline_end),
      ),
    underline_begin: ($) => choice("{_", seq("_", $._non_whitespace_check)),

    strikethrough: ($) =>
      seq(
        field("begin_marker", $.strikethrough_begin),
        $._strikethrough_mark_begin,
        field("content", alias($._inline_without_trailing_space, $.content)),
        field("end_marker", $.strikethrough_end),
      ),
    strikethrough_begin: ($) => choice("{~", seq("~", $._non_whitespace_check)),

    // The syntax description isn't clear about if non-bracket can contain surrounding spaces.
    // The live playground suggests that yes they can, although it's a bit inconsistent.
    superscript: ($) =>
      seq(
        field("begin_marker", $.superscript_begin),
        $._superscript_mark_begin,
        field("content", alias($._inline, $.content)),
        field("end_marker", $.superscript_end),
      ),
    // Braced-only (spec PR 259): a bare `^` is literal text.
    superscript_begin: (_) => "{^",

    subscript: ($) =>
      seq(
        field("begin_marker", $.subscript_begin),
        $._subscript_mark_begin,
        field("content", alias($._inline, $.content)),
        field("end_marker", $.subscript_end),
      ),
    // Braced-only (spec PR 259): a bare `,` is literal text.
    subscript_begin: (_) => "{,",

    highlighted: ($) =>
      seq(
        field("begin_marker", $.highlighted_begin),
        $._highlighted_mark_begin,
        field("content", alias($._inline, $.content)),
        field("end_marker", $.highlighted_end),
      ),
    highlighted_begin: ($) => choice("{=", seq("=", $._highlighted_open_check)),
    insert: ($) =>
      seq(
        field("begin_marker", $.insert_begin),
        $._insert_mark_begin,
        field("content", alias($._inline, $.content)),
        field("end_marker", $.insert_end),
      ),
    insert_begin: (_) => "{+",
    delete: ($) =>
      seq(
        field("begin_marker", $.delete_begin),
        $._delete_mark_begin,
        field("content", alias($._inline, $.content)),
        field("end_marker", $.delete_end),
      ),
    delete_begin: (_) => "{-",

    substitution: (_) => token(seq("{~", /[^~\r\n]+/, "~>", /[^~\r\n]+/, "~}")),

    editorial_comment: (_) => token(seq("{#", /[^#\r\n]*/, "#}")),

    footnote_reference: ($) =>
      seq(
        $.footnote_marker_begin,
        $._square_bracket_span_mark_begin,
        $.reference_label,
        alias($._square_bracket_span_end, $.footnote_marker_end),
      ),
    footnote_marker_begin: (_) => "[^",

    reference_label: ($) => $._id,
    _id: (_) => /[\w_-]+/,
    // An identifier that must start with a letter or underscore (a leading
    // `_` is valid, e.g. the `_box` div class). Used for class names and
    // attribute keys: a digit- or hyphen-leading token (`.123`, `12=v`,
    // `-foo`) is not a valid attribute (and `::: 123` is not a div), so it
    // falls back to literal text.
    _id_no_digit_start: (_) => /[A-Za-z_][\w_-]*/,

    _image: ($) =>
      choice(
        $.full_reference_image,
        $.collapsed_reference_image,
        $.inline_image,
      ),
    full_reference_image: ($) =>
      seq(field("description", $.image_description), $._link_label),
    collapsed_reference_image: ($) =>
      seq(field("description", $.image_description), token.immediate("[]")),
    inline_image: ($) =>
      seq(
        field("description", $.image_description),
        field("destination", $.inline_link_destination),
      ),

    image_description: ($) =>
      seq(
        $._image_description_begin,
        $._square_bracket_span_mark_begin,
        optional($._inline),
        alias($._square_bracket_span_end, "]"),
      ),
    _image_description_begin: (_) => "![",

    _link: ($) =>
      choice($.full_reference_link, $.collapsed_reference_link, $.inline_link),
    full_reference_link: ($) => seq(field("text", $.link_text), $._link_label),
    collapsed_reference_link: ($) =>
      seq(field("text", $.link_text), token.immediate("[]")),
    inline_link: ($) =>
      seq(
        field("text", $.link_text),
        field("destination", $.inline_link_destination),
      ),

    link_text: ($) =>
      choice(
        seq(
          $._bracketed_text_begin,
          $._square_bracket_span_mark_begin,
          $._inline,
          // Alias to "]" to allow us to highlight it in Neovim.
          // Maybe some bug, or some undocumented behavior?
          alias($._square_bracket_span_end, "]"),
        ),
        // Required as we track fallback characters between bracketed begin and end,
        // but when it's empty it skips blocks the inline link destination.
        // This is an easy workaround for that special case.
        "[]",
      ),

    span: ($) =>
      seq(
        $._bracketed_text_begin,
        $._square_bracket_span_mark_begin,
        field("content", alias($._inline, $.content)),
        // Prefer span over regular text + inline attribute.
        prec.dynamic(
          ELEMENT_PRECEDENCE,
          alias($._square_bracket_span_end, "]"),
        ),
        field("attribute", $.inline_attribute),
      ),

    _bracketed_text_begin: (_) => "[",

    inline_attribute: ($) =>
      seq(
        $._curly_bracket_span_begin,
        $._curly_bracket_span_mark_begin,
        alias(
          repeat(
            choice(
              $.class,
              $.identifier,
              $.key_value,
              $.boolean_attribute,
              alias($._comment, $.comment),
              $._whitespace1,
              $._newline_inline,
            ),
          ),
          $.args,
        ),
        alias($._curly_bracket_span_end, "}"),
      ),
    _curly_bracket_span_begin: (_) => "{",

    _bracketed_text: ($) =>
      seq(
        $._bracketed_text_begin,
        $._square_bracket_span_mark_begin,
        $._inline,
        $._square_bracket_span_end,
      ),

    _link_label: ($) =>
      seq(
        "[",
        field("label", alias($._inline, $.link_label)),
        token.immediate("]"),
      ),
    inline_link_destination: ($) =>
      seq(
        $._parens_span_begin,
        $._parens_span_mark_begin,
        $._inline_link_url,
        alias($._parens_span_end, ")"),
      ),
    _inline_link_url: ($) =>
      // Can escape `)`, but shouldn't capture it.
      repeat1(choice(/([^\)\r\n]|\\\))+/, $._newline_inline)),
    _parens_span_begin: (_) => "(",

    _comment: ($) =>
      seq(
        "%",
        field(
          "content",
          alias(repeat(choice($.backslash_escape, /[^%}]/)), $.content),
        ),
        choice(alias($._comment_end_marker, "%"), $._comment_close),
      ),

    inline_comment: ($) =>
      seq(
        $._whitespace1,
        $._inline_comment_begin,
        $._curly_bracket_span_mark_begin,
        $._comment,
        alias($._curly_bracket_span_end, "}"),
      ),

    // Trailing inline comment: `text %% to end of line`.
    // The `%%` marker comments out the rest of the physical line; it must be
    // preceded by a space or tab (folded into the token, since tree-sitter has
    // no lookbehind) so `a%%b` / `50%% off` stay literal, matching the runtime
    // parsers. Does NOT consume the newline, so the line's structure and
    // soft-break are preserved.
    trailing_comment: (_) => token(seq(/[ \t]/, "%%", /[^\r\n]*/)),

    raw_inline: ($) =>
      seq(
        field(
          "begin_marker",
          alias($._verbatim_begin, $.raw_inline_marker_begin),
        ),
        field("content", alias($._verbatim_content, $.content)),
        field("end_marker", alias($._verbatim_end, $.raw_inline_marker_end)),
        field("attribute", $.raw_inline_attribute),
      ),
    raw_inline_attribute: ($) =>
      seq(token.immediate("{="), field("language", $.language), "}"),
    inline_math: ($) =>
      seq(
        field("math_marker", alias(choice("$$", "$"), $.math_marker)),
        field("begin_marker", alias($._verbatim_begin, $.math_marker_begin)),
        field("content", alias($._verbatim_content, $.content)),
        field("end_marker", alias($._verbatim_end, $.math_marker_end)),
      ),
    // Inline literal: a `!` prefix on a verbatim span (`` !`…` ``). Structurally
    // identical to inline_math, swapping the `$`/`$$` marker for `!`; renders as
    // literal prose, so highlights.scm captures it plainly and injections.scm
    // leaves it uninjected. A trailing `{…}` attaches as an ordinary inline
    // attribute block, like any other inline element.
    inline_literal: ($) =>
      seq(
        field("marker", alias("!", $.literal_marker)),
        field("open", alias($._verbatim_begin, $.literal_marker_begin)),
        field("content", alias($._verbatim_content, $.content)),
        field("close", alias($._verbatim_end, $.literal_marker_end)),
      ),
    verbatim: ($) =>
      seq(
        field(
          "begin_marker",
          alias($._verbatim_begin, $.verbatim_marker_begin),
        ),
        field("content", alias($._verbatim_content, $.content)),
        field("end_marker", alias($._verbatim_end, $.verbatim_marker_end)),
      ),

    _todo_highlights: ($) => choice($.todo, $.note, $.fixme),
    todo: (_) => choice("TODO", "WIP"),
    note: (_) => choice("NOTE", "INFO", "XXX"),
    fixme: (_) => "FIXME",

    // These exists to explicit trigger an LR collision with existing
    // prefixes. A collision isn't detected with a string and the
    // catch-all `_text` regex.
    //
    // Don't use dynamic precedence on the fallback, instead use it
    // on span end tokens to prevent these branches from getting pruned
    // when the tree grows large.
    //
    // Block level collisions handled by the scanner scanning ahead.
    _symbol_fallback: ($) =>
      choice(
        // Standalone emphasis and strong markers are required for backtracking
        "/",
        // `/*` is a token in its own right, so a bare one needs its own
        // standalone fallback the way `/` and `*` do - otherwise `/* x/`, where
        // the whitespace check after `/*` fails, has no lexing left at all.
        "/*",
        "*",
        "_",
        "~",
        // Single-char highlight/subscript markers also need a standalone
        // fallback so a lone `=` / `,` that does not open a span (e.g. the `=`
        // in a `|=` table header cell, or a comma in prose) becomes literal.
        ",",
        "=",
        // Whitespace sensitive
        // `/*` is a longer token than `/`, so without a branch of its own an
        // unclosed bold-italic could not lose to emphasis at all: the parser
        // commits to `bold_italic_begin` and errors at the end of the line.
        seq(
          seq("/*", $._non_whitespace_check),
          choice($._bold_italic_mark_begin, $._in_fallback),
        ),
        seq(
          seq("/", $._non_whitespace_check),
          choice($._emphasis_mark_begin, $._in_fallback),
        ),
        seq(
          choice("{*", seq("*", $._non_whitespace_check)),
          choice($._strong_mark_begin, $._in_fallback),
        ),
        seq(
          seq("_", $._non_whitespace_check),
          choice($._underline_mark_begin, $._in_fallback),
        ),
        seq(
          seq("~", $._non_whitespace_check),
          choice($._strikethrough_mark_begin, $._in_fallback),
        ),
        // Not sensitive to whitespace
        seq(
          choice("{^", "^"),
          choice($._superscript_mark_begin, $._in_fallback),
        ),
        seq(
          choice("{,", seq(",", $._non_whitespace_check)),
          choice($._subscript_mark_begin, $._in_fallback),
        ),
        seq(
          choice("{=", seq("=", $._highlighted_open_check)),
          choice($._highlighted_mark_begin, $._in_fallback),
        ),
        seq("{+", choice($._insert_mark_begin, $._in_fallback)),
        seq("{-", choice($._delete_mark_begin, $._in_fallback)),

        // Bracketed spans
        seq("[^", choice($._square_bracket_span_mark_begin, $._in_fallback)),
        seq("![", choice($._square_bracket_span_mark_begin, $._in_fallback)),
        seq("[", choice($._square_bracket_span_mark_begin, $._in_fallback)),
        seq("(", choice($._parens_span_mark_begin, $._in_fallback)),

        // Autolink
        "<",
        seq("<", /[^>\s]+/),

        // Math
        "$$",
        "$",

        // Inline literal: a bare `!` that does not open a `` !`…` `` span
        // (no verbatim run follows) falls back to literal text, exactly as a
        // lone `$` does for math.
        "!",

        // Empty link text
        "[]",
      ),

    // Used to branch on inline attributes that may follow any element.
    _curly_bracket_span_fallback: ($) =>
      seq("{", choice($._curly_bracket_span_mark_begin, $._in_fallback)),

    // It's a bit faster with repeat1 here.
    // Leading word-boundary guard for mention / tag / symbol (PART 9 §7): a
    // word run glued to one of them swallows it, so it stays literal text.
    // `me@example.com`, `a#b`, `a:b:c`, `10:30:` and `x:rocket:` are text.
    _glued_mention: (_) =>
      token(prec(1, /[A-Za-z0-9_]+@[a-zA-Z0-9][a-zA-Z0-9_.-]*/)),
    _glued_tag: (_) =>
      token(prec(1, /[A-Za-z0-9_]+#[a-zA-Z0-9][a-zA-Z0-9_.-]*/)),
    // The closing `:` is required, so an inline extension still fires intraword
    // (`foo:kbd[Ctrl]`): `:kbd[` carries no closing colon and is not absorbed.
    _glued_symbol: (_) =>
      token(prec(1, /[A-Za-z0-9_]+:[a-zA-Z0-9+-][a-zA-Z0-9_+-]*:/)),

    _text: (_) => repeat1(/\S/),
  },

  externals: ($) => [
    // Used as default value in scanner, should never be referenced.
    $._ignored,

    // Token to implicitly terminate open blocks,
    // for instance in this case:
    //
    //    :::
    //    ::::
    //    txt
    //    :::   <- closes both divs
    //
    // `_block_close` is used to close both open divs,
    // and the outer most div consumes the optional ending div marker.
    $._block_close,

    // Different kinds of newlines are handled by the external scanner so
    // we can manually track indent (and reset it on newlines).
    $._eof_or_newline,
    // `_newline` is a regular newline, and is used to end paragraphs and other blocks.
    $._newline,
    // `_newline_inline` is a newline that's only valid inside an inline context.
    // It contains logic on when to terminate a paragraph.
    // When a paragraph should be closed, `_newline_inline` will not be valid,
    // so `_newline` will have to be used, which is only valid at the end of a paragraph.
    $._newline_inline,
    // A zero-width whitespace check token.
    $._non_whitespace_check,
    $._highlighted_open_check,
    // A hard line break that doesn't consume a newline.
    $.hard_line_break,

    // Detects a frontmatter delimiters: `---`
    // Handled externally to resolve conflicts with list markers and thematic breaks.
    $.frontmatter_marker,

    // Blocks.
    // The external scanner keeps a stack of blocks for context in order to
    // match and close against open blocks.

    // Headings open and close sections, but they're not exposed to `grammar.js`
    // but is used by the external scanner internally.
    $._heading_begin,

    // Matches div markers with varying number of `:`.
    $._div_begin,
    $._div_end,
    // Matches code block markers with varying number of `.
    $._code_block_begin,
    $._code_block_end,
    // NOTE: this array is POSITIONAL - its order must match the TokenType enum
    // in src/scanner.c exactly.
    $._comment_fence_begin,
    $._comment_fence_content,
    $._comment_fence_end,
    // Zero-width, emitted where a `:::` run is NOT an opener. Refusing there
    // leaves the colons consumed; emitting hands them back.
    $._not_a_container_opener,
    // There are lots of lists in Carve that shouldn't be mixed.
    // Parsing a list marker opens or closes lists depending on the marker type.
    $.list_marker_dash,
    $.list_marker_star,
    // `list_marker_task_begin` only matches opening `- ` or `* `, but
    // only if followed by a valid task box. `+` is never a bullet in Carve,
    // so it cannot open a task list either.
    // This is done to allow the task box markers like `x` to have their own token.
    $._list_marker_task_begin,
    $.list_marker_definition,
    $.list_marker_description,
    $.list_marker_decimal_period,
    $.list_marker_lower_alpha_period,
    $.list_marker_upper_alpha_period,
    $.list_marker_lower_roman_period,
    $.list_marker_upper_roman_period,
    $.list_marker_decimal_paren,
    $.list_marker_lower_alpha_paren,
    $.list_marker_upper_alpha_paren,
    $.list_marker_lower_roman_paren,
    $.list_marker_upper_roman_paren,
    $.list_marker_decimal_parens,
    $.list_marker_lower_alpha_parens,
    $.list_marker_upper_alpha_parens,
    $.list_marker_lower_roman_parens,
    $.list_marker_upper_roman_parens,
    // List item continuation consumes whitespace indentation for lists.
    $._list_item_continuation,
    // `_list_item_end` is responsible for closing an open list,
    // if indent or list markers are mismatched.
    $._list_item_end,
    // `_indented_content_spacer` is either a blankline separating
    // indented content or a zero-width marker if content continues immediately.
    //
    //    - a
    //              <- spacer
    //      ```
    //      x
    //      ```
    //      b       <- zero-width spacer (followed by a list item continuation).
    //
    $._indented_content_spacer,
    // Paragraphs are anonymous blocks and open blocks aren't tracked by the
    // external scanner. `close_paragraph` is a marker that's responsible
    // for closing the paragraph early, for example on a div marker.
    $._close_paragraph,
    $._block_quote_begin,
    // `block_quote_continuation` continues an open block quote, and can be included
    // in other elements. For example:
    //
    //    > a   <- `block_quote_begin` (before the paragraph)
    //    > b   <- `block_quote_continuation` (inside the paragraph)
    //
    $._block_quote_continuation,
    $._thematic_break_dash,
    $._thematic_break_star,
    // Footnotes have significant whitespace and can contain blocks,
    // the same as lists.
    $._footnote_mark_begin,
    $._footnote_continuation,
    $._footnote_end,
    // Link reference definitions needs to make sure
    // that inline content doesn't escape the label brackets
    // or continue into other lines, like this:
    //
    //    [one_]: /can_have_many_underscores_in_url
    //    [two_]: /should_not_be_emphasis
    //
    // The above should be two definitions, not a paragraph with emphasis.
    $._link_ref_def_mark_begin,
    $._link_ref_def_label_end,
    // Table begin consumes a `|` if the row is a valid table row.
    // In Carve the number of table cells don't have to match for in the table.
    // The different types are here to let the scanner take care of the detection
    // to avoid tree-sitter branching.
    // `header`, `separator`, and `row` are just different types of table rows.
    $._table_header_begin,
    $._table_separator_begin,
    $._table_row_begin,
    // `_table_row_end_newline` consumes the ending newline.
    $._table_row_end_newline,
    // `_table_cell_end` consumes the ending `|`.
    $._table_cell_end,
    // Table captions have significant whitespace but contain only inline.
    $._table_caption_begin,
    $._table_caption_end,
    // The `{` that begins a block attribute (scans the entire attribute to avoid
    // excessive branching).
    $._block_attribute_begin,
    // A comment can be closed by a `%` or implicitly when the attribute closes at `}`.
    $._comment_end_marker,
    $._comment_close,

    // Inline elements.

    // Zero-width check if a standalone comment is valid.
    $._inline_comment_begin,

    // Verbatim is handled externally to match a varying number of `,
    // and to close open verbatim when a paragraph ends with a blankline.
    $._verbatim_begin,
    $._verbatim_end,
    $._verbatim_content,

    // The different spans.
    // Begin is marked by a zero-width token and the end is the actual
    // ending token (such as `_}`).
    $._emphasis_mark_begin,
    $.emphasis_end,
    $._strong_mark_begin,
    $.strong_end,
    $._underline_mark_begin,
    $.underline_end,
    $._strikethrough_mark_begin,
    $.strikethrough_end,
    $._superscript_mark_begin,
    $.superscript_end,
    $._subscript_mark_begin,
    $.subscript_end,
    $._highlighted_mark_begin,
    $.highlighted_end,
    $._insert_mark_begin,
    $.insert_end,
    $._delete_mark_begin,
    $.delete_end,
    // Spans where the external scanner uses a zero-width begin marker
    // and parser the end token as ), } or ].
    $._parens_span_mark_begin,
    $._parens_span_end,
    $._curly_bracket_span_mark_begin,
    $._curly_bracket_span_end,
    $._square_bracket_span_mark_begin,
    $._square_bracket_span_end,

    // A signaling token that's used to signal that a fallback token should be scanned,
    // and should never be output.
    // It's used to notify the external scanner if we're in the fallback branch or in
    // if we're scanning a span. This so the scanner knows if the current element should
    // be stored on the stack or not.
    $._in_fallback,

    // Never valid and is only used to signal an internal scanner error.
    $._error,

    // A lone `+` on its own line: the list/block-quote continuation marker
    // (PART 9 §17). Appended at the END to keep all existing external indices
    // aligned with the `TokenType` enum in scanner.c.
    $.list_continuation_marker,

    // Bold-italic `/*…*/`, the one span whose delimiters are two characters
    // and not mirror images. Appended for the same reason as the marker above.
    $._bold_italic_mark_begin,
    $.bold_italic_end,
  ],
});
