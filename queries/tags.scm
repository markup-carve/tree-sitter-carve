; Symbols for code navigation (tree-sitter tags, Helix and Mitos symbol pickers).
; Helix only recognizes a fixed set of definition kinds, so headings map to
; section, ids to field, and reference definitions to constant.

(heading
  content: (content) @name) @definition.section

(block_attribute
  args: (args
    (identifier) @name)) @definition.field

(inline_attribute
  (args
    (identifier) @name)) @definition.field

(link_reference_definition
  label: (link_label) @name) @definition.constant

(footnote
  label: (reference_label) @name) @definition.constant

(snippet_definition
  name: (snippet_name) @name) @definition.constant

; Collapsed references (`[ref][]`) are left out: their only text node keeps the
; brackets, so the name could never match the definition label.

(full_reference_link
  (link_label) @name) @reference.class

(full_reference_image
  (link_label) @name) @reference.class

(footnote_reference
  (reference_label) @name) @reference.class

(snippet_use
  name: (snippet_name) @name) @reference.class
