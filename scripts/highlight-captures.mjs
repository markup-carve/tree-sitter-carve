/**
 * What `queries/highlights.scm` actually paints, resolved the way a consumer
 * resolves it.
 *
 * Every other check in this repo reads the PARSE TREE. The queries are the other
 * half of what this package ships - `vim-carve`, `helix-carve` and `zed-carve`
 * pin this repo and load these files - and nothing here read them at all. A
 * capture could name a node that no longer exists, or two patterns could claim
 * the same node with nobody deciding which wins, and every test stayed green.
 *
 * Resolution matters as much as matching, because a query file is not a list of
 * independent facts. Several patterns claim the same node, and what the editor
 * shows is the one with the highest `(#set! priority N)`, later patterns winning
 * a tie - the rule Neovim and Helix both implement, with 100 as the default.
 * Reporting every match instead (which is what `tree-sitter query` prints) would
 * call the composite-figure cases below green while the editor painted the
 * generic colour over them.
 *
 * Run: `node scripts/highlight-captures.mjs`
 */
import Parser from 'tree-sitter';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const Carve = require('../bindings/node');

const parser = new Parser();
parser.setLanguage(Carve);

/*
 * `#offset!` adjusts a capture's RANGE and is understood by the editors that
 * consume these queries, not by the node binding, which refuses to build a query
 * holding a directive it does not know. Stripping it leaves every pattern, every
 * capture and every `#set!` intact - only four range adjustments are lost, and
 * no case here asserts on a range. The alternative was to check a hand-copied
 * subset of the file, which is the shape of check this repo keeps finding
 * afterwards: it would have passed while the real file was broken.
 */
/*
 * EVERY QUERY FILE COMPILES, not only the one this script measures.
 *
 * `queries/` ships seven files and this script loaded one, so a capture naming
 * a node that no longer exists went unreported in the other six - and a query
 * that fails to build is not a degraded highlight, it is an editor that loads
 * NO textobjects, NO folds, NO injections for the language. Renaming one node
 * (`class_name` to `admonition_type`, markup-carve/tree-sitter-carve#245) broke
 * `textobjects.scm` and every gate in this repository stayed green.
 *
 * Building each one IS the check: `Parser.Query` refuses a pattern over a node
 * type the grammar does not have.
 */
