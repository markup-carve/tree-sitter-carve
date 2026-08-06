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
            assert!(!root.has_error(), "unexpected ERROR for {source:?}");
            let block = root.child(0).expect("document has no child");
            assert_eq!(block.kind(), "code_block");
            let last = block.child(block.child_count() as u32 - 1).unwrap();
            assert_eq!(last.kind(), "code_block_marker_end", "for {source:?}");
            // The marker ends at the run. The tail peek walks past the
            // whitespace, so the scanner has to pin the token before it looks;
            // pinning after would stretch the marker over the trailing run, and
            // an S-expression corpus fixture records no byte ranges to notice.
            assert_eq!(
                last.end_byte() - last.start_byte(),
                3,
                "marker spans more than its run for {source:?}"
            );
        }
    }

    /// A CRLF document's fence closer still closes.
    ///
    /// The tail test that decides whether a fence run is a closer accepts a
    /// `\r` as end of line; without that, every closer in a CRLF document
    /// becomes fence body and the block runs to end of input. There is no CRLF
    /// fixture to pin it with -- `.gitattributes` normalizes `test/corpus` to
    /// LF -- so the line endings live in a string literal here.
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
}
