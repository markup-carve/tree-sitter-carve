#!/usr/bin/env node
// WHERE A MARKER ENDS AND ITS CONTENT BEGINS.
//
// Every other gate in this repository reads the SHAPE of the tree: which nodes
// were built, whether an ERROR appeared, how many blocks a document has. None
// of them reads a node's EXTENT, and a tree-sitter grammar's whole deliverable
// is extents - an editor colours, folds and selects by them.
//
// That blind spot hid markup-carve/tree-sitter-carve#257 for as long as it
// existed. `^` + three spaces + `cap` built a `caption_marker` over `^ ` and a
// `caption_content` over `<SP><SP>cap`, so an editor italicized the writer's
// column alignment. The tree had the right node types in the right order and no
// ERROR, so `tree-sitter test`, the corpus conformance run, the battery and the
// under-acceptance sweep all called it correct - and all four were reading a
// question this file is the only one to ask.
//
// The rule, twice, at two markers (markup-carve/carve#1583 for the caption and
// markup-carve/carve#1587 for the heading): a marker's separator is a RUN of
// ASCII spaces, ALL of it belongs to the marker, and the first character that
// is not a space begins the content. PART 2's MARKER SEPARATORS AND PADDING
// SLOTS rules that a writer aligning in a column "is writing separator, not
// content", and PART 11 §1 lets `fmt` normalize marker alignment - which holds
// only if the run is not content. `space = ' '`, so a TAB is content, and a tab
// where the separator should be opens no construct at all.
//
// MARKER REQUIRES CONTENT (PART 2) is the other half: a marker, its separator
// and nothing but whitespace opens nothing, and the line is paragraph text.
//
// THE DISCRIMINATING CASE IS A RUN OF TWO OR MORE. A single-space separator
// cannot see this bug: `^ cap` has the same extents under both readings, which
// is why it is carried below as a control rather than left out.
//
// Run: `node scripts/marker-separators.mjs`
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Parser = require('tree-sitter');
const Carve = require('../bindings/node');

const parser = new Parser();
parser.setLanguage(Carve);

/**
 * The first descendant of `type`, in document order.
 *
 * @param {object} node - the node to search under, itself included.
 * @param {string} type - the node type wanted.
 * @returns {object|null} the node, or null when the tree holds none.
 */
function firstOfType(node, type) {
    if (node.type === type) return node;
    for (const child of node.namedChildren) {
        const hit = firstOfType(child, type);
        if (hit) return hit;
    }
    return null;
}

/**
 * Resolve a dotted path of node types against a parse of `source`.
 *
 * @param {string} source - the document to parse.
 * @param {string} path - node types, outermost first, e.g. `heading.marker`.
 * @returns {object|null} the innermost node, or null when any step is absent.
 */
function resolve(source, path) {
    let node = parser.parse(source).rootNode;
    for (const step of path.split('.')) {
        node = node && firstOfType(node, step);
        if (!node) return null;
    }
    return node;
}

// `expect` is the node's exact TEXT, which is its extent stated in a form a
// reader can check against the source; `null` means the tree must hold no such
// node at all.
const CASES = [
    // ---- caption: markup-carve/carve#1583 -------------------------------
    {
        name: "a caption's separator run is all marker",
        source: '![a](i.png)\n^   cap\n',
        path: 'caption.caption_marker',
        expect: '^   ',
    },
    {
        name: 'and none of that run is content',
        source: '![a](i.png)\n^   cap\n',
        path: 'caption.caption_content',
        expect: 'cap',
    },
    {
        // THE CONTROL for the pair above: the one-space spelling reads the same
        // under both the old rule and the new one, so a check that passed here
        // and nowhere else would be reading nothing.
        name: 'a one-space caption separator is the same marker either way',
        source: '![a](i.png)\n^ cap\n',
        path: 'caption.caption_marker',
        expect: '^ ',
    },
    {
        name: 'a tab after the run is caption content, not separator',
        source: '![a](i.png)\n^ \tcap\n',
        path: 'caption.caption_content',
        expect: '\tcap',
    },
    {
        name: 'a tab in place of the run opens no caption',
        source: '![a](i.png)\n^\tcap\n',
        path: 'caption',
        expect: null,
    },
    {
        name: 'a caret whose run reaches the end of the line opens no caption',
        source: '> q\n\n^   \n',
        path: 'caption',
        expect: null,
    },
    {
        name: 'and the same holds where a caption would otherwise attach',
        source: '![a](i.png)\n^ \n',
        path: 'caption',
        expect: null,
    },
    {
        name: 'an indented caret is not a caption marker',
        source: ' ![a](i.png)\n ^ cap\n',
        path: 'caption',
        expect: null,
    },
    // ---- heading: markup-carve/carve#1587 -------------------------------
    {
        name: "a heading's separator run is all marker",
        source: '##   h\n',
        path: 'heading.marker',
        expect: '##   ',
    },
    {
        name: 'and none of that run is content',
        source: '##   h\n',
        path: 'heading.content',
        expect: 'h\n',
    },
    {
        // The same control the caption carries, at the other marker.
        name: 'a one-space heading separator is the same marker either way',
        source: '## h\n',
        path: 'heading.marker',
        expect: '## ',
    },
    {
        name: 'a tab after the run is heading content, not separator',
        source: '# \tx\n',
        path: 'heading.content',
        expect: '\tx\n',
    },
    {
        name: 'a tab in place of the run opens no heading',
        source: '#\tx\n',
        path: 'heading',
        expect: null,
    },
    {
        name: 'hashes whose run reaches the end of the line open no heading',
        source: '#   \n',
        path: 'heading',
        expect: null,
    },
];

const fails = [];
let pass = 0;

for (const { name, source, path, expect } of CASES) {
    const node = resolve(source, path);
    const got = node === null ? null : node.text;
    if (got === expect) {
        pass++;
        continue;
    }
    fails.push(
        `FAIL ${name}\n   ${path} is ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`,
    );
}

/*
 * The resolver has to be able to answer BOTH ways, or every `null` row above
 * passes without reading anything: an absent node must come back null, and a
 * present one must come back with its text.
 */
if (resolve('plain prose\n', 'caption') !== null) {
    fails.push('FAIL control: the resolver finds a caption in plain prose');
} else pass++;

if (resolve('# h\n', 'heading.marker')?.text !== '# ') {
    fails.push('FAIL control: the resolver cannot read a plain heading marker');
} else pass++;

if (fails.length) {
    console.log(`marker separators: ${fails.length} failing`);
    for (const f of fails) console.log(f);
    process.exit(1);
}

console.log(`marker separators: ${pass} checks pass across ${CASES.length} shapes`);
