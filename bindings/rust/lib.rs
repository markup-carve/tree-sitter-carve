//! This crate provides Carve language support for the [tree-sitter][] parsing library.
//!
//! Typically, you will use the [language][language func] function to add this language to a
//! tree-sitter [Parser][], and then use the parser to parse some code:
//!
//! ```
//! let code = "";
//! let mut parser = tree_sitter::Parser::new();
//! parser.set_language(&tree_sitter_carve::language()).expect("Error loading Carve grammar");
//! let tree = parser.parse(code, None).unwrap();
//! ```
//!
//! [Language]: https://docs.rs/tree-sitter/*/tree_sitter/struct.Language.html
//! [language func]: fn.language.html
//! [Parser]: https://docs.rs/tree-sitter/*/tree_sitter/struct.Parser.html
//! [tree-sitter]: https://tree-sitter.github.io/

use tree_sitter::Language;

extern "C" {
    fn tree_sitter_carve() -> Language;
}

/// Get the tree-sitter [Language][] for this grammar.
///
/// [Language]: https://docs.rs/tree-sitter/*/tree_sitter/struct.Language.html
pub fn language() -> Language {
    unsafe { tree_sitter_carve() }
}

/// The content of the [`node-types.json`][] file for this grammar.
///
/// [`node-types.json`]: https://tree-sitter.github.io/tree-sitter/using-parsers#static-node-types
pub const NODE_TYPES: &'static str = include_str!("../../src/node-types.json");

// Uncomment these to include any queries that this grammar contains

pub const HIGHLIGHTS_QUERY: &'static str = include_str!("../../queries/highlights.scm");
pub const INJECTIONS_QUERY: &'static str = include_str!("../../queries/injections.scm");
// pub const LOCALS_QUERY: &'static str = include_str!("../../queries/locals.scm");
// pub const TAGS_QUERY: &'static str = include_str!("../../queries/tags.scm");

