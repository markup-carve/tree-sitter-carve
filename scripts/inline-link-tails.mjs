import assert from 'node:assert/strict';
import Parser from 'tree-sitter';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parser = new Parser();
parser.setLanguage(require('../bindings/node'));
let checked = 0;
for (const newline of ['\n', '\r\n', '\r']) {
  for (const prefix of ['', '!']) {
    for (const quote of ['"', "'"]) {
      for (const body of [`a${newline}b`, `a\\z${newline}b`, `a\\${quote}${newline}b`]) {
        const title = `${quote}${body}${quote}`;
        const source = `${prefix}[a](/u ${title})${newline}`;
        const tree = parser.parse(source).rootNode;
        assert.equal(tree.hasError, false, JSON.stringify(source));
        const links = tree.descendantsOfType(prefix ? 'inline_image' : 'inline_link');
        assert.equal(links.length, 1, JSON.stringify(source));
        assert.equal(links[0].childForFieldName('destination').childForFieldName('title').text, title);
        checked++;
      }
    }
  }
  for (const marker of ['/', '*', '_', '~', '=']) {
    const source = `${marker}[a${marker}](/u)${newline}`;
    const tree = parser.parse(source).rootNode;
    assert.equal(tree.hasError, false, source);
    assert.equal(tree.descendantsOfType('inline_link').length, 1, source);
    for (const type of ['emphasis', 'strong', 'underline', 'strikethrough', 'highlighted']) {
      assert.equal(tree.descendantsOfType(type).length, 0, source);
    }
    checked++;
  }
}
console.log(`Inline link tails: ${checked} title and delimiter controls across LF, CRLF, and CR.`);

for (const newline of ['\n', '\r\n', '\r']) {
  for (const middle of ['', '# heading', '> quote', '::: note']) {
    for (const prefix of ['', '!']) {
      const source = `${prefix}[a](/u "t${newline}${middle}${newline}u")${newline}`;
      const tree = parser.parse(source).rootNode;
      assert.equal(tree.hasError, false, JSON.stringify(source));
      assert.equal(tree.descendantsOfType('inline_link').length, 0, source);
      assert.equal(tree.descendantsOfType('inline_image').length, 0, source);
    }
  }
}

for (const newline of ['\n', '\r\n', '\r']) {
  for (const marker of ['/', '*', '_', '~', '=']) {
    const source = `${marker}[a](/u "t${newline}${newline}u")${marker}${newline}`;
    const tree = parser.parse(source).rootNode;
    assert.equal(tree.hasError, false, JSON.stringify(source));
    assert.equal(tree.descendantsOfType('paragraph').length, 2, source);
    for (const type of ['emphasis', 'strong', 'underline', 'strikethrough', 'highlighted']) {
      assert.equal(tree.descendantsOfType(type).length, 0, source);
    }
  }
  for (const source of [`# [a](/u "t${newline}- u")${newline}`, `p${newline}^ [a](/u "t${newline}u")${newline}`]) {
    const tree = parser.parse(source).rootNode;
    assert.equal(tree.hasError, false, source);
    assert.equal(tree.descendantsOfType('inline_link').length, 0, source);
  }
  const quoted = parser.parse(`> [a](/u "t${newline}> u")${newline}`).rootNode;
  assert.equal(quoted.hasError, false);
  assert.equal(quoted.descendantsOfType('inline_link').length, 1);
  assert.equal(quoted.descendantsOfType('block_quote_marker').length, 2);
  assert.equal(quoted.descendantsOfType('link_title')[0].descendantsOfType('block_quote_marker').length, 1);
}

for (const newline of ['\n', '\r\n', '\r']) {
  const tree = parser.parse(`[a](/u "a\\${newline}b")${newline}`).rootNode;
  assert.equal(tree.hasError, false);
  assert.equal(tree.descendantsOfType('inline_link').length, 0);
  assert.equal(tree.descendantsOfType('hard_line_break').length, 1);
}
