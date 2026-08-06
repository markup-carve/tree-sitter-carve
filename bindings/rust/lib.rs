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
    /// A CONTROL, deliberately: no mutation of the closer's own tail test
    /// breaks it, because `advance` eats a carriage return wherever it finds
    /// one, so the tail test never sees a `\r` at all. It is here to keep the
    /// tail test honest if that ever changes - a CR reaching the tail test
    /// would make every closer in a CRLF document fence body instead. There is
    /// no CRLF fixture to carry it -- `.gitattributes` normalizes the repo to
    /// LF -- so the line endings live in a string literal.
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

    /// A PADDING slot on the admonition opener admits a tab.
    ///
    /// `resources/grammar.ebnf` PART 7, MARKER SEPARATORS AND PADDING SLOTS
    /// (normative since markup-carve/carve#886), splits the opener line into two
    /// roles. The whitespace right after `:::` is a MARKER SEPARATOR, because
    /// the token after it selects which of the four blocks the line opens; it is
    /// spelled `space` and a tab never satisfies it. Once `admonition_type` has
    /// been read the block is DECIDED, so the `"title"` and `[label]` slots are
    /// ordinary padding, spelled `whitespace`, and a tab is fine there.
    ///
    /// THIS IS THE MUTATION GUARD, and it is the reason the two roles are spelled
    /// differently rather than swept together. `grammar.js:1081`
    /// `_whitespace1: token.immediate(/[ \t]+/)` feeds these padding slots.
    /// Narrow it to `/ +/` - the blanket sweep that "fixes the tab everywhere" -
    /// and every case below fails while `test/corpus/carve.txt`'s four separator
    /// cases keep passing, which is exactly the direction a blanket sweep is
    /// wrong in.
    ///
    /// It lives here rather than in `test/corpus/carve.txt` because the whole
    /// meaning of each case IS the tab, and unlike the separator cases a tab
    /// that degrades to a SPACE here rots SILENTLY: `::: note "T"` builds the
    /// same tree, so the fixture would keep passing while testing nothing. The
    /// separator cases fail loudly under the same degradation - `::: note` opens
    /// a div where they expect a paragraph - which is what let them stay in the
    /// fixture file. Same reasoning as the trailing-whitespace cases above.
    #[test]
    fn a_padding_slot_admits_a_tab() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for (source, want_title, want_label) in [
            ("::: note\t\"T\"\nx\n:::\n", true, false),
            ("::: note \"T\"\t[l]\nx\n:::\n", true, true),
            ("::: note\t[l]\nx\n:::\n", false, true),
            ("::: note\t\"T\"\t[l]\nx\n:::\n", true, true),
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

    /// The code fence still takes a tab before its info string.
    ///
    /// A CONTROL in the blast-radius direction. The code fence was deliberately
    /// left out of the ruling that settled the colon fence: markup-carve/carve#886
    /// says so in as many words, `code_fence_info` still spells its metadata
    /// slots `space+`, and the implementations already split 3-1 on it. So it
    /// keeps whatever this grammar did before, and a sweep that tightens the
    /// colon fence must not travel here on the way past. Narrowing
    /// `grammar.js:1080` `_whitespace` from `[ \t]*` to spaces only fails this.
    #[test]
    fn a_tab_before_the_code_fence_info_string_is_unchanged() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::language())
            .expect("Error loading Carve language");
        for (source, want) in [
            ("```\tjs\nx\n```\n", "code_block"),
            ("``` js\nx\n```\n", "code_block"),
            ("```js\t\"T\"\nx\n```\n", "code_block"),
            ("```\t=html\nx\n```\n", "raw_block"),
        ] {
            let tree = parser.parse(source, None).unwrap();
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), want, "for {source:?}");
        }
    }
}