#[cfg(test)]
mod tests {
    #[test]
    fn test_can_load_grammar() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
    }

    /// The hard-break fence `::: \` still opens with trailing whitespace after
    /// the backslash, exactly as carve-js does.
    ///
    /// This lives here rather than in `test/corpus/carve.txt` because the whole
    /// meaning of the case IS a trailing space. In a fixture file that space is
    /// one stray normalization away from disappearing, and the case would then
    /// silently become a duplicate of the no-trailing-space one and keep
    /// passing - a check that can no longer fail. Inside a string literal it
    /// survives `cargo fmt` and any editor that trims line ends.
    #[test]
    fn hard_break_fence_opens_with_trailing_whitespace() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let tree = parser.parse("::: \\ \none\n:::\n", None).unwrap();
        let first = tree.root_node().child(0).expect("document has no child");
        assert_eq!(first.kind(), "div");
    }

    /// A code fence closer may carry trailing whitespace and still close.
    ///
    /// Same reason as the case above: the whole meaning here IS the trailing
    /// run of spaces. In `test/corpus/carve.txt` it would be one editor or one
    /// `.gitattributes` sweep away from becoming a silent duplicate of the
    /// no-trailing-space closer, and the clause it guards -- the whitespace
    /// skip in `code_fence_closer_tail_is_blank` -- would then have no check
    /// that can fail. Delete that skip and this test reports a fence that
    /// never closed.
    #[test]
    fn code_fence_closer_may_carry_trailing_whitespace() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for source in ["```\nx\n```   \n", "```\nx\n```\t\n"] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {:?}", source);
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), "code_block");
            let last = block.child(block.child_count() as u32 - 1).unwrap();
            assert_eq!(last.kind(), "code_block_marker_end", "for {:?}", source);
            // The marker ends at the run. The tail peek walks past the
            // whitespace, so the scanner has to pin the token before it looks;
            // pinning after would stretch the marker over the trailing run, and
            // an S-expression corpus fixture records no byte ranges to notice.
            assert_eq!(
                last.end_byte() - last.start_byte(),
                3,
                "marker spans more than its run for {:?}",
                source
            );
        }
    }

    /// A CRLF document's fence closer still closes.
    ///
    /// This was a CONTROL, on the grounds that `advance` ate a carriage return
    /// wherever it found one so the tail test never saw a `\r`. It is not a
    /// control any more: a `\r` IS a line terminator now
    /// (tree-sitter-carve#143), the tail test does see it, and deleting the
    /// `\r` arm of `at_line_end` fails this test. There is no CRLF fixture to
    /// carry it -- `.gitattributes` normalizes the repo to LF -- so the line
    /// endings live in a string literal.
    #[test]
    fn code_fence_closer_closes_in_a_crlf_document() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let tree = parser.parse("```\r\nx\r\n```\r\n", None).unwrap();
        let root = tree.root_node();
        assert!(!root.has_error());
        let block = root.child(0).expect("document has no child");
        assert_eq!(block.kind(), "code_block");
        let last = block.child(block.child_count() as u32 - 1).unwrap();
        assert_eq!(last.kind(), "code_block_marker_end");
    }

    /// A LONE CARRIAGE RETURN ENDS A LINE (tree-sitter-carve#143).
    ///
    /// `newline = '\n' | '\r\n' | '\r'` in the spec's
    /// `resources/grammar.ebnf`, and PART 0's INPUT paragraph names that
    /// production rather than restating it. The pinned `@markup-carve/carve`
    /// devDependency renders all three spellings of this document to identical
    /// HTML, so it is a conformance question and needed no engine build.
    ///
    /// These live here rather than in `test/corpus/carve.txt` for the reason
    /// tree-sitter-carve#147 settled: choose the home by how a DEGRADED input
    /// fails. A `\r` in a fixture file is exactly what an editor, a
    /// `.gitattributes` sweep (`* text eol=lf` here) or a formatter rewrites to
    /// `\n` - and the rewritten document parses to the SAME tree these cases
    /// assert, so the corruption would be silent and the case would pass
    /// forever having tested nothing. In a Rust string literal the terminator
    /// is an escape, which nothing normalizes.
    #[test]
    fn a_lone_carriage_return_ends_a_line() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let tree = parser.parse("# Title\r\ra\rb\r", None).unwrap();
        let root = tree.root_node();
        assert!(!root.has_error(), "unexpected ERROR: {root}");
        let section = root.child(0).expect("document has no child");
        assert_eq!(section.kind(), "section");
        assert_eq!(
            section.child(0).unwrap().kind(),
            "heading",
            "want a heading and a paragraph, got {section}"
        );
        let content = section.child(1).expect("section has no content");
        assert_eq!(content.kind(), "section_content");
        assert_eq!(
            content.child(0).unwrap().kind(),
            "paragraph",
            "the lines below the heading folded into it: {section}"
        );
    }

    /// A blank line spelled with lone carriage returns still separates two
    /// paragraphs (tree-sitter-carve#143).
    #[test]
    fn lone_carriage_returns_separate_two_paragraphs() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let tree = parser.parse("a\r\rb\r", None).unwrap();
        let root = tree.root_node();
        assert!(!root.has_error(), "unexpected ERROR: {root}");
        assert_eq!(root.child_count(), 2, "want two paragraphs, got {root}");
        assert_eq!(root.child(0).unwrap().kind(), "paragraph");
        assert_eq!(root.child(1).unwrap().kind(), "paragraph");
    }

    /// Indentation still decides nesting in a lone-carriage-return document
    /// (tree-sitter-carve#143).
    ///
    /// This is the case the terminator alone does not buy. tree-sitter advances
    /// the row and resets the column on `\n` and on nothing else
    /// (`lib/src/lexer.c`, `ts_lexer__do_advance`), so `get_column` in a
    /// `\r`-terminated document counts from the start of the FILE - and this
    /// scanner decides a line start, a marker column and a block-opener margin
    /// by reading it. Delete `col_base` (make `line_column` return
    /// `get_column`) and this test fails while every LF fixture in the
    /// repository stays green.
    #[test]
    fn a_lone_carriage_return_document_still_nests_a_list() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let tree = parser.parse("- a\r  - b\r", None).unwrap();
        let root = tree.root_node();
        assert!(!root.has_error(), "unexpected ERROR: {root}");
        let list = root.child(0).expect("document has no child");
        assert_eq!(list.kind(), "list");
        assert_eq!(list.child_count(), 1, "want ONE outer item, got {root}");
        let content = list
            .child(0)
            .unwrap()
            .child_by_field_name("content")
            .unwrap();
        assert_eq!(
            content.child(1).map(|n| n.kind()),
            Some("list"),
            "the indented item did not nest: {root}"
        );
    }

    /// A CRLF document keeps a trailing block inside its list item.
    ///
    /// A REGRESSION GUARD, and it caught one. Making `\r` visible to the
    /// scanner means every place that used to step over a line terminator with
    /// one `advance` now steps over the `\r` only and stops short of the `\n`.
    /// `parse_indented_content_spacer` was such a place, and with it left
    /// unconverted this document's last paragraph escaped the item under CRLF
    /// while parsing correctly under LF - no corpus fixture could see it,
    /// because the corpus is normalized to LF.
    #[test]
    fn a_crlf_document_keeps_a_trailing_block_in_its_list_item() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let crlf = parser
            .parse("- a\r\n\r\n  {.c}\r\n\r\n  b\r\n", None)
            .unwrap();
        let lf = parser.parse("- a\n\n  {.c}\n\n  b\n", None).unwrap();
        assert!(!crlf.root_node().has_error());
        assert_eq!(
            crlf.root_node().to_sexp(),
            lf.root_node().to_sexp(),
            "CRLF and LF disagree"
        );
        assert_eq!(
            crlf.root_node().child_count(),
            1,
            "the trailing block escaped the item: {}",
            crlf.root_node()
        );
    }

    /// A WHITESPACE-ONLY line separates two block quotes, exactly as an empty
    /// one does (tree-sitter-carve#129).
    ///
    /// This lives here rather than in `test/corpus/carve.txt` because the whole
    /// meaning of the case IS the run of spaces on the middle line. A fixture
    /// file carrying it is one editor, one `.gitattributes` sweep or one
    /// formatter away from having that run trimmed, at which point the case
    /// becomes a duplicate of the empty-line one and keeps passing for the
    /// wrong reason.
    ///
    /// It discriminates: the blank-line flag is set after the entry block has
    /// consumed the line's leading whitespace, so it reads a whitespace-only
    /// line as blank. Set it before that consumption instead and this document
    /// goes back to one merged quote while every fixture in the corpus stays
    /// green.
    #[test]
    fn a_whitespace_only_line_separates_two_block_quotes() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let tree = parser.parse("> a\n   \n> b\n", None).unwrap();
        let root = tree.root_node();
        assert!(!root.has_error());
        assert_eq!(root.child_count(), 2, "want two siblings, got {}", root);
        assert_eq!(root.child(0).unwrap().kind(), "block_quote");
        assert_eq!(root.child(1).unwrap().kind(), "block_quote");
    }

    /// A marker line ending in a TRAILING SPACE is a content-less quote line,
    /// exactly as the bare `>` is (tree-sitter-carve#130).
    ///
    /// This lives here rather than in `test/corpus/carve.txt` for the reason
    /// tree-sitter-carve#121 established: the whole input IS the trailing
    /// space. In a fixture file one editor, one `.gitattributes` sweep or one
    /// formatter turns `> ` into `>`, at which point the case is a byte-for-byte
    /// duplicate of corpus 204 and passes forever without testing anything.
    ///
    /// It discriminates. Drop the newline arm from the separator branch of
    /// `scan_block_quote_marker` and every one of these documents goes back to
    /// two quotes, while `npm test` stays green - no corpus fixture can carry
    /// the input that tells them apart.
    #[test]
    fn a_trailing_space_marker_line_is_the_same_empty_quote() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        // The third is the same document with CRLF line endings, which
        // `.gitattributes` normalization would strip out of any fixture file.
        // It needs no carriage-return handling of its own - `advance` eats a
        // `\r` wherever it lands on one - but it fails with the rest under the
        // mutation above, so it is a real case rather than a control.
        for source in ["> \n> \n", "> \n> ", "> \r\n> \r\n"] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {:?}", source);
            assert_eq!(
                root.child_count(),
                1,
                "want ONE quote for {:?}, got {}",
                source,
                root
            );
            let quote = root.child(0).unwrap();
            assert_eq!(quote.kind(), "block_quote", "for {:?}", source);
            let markers = (0..quote.child_count() as u32)
                .filter(|i| quote.child(*i).unwrap().kind() == "block_quote_marker")
                .count();
            assert_eq!(
                markers, 2,
                "want both marker lines in one quote for {:?}, got {}",
                source, quote
            );
        }
    }

    /// A marker line stays content-less however WIDE its whitespace run is
    /// (tree-sitter-carve#135).
    ///
    /// tree-sitter-carve#130 fixed the single trailing space by taking the
    /// newline directly after the separator. A wider run - two spaces, or a
    /// space and a tab - fell past that arm and became a paragraph, so the same
    /// document parsed as `(paragraph) (block_quote_marker) (paragraph)` where
    /// carve-js returns the one empty blockquote it returns for `>` and `> `.
    ///
    /// Here rather than in `test/corpus/carve.txt` for the reason
    /// tree-sitter-carve#121 established and tree-sitter-carve#130 followed:
    /// the whole input IS the trailing whitespace, and one formatter or
    /// `.gitattributes` sweep turns these into `>` - at which point the case is
    /// a duplicate of corpus 204 and passes forever without testing anything.
    ///
    /// The tab row is not decoration. A run of spaces and a run containing a
    /// tab reach the probe differently, and an implementation that scanned for
    /// spaces alone would pass the first row and fail the second.
    #[test]
    fn a_wider_whitespace_run_is_still_a_content_less_marker_line() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for source in [
            ">  \n>  \n",
            "> \t\n> \t\n",
            ">   \n>   \n",
            "> \t \n> \t \n",
        ] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {:?}", source);
            assert_eq!(
                root.child_count(),
                1,
                "want ONE quote for {:?}, got {}",
                source,
                root
            );
            let quote = root.child(0).unwrap();
            assert_eq!(quote.kind(), "block_quote", "for {:?}", source);
            let markers = (0..quote.child_count() as u32)
                .filter(|i| quote.child(*i).unwrap().kind() == "block_quote_marker")
                .count();
            assert_eq!(
                markers, 2,
                "want both marker lines in one quote for {:?}, got {}",
                source, quote
            );
            assert!(
                !quote.to_sexp().contains("paragraph"),
                "the whitespace became a paragraph for {:?}: {}",
                source,
                quote
            );
        }
    }

    /// Indentation AFTER the separator still belongs to what follows, which is
    /// the constraint that kept tree-sitter-carve#135 out of #130.
    ///
    /// The probe reads the rest of the line to decide whether it is blank, so
    /// the risk is that the marker token swallows indentation a nested
    /// construct still needs. This is the control for that: it must keep
    /// parsing as a nested list inside the quote, not as one flat list.
    #[test]
    fn indentation_after_the_separator_still_nests() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        let tree = parser.parse("> - a\n>   - b\n", None).unwrap();
        let root = tree.root_node();
        assert!(!root.has_error(), "unexpected ERROR: {}", root);
        let sexp = root.to_sexp();
        assert!(sexp.contains("block_quote"), "want a quote, got {sexp}");
        assert!(
            sexp.matches("list").count() >= 2,
            "want a nested list inside the quote, got {sexp}"
        );
    }

    /// An empty quote written with trailing spaces continues nothing after it,
    /// the same rule the bare form follows (tree-sitter-carve#96 / #126).
    ///
    /// Here for the same reason as the case above - the input is only
    /// distinguishable from corpus 205 and 206 by its trailing spaces - and it
    /// is the half of tree-sitter-carve#130 a reader is most likely to check by
    /// hand: before the fix the tail landed INSIDE a second quote instead of
    /// beside the first.
    #[test]
    fn a_trailing_space_empty_quote_continues_nothing() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for (source, sibling) in [("> \n> \nx\n", "paragraph"), ("> \n> \n- b\n", "list")] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {:?}", source);
            assert_eq!(
                root.child_count(),
                2,
                "want a quote and a sibling for {:?}, got {}",
                source,
                root
            );
            assert_eq!(
                root.child(0).unwrap().kind(),
                "block_quote",
                "for {:?}",
                source
            );
            assert_eq!(root.child(1).unwrap().kind(), sibling, "for {:?}", source);
        }
    }

    /// Two NESTED marker lines written with trailing spaces are one inner
    /// quote, exactly as their bare spelling is (tree-sitter-carve#136).
    ///
    /// The bare spelling is corpus 216 and needs no help. This one lives here
    /// for the reason tree-sitter-carve#130 established: the whole input is
    /// distinguishable from that fixture only by its trailing spaces, which one
    /// editor, one `.gitattributes` sweep or one formatter turns back into the
    /// bare form - at which point the case is a byte-for-byte duplicate and
    /// passes forever without testing anything. The two spellings reach the
    /// deferral by different routes (the bare line's marker ends on its own
    /// newline, the trailing-space line's on the separator arm added by #130),
    /// so this is a real case rather than a control.
    ///
    /// It discriminates. Force `run_continues` to `false` in
    /// `parse_block_quote` and every one of these documents goes back to two
    /// inner quotes with a stray marker between them.
    #[test]
    fn two_nested_trailing_space_marker_lines_are_one_inner_quote() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        // The third is the same document with CRLF line endings, which
        // `.gitattributes` normalization would strip out of any fixture file.
        for source in ["> > \n> > \n", "> > \n> >\n", "> > \r\n> > \r\n"] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {:?}", source);
            assert_eq!(
                root.child_count(),
                1,
                "want ONE outer quote for {:?}, got {}",
                source,
                root
            );
            let outer = root.child(0).unwrap();
            assert_eq!(outer.kind(), "block_quote", "for {:?}", source);
            // Exactly one inner quote, and no stray marker beside it: the
            // defect built a second quote for the second marker line and left
            // the line's outer marker loose in the content between them.
            let content = outer
                .child_by_field_name("content")
                .unwrap_or_else(|| panic!("no content for {:?}", source));
            assert_eq!(
                content.named_child_count(),
                1,
                "want ONE child in the outer quote for {:?}, got {}",
                source,
                content
            );
            let inner = content.named_child(0).unwrap();
            assert_eq!(inner.kind(), "block_quote", "for {:?}", source);
            assert_eq!(
                inner.named_child_count(),
                3,
                "want both marker lines in one inner quote for {:?}, got {}",
                source,
                inner
            );
        }
    }

    /// A document that does not end with a newline is still ONE paragraph
    /// (tree-sitter-carve#124).
    ///
    /// This lives here rather than in `test/corpus/carve.txt` because the whole
    /// meaning of the case is a byte that is NOT there. A corpus fixture can
    /// carry it - omitting the blank line before the `---` divider hands the
    /// parser a document with no trailing newline, and that case does fail
    /// against the unfixed grammar with the shredded tree. It is still the
    /// wrong home: putting one blank line back before the divider, which is the
    /// shape every other case in the file already has, makes the very same case
    /// pass against the unfixed grammar. Measured both ways. The property the
    /// check turns on is invisible to anyone reading the fixture, so in a string
    /// literal it survives edits that a fixture file would not.
    ///
    /// It discriminates. Read `lexer->eof(lexer)` live in the final
    /// EOF_OR_NEWLINE branch of `tree_sitter_carve_external_scanner_scan`
    /// instead of the `at_eof` recorded at the top of the call, and every one of
    /// these documents shreds into one paragraph per character while `npm test`,
    /// the conformance sweep, the no-error sweep, the under-acceptance sweep and
    /// the block battery all stay green - every input any of them feeds ends
    /// with a newline.
    #[test]
    fn a_document_with_no_trailing_newline_is_one_paragraph() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        // The first is the shape the ticket reports. The rest are the same
        // defect without the indent: it was never about the leading space, only
        // about how far some probe had read when the document ran out.
        for source in [" x\ntail", "abcdef", "hello world", " x", "x\nabcdef"] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {:?}", source);
            assert_eq!(
                root.child_count(),
                1,
                "want ONE paragraph for {:?}, got {}",
                source,
                root
            );
            let paragraph = root.child(0).unwrap();
            assert_eq!(paragraph.kind(), "paragraph", "for {:?}", source);
            // Ranges, not just the count: a split that happened to leave one
            // child would otherwise pass while dropping most of the document.
            assert_eq!(paragraph.start_byte(), 0, "for {:?}", source);
            assert_eq!(
                paragraph.end_byte(),
                source.len(),
                "paragraph does not reach the end of {:?}",
                source
            );
        }
    }

    /// A PADDING slot on the admonition opener takes a space, and no tab.
    ///
    /// `resources/grammar.ebnf` PART 7, MARKER SEPARATORS AND PADDING SLOTS,
    /// splits the opener line into two roles. The whitespace right after `:::`
    /// is a MARKER SEPARATOR, because the token after it selects which of the
    /// four blocks the line opens. Once `admonition_type` has been read the
    /// block is DECIDED, so the `"title"` and `[label]` slots are ordinary
    /// padding. THE ROLES DIFFER, THE TERMINAL DOES NOT: a padding slot sits
    /// after the first non-whitespace character of the line, where a tab is not
    /// syntax, so `admonition_open = colon_fence:open, space, admonition_type,
    /// [space+, quoted_title], [space+, label]` spells all three with `space`
    /// and only the cardinality differs.
    ///
    /// This test asserted the OPPOSITE until markup-carve/tree-sitter-carve#160,
    /// and called itself the mutation guard for keeping it that way: carve#886
    /// had left the padding slots admitting a tab, and this grammar was written
    /// to that reading. carve#907 settled it the other way, corpus category 255
    /// carries the four cases, and a test defending the older answer is how a
    /// grammar rule stays deliberately looser than the language it models.
    ///
    /// THE DIRECTION THAT STILL NEEDS GUARDING IS CARDINALITY. The padding slot
    /// takes `space+`, a RUN, while the fence's own `[space]` slot takes exactly
    /// one - narrow the padding slot to one space and the last case here fails
    /// while every tab case above it keeps passing.
    ///
    /// It lives here rather than in `test/corpus/carve.txt` because the run case
    /// rots SILENTLY in a fixture: two spaces degrading to one builds the same
    /// tree, so the fixture would keep passing while testing nothing.
    #[test]
    fn a_padding_slot_takes_a_space_and_a_tab_makes_the_line_prose() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for source in [
            "::: note\t\"T\"\nx\n:::\n",
            "::: note \"T\"\t[l]\nx\n:::\n",
            "::: note\t[l]\nx\n:::\n",
            "::: note\t\"T\"\t[l]\nx\n:::\n",
        ] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            // A tab at either padding slot leaves the WHOLE line as prose - the
            // block never opens, which is the outcome PART 7 promises for a slot
            // that does not match. An ERROR here would be the other failure and
            // is asserted against above.
            assert_eq!(block.kind(), "paragraph", "for {source:?}");
        }

        // The run, and the one-space control beside it.
        for (source, want_title, want_label) in [
            ("::: note  \"T\"\nx\n:::\n", true, false),
            ("::: note \"T\"  [l]\nx\n:::\n", true, true),
            ("::: note \"T\" [l]\nx\n:::\n", true, true),
        ] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), "div", "for {source:?}");
            // The class alone is not enough: a narrowed padding token could end
            // the opener at the type word and still leave a `div` behind, with
            // the title silently demoted to body text.
            assert!(
                block.child_by_field_name("class").is_some(),
                "no class for {source:?}"
            );
            assert_eq!(
                block.child_by_field_name("title").is_some(),
                want_title,
                "title presence for {source:?}"
            );
            assert_eq!(
                block.child_by_field_name("label").is_some(),
                want_label,
                "label presence for {source:?}"
            );
        }
    }

    /// A whitespace-only tail leaves a BARE fence, tab or not.
    ///
    /// A CONTROL for the separator rule above, in the over-narrowing direction.
    /// `colon_fence_tail_opens_block` decides `bare` BEFORE it reads the
    /// separator's spelling, deliberately: whitespace with nothing after it is
    /// trailing whitespace, not a separator, so `:::` + tab + newline is the
    /// same bare fence `:::` is - both as an opener and as the closer that ends
    /// the block. Move the tab test ahead of the `bare` test and this document
    /// loses its div entirely.
    ///
    /// A fixture cannot carry it: a tab degrading to a space keeps the same
    /// tree, so the case would go on passing while testing nothing.
    #[test]
    fn a_whitespace_only_fence_tail_is_still_bare() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for source in [":::\nx\n:::\n", ":::\t\nx\n:::\t\n", "::: \nx\n::: \n"] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), "div", "for {source:?}");
        }
    }

    /// The code fence's slots take a space too, in two cardinalities.
    ///
    /// This asserted the OPPOSITE until markup-carve/tree-sitter-carve#160, and
    /// called itself a control in the blast-radius direction: carve#886 had left
    /// the code fence out of the colon fence's ruling deliberately, so this
    /// grammar kept what it did before and a test held it there. carve#907 and
    /// carve#912 closed the gap - `fenced_code_block = code_fence_open, [space],
    /// [code_fence_info]` and `code_fence_info = language_info, [space+,
    /// quoted_title], [space+, label]` - and corpus categories 258 and 263 carry
    /// the cases. A control that outlives the divergence it was written for is
    /// how a grammar rule stays deliberately looser than the language.
    ///
    /// THE CARDINALITY IS WHAT NEEDS GUARDING NOW, and it differs BETWEEN the
    /// two slots on the same line: the one before the info string takes exactly
    /// one space, the two inside it take a run. Sweep them together in either
    /// direction and one half of this test fails.
    #[test]
    fn a_code_fence_slot_takes_a_space_and_the_cardinality_differs() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        // A tab at any of the three slots leaves the whole line as prose.
        for source in [
            "```\tjs\nx\n```\n",
            "```js\t\"T\"\nx\n```\n",
            "```js \"T\"\t[L]\nx\n```\n",
            "```\t=html\nx\n```\n",
        ] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), "paragraph", "for {source:?}");
        }
        // The slot before the info string is `[space]`: a second space reaches
        // `language_info`, whose class holds no space, and the line is prose.
        // The two slots INSIDE the info string are `space+` and take the run.
        for (source, want) in [
            ("```  php\nx\n```\n", "paragraph"),
            ("```  =html\nx\n```\n", "paragraph"),
            ("``` js\nx\n```\n", "code_block"),
            ("```js\nx\n```\n", "code_block"),
            ("```js  \"T\"\nx\n```\n", "code_block"),
            ("```js \"T\"  [L]\nx\n```\n", "code_block"),
            ("```=html\nx\n```\n", "raw_block"),
            ("``` =html\nx\n```\n", "raw_block"),
        ] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), want, "for {source:?}");
        }
    }

    /// The frontmatter opener is the third site of the fence's `[space]` slot.
    ///
    /// `---<SP><SP>yaml` is not an opener: the second space reaches the language
    /// token. It is decided in `src/scanner.c`, because refusing it has to leave
    /// the LINE as prose and a rule in `grammar.js` can only fail into an ERROR -
    /// and it must not fall back to a thematic break either, since the line
    /// carries a word (corpus 264).
    #[test]
    fn a_frontmatter_opener_takes_one_space() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for (source, want) in [
            ("---  yaml\ntitle: T\n---\n\nbody\n", "paragraph"),
            ("---\tyaml\ntitle: T\n---\n\nbody\n", "paragraph"),
            ("--- yaml\ntitle: T\n---\n\nbody\n", "frontmatter"),
            ("---\ntitle: T\n---\n\nbody\n", "frontmatter"),
        ] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), want, "for {source:?}");
        }
    }
}
