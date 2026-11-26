import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../node_modules/.bin/tree-sitter', import.meta.url).pathname;
const root = new URL('..', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'carve-meta-query-'));

function captures(query, source) {
  const path = join(dir, 'input.crv');
  writeFileSync(path, source);
  return execFileSync(cli, ['query', `queries/${query}.scm`, path], {
    cwd: root,
    encoding: 'utf8',
  });
}

for (const format of ['yaml', 'toml', 'json']) {
  const block = `a\n\n---${format}\nkey: value\n---\n`;
  const injection = captures('injections', block);
  assert.match(injection, /injection\.language/);
  assert.ok(injection.includes('text: `' + format + '`'));
  assert.match(injection, /injection\.content/);
  assert.match(captures('highlights', block), /markup\.raw\.block/);
  assert.match(captures('highlights', block), /punctuation\.delimiter/);
  assert.match(captures('folds', block), /capture: fold/);
}
const bare = captures('injections', '---\nkey: value\n---\n');
assert.match(bare, /injection\.content/);
assert.doesNotMatch(bare, /injection\.language/);
console.log('Later YAML, TOML and JSON frontmatter keep injection, highlight and fold captures.');
