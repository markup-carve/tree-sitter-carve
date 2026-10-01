import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Carve = require('../bindings/node');
const parser = new Parser();
parser.setLanguage(Carve);
function nodes(root, type) {
    return [root, ...root.namedChildren.flatMap((child) => nodes(child, type))].filter((node) => node.type === type);
}
let count = 0;
for (const prefix of ['# a ', '> # a ', '![alt](x.png)\n^ cap ', '> ![alt](x.png)\n> ^ cap ']) {
    for (const body of ['`x %% b` c', '``x %% b`` c', '!`x %% b` c', '$`x %% b` c', '`x %% b']) {
        const source = prefix + body + '\n\nplain tail\n';
        const tree = parser.parse(source);
        assert.equal(tree.rootNode.hasError, false, source);
        const at = source.indexOf('%%');
        const tail = source.indexOf('plain tail');
        for (const type of ['verbatim', 'inline_literal', 'math', 'trailing_comment']) {
            assert.ok(nodes(tree.rootNode, type).every((node) => node.endIndex <= tail), source);
        }
        assert.ok(['verbatim', 'inline_literal', 'math'].flatMap((type) => nodes(tree.rootNode, type)).some((n) => n.startIndex <= at && at < n.endIndex), source);
        assert.ok(!nodes(tree.rootNode, 'trailing_comment').some((n) => n.startIndex <= at && at < n.endIndex), source);
        count += 2;
    }
    for (const gap of [' ', '\t']) {
        const source = prefix + '`x`' + gap + '%% hidden\n';
        const tree = parser.parse(source);
        assert.ok(nodes(tree.rootNode, 'trailing_comment').some((n) => n.text.includes('hidden')), source);
        count++;
    }
}
console.log(`${count} heading and caption percent assertions passed`);
