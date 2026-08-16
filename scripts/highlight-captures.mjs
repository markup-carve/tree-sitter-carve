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
import { readFileSync } from 'node:fs';
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
const raw = readFileSync(resolve(__dirname, '../queries/highlights.scm'), 'utf8');
const source = raw.replace(/\(#offset![^)]*\)/g, '');
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
    let winningIndex = -Infinity;

    query.matches(tree.rootNode).forEach((match, index) => {
        const priority = Number(query.setProperties?.[match.pattern]?.priority ?? DEFAULT_PRIORITY);
        for (const capture of match.captures) {
            // `@_name` captures are internal to a predicate and paint nothing.
            if (capture.name.startsWith('_')) continue;
            if (NOT_A_COLOUR.has(capture.name)) continue;
            const { startPosition } = capture.node;
            if (startPosition.row !== row || startPosition.column !== column) continue;
            if (priority > winningPriority || (priority === winningPriority && index >= winningIndex)) {
                winner = capture.name;
                winningPriority = priority;
                winningIndex = index;
            }
        }
    });

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
        name: 'the group caption after the closing fence is a caption',
        source: '::: figure\nx\n:::\n^ Figure #: Group caption\n',
        at: [3, 2],
        expect: 'markup.italic',
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