const queryDir = resolve(__dirname, '../queries');
const strip = (text) => text.replace(/\(#offset![^)]*\)/g, '');
const broken = [];
for (const file of readdirSync(queryDir).filter((f) => f.endsWith('.scm')).sort()) {
    try {
        new Parser.Query(Carve, strip(readFileSync(resolve(queryDir, file), 'utf8')));
    } catch (error) {
        broken.push(`FAIL ${file} does not compile against this grammar\n   ${String(error.message).split('\n')[0]}`);
    }
}
if (broken.length) {
    console.log(`query files: ${broken.length} of the shipped set do not compile`);
    for (const line of broken) console.log(line);
    process.exit(1);
}

const raw = readFileSync(resolve(queryDir, 'highlights.scm'), 'utf8');
const source = strip(raw);
const query = new Parser.Query(Carve, source);

const DEFAULT_PRIORITY = 100;

/*
 * Captures that are not a COLOUR. `spell` and `nospell` mark a range for the
 * spell checker, `conceal` hides one, `none` clears an inherited highlight -
 * none of them is what an editor paints, and all of them land on the same nodes
 * the colour patterns do. Counting them made every generic-container row read
 * `nospell`, which is a true statement about the query file and not the question
 * being asked.
 */
const NOT_A_COLOUR = new Set(['spell', 'nospell', 'conceal', 'none']);

/**
 * The capture an editor would paint on the node at `row`/`column`.
 *
 * @param {string} text - the document to parse.
 * @param {number} row - zero-based line of the node's start.
 * @param {number} column - zero-based column of the node's start.
 * @returns {string|null} the winning capture name, or null if nothing claims it.
 */
function effectiveCapture(text, row, column) {
    const tree = parser.parse(text);
    let winner = null;
    let winningPriority = -Infinity;
    let winningPattern = -Infinity;

    /*
     * THE TIE IS BROKEN ON THE PATTERN'S POSITION IN THE QUERY FILE, which is
     * what "later patterns win a tie" means.
     *
     * It used to be broken on the index `matches()` handed out, and that index
     * is TREE order: it says which node came first in the document and nothing
     * about which pattern in `highlights.scm` wrote the capture. Two
     * equal-priority patterns therefore resolved by where their nodes happened
     * to sit, so the same query file could answer differently for two documents
     * that differ only in the order of two constructs. `match.pattern` is the
     * pattern's own position in the file, and it is the number the model this
     * script states is about.
     *
     * The current query file has no equal-priority pair that lands on one node,
     * so no case here changes answer - measured, in this repository and in
     * carve-grammars' copy of the same resolver. It is a latent defect rather
     * than a wrong reading today, and the fix is what keeps the next
     * equal-priority pattern from being graded by document order.
     */
    for (const match of query.matches(tree.rootNode)) {
        const priority = Number(query.setProperties?.[match.pattern]?.priority ?? DEFAULT_PRIORITY);
        for (const capture of match.captures) {
            // `@_name` captures are internal to a predicate and paint nothing.
            if (capture.name.startsWith('_')) continue;
            if (NOT_A_COLOUR.has(capture.name)) continue;
            const { startPosition } = capture.node;
            if (startPosition.row !== row || startPosition.column !== column) continue;
            if (priority > winningPriority
                || (priority === winningPriority && match.pattern >= winningPattern)) {
                winner = capture.name;
                winningPriority = priority;
                winningPattern = match.pattern;
            }
        }
    }

    return winner;
}

/*
 * Composite figures (PART 9 4c). Each case names the node by where it starts,
 * because the point is which of two same-looking kind words gets which colour.
 */
const CASES = [
    {
        // The note's own capture, which nothing else here would exercise: its
        // content highlights as ordinary inline whatever the note does, so a
        // query that never matched would look exactly like one that did.
        name: 'an inline note is captured as a whole',
        source: 'x ^[a note] c\n',
        at: [0, 2],
        expect: 'markup.link.label',
    },
    {
        name: 'a bare figure opener is a composite figure',
        source: '::: figure\n![one](a.png)\n^ (a) One\n:::\n^ Figure #: Group caption\n',
        at: [0, 4],
        expect: 'type.builtin',
    },
    {
        name: 'a quoted title keeps it a generic container',
        source: '::: figure "A titled figure div"\nx\n:::\n^ Not a group caption\n',
        at: [0, 4],
        expect: 'type',
    },
    {
        name: 'a [label] keeps it a generic container',
        source: '::: figure [g]\nx\n:::\n',
        at: [0, 4],
        expect: 'type',
    },
    {
        name: 'the outer opener of a nested pair is the group',
        source: '::: figure\n:::: figure\nx\n::::\n:::\n',
        at: [0, 4],
        expect: 'type.builtin',
    },
    {
        name: 'the inner opener of a nested pair is a generic container',
        source: '::: figure\n:::: figure\nx\n::::\n:::\n',
        at: [1, 5],
        expect: 'type',
    },
    {
        name: 'a bare opener one container deep inside a group is generic',
        source: '::: figure\n:::: note\n::::: figure\nx\n:::::\n::::\n:::\n',
        at: [2, 6],
        expect: 'type',
    },
    {
        name: 'a bare opener inside a quote inside a group is generic',
        source: '::: figure\n> quoted\n>\n> :::: figure\n> x\n> ::::\n:::\n',
        at: [3, 7],
        expect: 'type',
    },
    {
        name: 'a bare opener inside a list item inside a group is generic',
        source: '::: figure\n- item\n\n  :::: figure\n  x\n  ::::\n:::\n',
        at: [3, 7],
        expect: 'type',
    },
    {
        name: 'the intervening container itself keeps its own capture',
        source: '::: figure\n:::: note\n::::: figure\nx\n:::::\n::::\n:::\n',
        at: [1, 5],
        expect: 'type',
    },
    {
        name: 'a group inside another container kind is still a group',
        source: '::: note\n:::: figure\nx\n::::\n:::\n',
        at: [1, 5],
        expect: 'type.builtin',
    },
    {
        name: 'another kind word is a generic container',
        source: '::: note\nx\n:::\n',
        at: [0, 4],
        expect: 'type',
    },
    {
        // THE RESIDUAL THAT IS GONE. The demotion used to be three wildcard
        // chains in the query, and a bare opener reached through more levels
        // than that kept the group colour. Depth is free in the scanner, which
        // reads its own open-block stack, so a group four containers deep is
        // demoted like any other - and the tree says so, not just the paint.
        name: 'a bare opener four levels inside a group is still generic',
        source: '::: figure\n:::: note\n::::: note\n:::::: note\n::::::: figure\nx\n:::::::\n::::::\n:::::\n::::\n:::\n',
        at: [4, 8],
        expect: 'type',
    },
    {
        name: 'the group caption after the closing fence is a caption',
        source: '::: figure\nx\n:::\n^ Figure #: Group caption\n',
        at: [3, 2],
        expect: 'markup.italic',
    },

    /*
     * A PAYLOAD THAT IS NOT CARVE KEEPS THE MARKERS INSIDE IT INERT, asked of
     * the queries because a leak is a statement the QUERIES make: the payload
     * has to come back painted as its construct and not as the markup its
     * characters spell.
     *
     * Every row is a position where a `*b*` run sits inside a verbatim payload.
     * A leak puts an emphasis node there, and an emphasis node STARTS at that
     * column - which is the one thing the resolver above reports - so the row
     * reads `null` while the payload is inert and `punctuation.delimiter` the
     * moment it is not. The control below the block is the same run outside any
     * payload, so the rows cannot all pass by asking about a position nothing
     * ever claims.
     *
     * Each shape is one this repository got wrong
     * (markup-carve/tree-sitter-carve#248), and one sample per construct could
     * not find any of them: the bodies that leaked carry the construct's OWN
     * delimiter characters, and the plain sample carries none.
     */
    {
        name: 'a percent in a braced comment does not end its payload',
        source: 'a {% 50% off *b* %} z\n',
        at: [0, 13],
        expect: null,
    },
    {
        name: 'a brace in a braced comment does not end its payload',
        source: 'a {% a } b *b* %} z\n',
        at: [0, 11],
        expect: null,
    },
    {
        name: 'a hash in an editorial comment does not end its payload',
        source: 'a {# see #4 *b* #} z\n',
        at: [0, 12],
        expect: null,
    },
    {
        // The other half of the same row: 102 of the 286 generated bodies in
        // markup-carve/carve-grammars#320's sweep are written across a line
        // break, and every one of them coloured
        // (markup-carve/tree-sitter-carve#250). A `token()` cannot reach this
        // - the payload has to be a repetition inside the paragraph.
        name: 'an editorial comment written across a line break keeps its payload inert',
        source: 'a {# x\n*b* y #} z\n',
        at: [1, 0],
        expect: null,
    },
    {
        // And the container is why the widened token was the wrong shape: the
        // `> ` on the second line is stripped by the block machinery before
        // the payload sees it, which no token could do for itself.
        name: 'a quoted editorial comment keeps its payload inert across the break',
        source: '> a {# x\n> *b* y #} z\n',
        at: [1, 2],
        expect: null,
    },
    {
        name: 'a fence opener with a trailing space keeps its body inert',
        source: '```js \nx *b* y\n```\n',
        at: [1, 2],
        expect: null,
    },
    {
        name: 'a fence opener with a trailing tab keeps its body inert',
        source: '```js\t\nx *b* y\n```\n',
        at: [1, 2],
        expect: null,
    },
    {
        name: 'a raw opener with a trailing space keeps its body inert',
        source: '```=html \n<i>*b*</i>\n```\n',
        at: [1, 3],
        expect: null,
    },
    {
        name: 'an indented delimiter-shaped line does not end the payload',
        source: '```\n  ```\n*b*\n```\n',
        at: [2, 0],
        expect: null,
    },
    {
        // THE CONTROL for the seven rows above. Same run, no payload around it:
        // if `null` were the answer everywhere, none of them would be reading
        // anything.
        name: 'the same run outside a payload is emphasis',
        source: 'a *b* z\n',
        at: [0, 2],
        expect: 'punctuation.delimiter',
    },
    /*
     * MARKER SEPARATORS ARE RUNS (markup-carve/carve#1583 and #1587), read
     * here as what an editor PAINTS. The extents themselves are asserted in
     * scripts/marker-separators.mjs; these two rows are the consequence that
     * reaches a user - a caption whose marker stopped one space early
     * italicized the writer's column alignment along with the text.
     */
    {
        name: "a caption's content is painted from past the separator run",
        source: '![a](i.png)\n^   cap\n',
        at: [1, 4],
        expect: 'markup.italic',
    },
    {
        name: 'and no part of that run is painted as content',
        source: '![a](i.png)\n^   cap\n',
        at: [1, 2],
        expect: null,
    },
    {
        // The heading level is resolved from the MARKER'S TEXT, so widening
        // the marker to the whole run broke every `#eq?` in the file: `##   h`
        // fell back to the generic `markup.heading` and lost its level.
        name: "a heading's level survives a separator run",
        source: '##   h\n',
        at: [0, 0],
        expect: 'markup.heading.2',
    },

    /*
     * THE COLON FENCE'S SIGIL FAMILY, one row per member. The sigil is the only
     * character on the opener that says which container it is, and the body of
     * each already carries its own capture - so an unpainted sigil still looks
     * like a working query from inside the body, which is how all three stayed
     * unpainted while every other marker node in this file was covered.
     */
    {
        name: 'the line block sigil is painted',
        source: '::: |\na\n:::\n',
        at: [0, 4],
        expect: 'punctuation.special',
    },
    {
        name: 'the fenced block quote sigil is painted',
        source: '::: >\na\n:::\n',
        at: [0, 4],
        expect: 'punctuation.special',
    },
    {
        name: 'the local hard-break sigil is painted',
        source: '::: \\\na\n:::\n',
        at: [0, 4],
        expect: 'punctuation.special',
    },
];

const fails = [];
let pass = 0;

for (const { name, source: text, at, expect } of CASES) {
    const got = effectiveCapture(text, at[0], at[1]);
    if (got === expect) pass++;
    else fails.push(`FAIL ${name}\n   at ${at[0]}:${at[1]} the winning capture is ${got}, expected ${expect}`);
}

/*
 * The resolver has to answer both ways, or every row above passes without
 * reading anything: a position nothing claims must come back null, and a
 * capture name has to be able to be wrong.
 */
if (effectiveCapture('plain prose\n', 0, 0) !== null) {
    fails.push('FAIL control: the resolver claims a capture on plain prose');
} else pass++;

if (effectiveCapture('::: note\nx\n:::\n', 0, 4) === 'type.builtin') {
    fails.push('FAIL control: a plain `::: note` resolves to the composite-figure capture');
} else pass++;

if (fails.length) {
    console.log(`highlight captures: ${fails.length} failing`);
    for (const f of fails) console.log(f);
    process.exit(1);
}

console.log(`highlight captures: ${pass} checks pass across ${CASES.length} shapes`);
