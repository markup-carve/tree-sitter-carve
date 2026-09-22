import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const wasmPath = resolve(process.argv[2] ?? "tree-sitter-carve.wasm");
const queryDirectory = new URL("../queries/", import.meta.url);
const queryFiles = (await readdir(queryDirectory))
  .filter((name) => name.endsWith(".scm"))
  .sort();
const querySources = new Map(
  await Promise.all(
    queryFiles.map(async (name) => [
      name,
      await readFile(new URL(name, queryDirectory), "utf8"),
    ]),
  ),
);
const sample = `# Heading

Text *strong* and _under_.

::: note
Inside
:::

\`\`\`js
const x = 1
\`\`\`
`;

const versions = [
  ["lowest", require("web-tree-sitter-lowest")],
  ["newest", require("web-tree-sitter-newest")],
];

let expectedCaptures;

for (const [label, module] of versions) {
  const Parser = module.Parser ?? module;

  await Parser.init();
  const Language = module.Language ?? Parser.Language;
  const language = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(language);

  const tree = parser.parse(sample);
  assert.equal(tree.rootNode.hasError, false, `${label} parse contains ERROR`);

  const queries = new Map(
    [...querySources].map(([name, source]) => [
      name,
      module.Query
        ? new module.Query(language, source)
        : language.query(source),
    ]),
  );
  const captures = queries
    .get("highlights.scm")
    .captures(tree.rootNode)
    .map(({ name, node }) => `${name}:${node.startIndex}-${node.endIndex}`);

  assert.equal(
    captures.length,
    21,
    `${label} returned an unexpected capture count`,
  );
  expectedCaptures ??= captures;
  assert.deepEqual(
    captures,
    expectedCaptures,
    `${label} returned different highlight captures`,
  );

  for (const query of queries.values()) query.delete?.();
  tree.delete();
  parser.delete();
  language.delete?.();
  console.log(
    `${label}: parsed without ERROR, compiled ${queries.size} queries, and returned 21 highlight captures`,
  );
}
