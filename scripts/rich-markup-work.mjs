import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { endings, richMarkupInput } from './rich-markup-input.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const families = JSON.parse(readFileSync(path.join(root, 'tests/rich-markup-families.json'), 'utf8'));
const build = mkdtempSync(path.join(tmpdir(), 'carve-rich-markup-work-'));
const baseline = process.argv[2] === '--baseline' ? process.argv[3] : null;
assert.ok(process.argv.length === 2 || baseline, 'Use --baseline <commit>.');
const runtime = path.join(root, 'node_modules/tree-sitter/vendor/tree-sitter/lib');
try {
  function input(file) {
    if (!baseline) return readFileSync(path.join(root, file), 'utf8');
    const result = spawnSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  const source = input('src/scanner.c');
  const parserSource = input('src/parser.c');
  writeFileSync(path.join(build, 'parser.c'), parserSource);
  function blob(source) {
    const result = spawnSync('git', ['hash-object', '--stdin'], { input: source, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  const needle = '  s->advances++;';
  assert.equal(source.split(needle).length, 2, 'Instrument the scanner advance function exactly once.');
  writeFileSync(path.join(build, 'scanner.c'), 'unsigned long long carve_scanner_advances;\n' +
    source.replace(needle, needle + '\n  ++carve_scanner_advances;'));
  const measuredRuntime = path.join(build, 'runtime');
  cpSync(runtime, measuredRuntime, { recursive: true });
  const lexerPath = path.join(measuredRuntime, 'src/lexer.c');
  const lexer = readFileSync(lexerPath, 'utf8');
  const lexerAdvance = 'static void ts_lexer__do_advance(Lexer *self, bool skip) {';
  assert.equal(lexer.split(lexerAdvance).length, 2, 'Instrument runtime advances exactly once.');
  writeFileSync(lexerPath, 'unsigned long long carve_lexer_advances;\n' +
    lexer.replace(lexerAdvance, lexerAdvance + '\n  ++carve_lexer_advances;'));
  const executable = path.join(build, 'work');
  const compile = spawnSync(process.env.CC || 'cc', ['-std=c11', '-O0', '-D_DEFAULT_SOURCE',
    '-I' + path.join(root, 'src'), '-I' + path.join(runtime, 'include'), '-I' + path.join(runtime, 'src'),
    path.join(root, 'tests/rich-markup-work.c'), path.join(build, 'parser.c'),
    path.join(build, 'scanner.c'), path.join(measuredRuntime, 'src/lib.c'), '-o', executable],
  { encoding: 'utf8', timeout: 120_000 });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  const cases = [];
  for (let family = 0; family < families.length; ++family)
    for (let ending = 0; ending < endings.length; ++ending)
      for (const n of [32, 64, 128, 256]) cases.push({ family, ending, n });
  const chunks = [];
  const count = Buffer.alloc(4); count.writeUInt32LE(cases.length); chunks.push(count);
  for (const c of cases) {
    const source = Buffer.from(richMarkupInput(families[c.family], c.n, endings[c.ending]));
    const header = Buffer.alloc(16);
    [c.family, c.n, c.ending, source.length].forEach((v, i) => header.writeUInt32LE(v, i * 4));
    chunks.push(header, source);
  }
  const inputs = path.join(build, 'inputs.bin');
  writeFileSync(inputs, Buffer.concat(chunks));
  const run = spawnSync(executable, [inputs], { encoding: 'utf8', timeout: 360_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(run.status, 0, (run.stderr || String(run.error)) + '\n' + run.stdout);
  const rowsByCase = new Map();
  const pattern = /^family=(\d+) n=(\d+) ending=(\d+) bytes=(\d+) scanner=(\d+) lexer=(\d+) micros=(\d+) status=(\w+) p=(\d+) span=(\d+) strong=(\d+) em=(\d+) code=(\d+) bi=(\d+)$/;
  const rows = run.stdout.trim().split('\n').map((line, i) => {
    const m = pattern.exec(line); assert.ok(m, line);
    const keys = ['family', 'n', 'ending', 'bytes', 'scanner', 'lexer', 'micros', 'status', 'p', 'span', 'strong', 'em', 'code', 'bi'];
    const row = Object.fromEntries(keys.map((k, j) => [k, k === 'status' ? m[j + 1] : Number(m[j + 1])]));
    assert.deepEqual({ family: row.family, n: row.n, ending: row.ending }, cases[i]);
    assert.notEqual(row.status, 'timeout', JSON.stringify(row));
    assert.equal(row.status, baseline && families[row.family].baselineError ? 'error' : 'ok', JSON.stringify(row));
    if (!baseline || !families[row.family].baselineError) {
      for (const [kind, expected] of Object.entries(families[row.family].counts)) {
        assert.equal(row[kind], expected === 'n' ? row.n : expected, JSON.stringify({ kind, row }));
      }
    }
    if (!baseline) {
      const factor = families[row.family].model === 'linear' ? 1 : row.n;
      assert.ok(row.scanner <= 32 * row.bytes * factor, JSON.stringify(row));
      assert.ok(row.lexer <= (factor === 1 ? 64 : 128) * row.bytes * factor, JSON.stringify(row));
      const previous = rowsByCase.get(`${row.family}:${row.ending}`);
      if (previous) for (const metric of ['scanner', 'lexer']) {
        assert.ok(row[metric] <= previous[metric] * (factor === 1 ? 3 : 5), JSON.stringify({ previous, row }));
      }
      rowsByCase.set(`${row.family}:${row.ending}`, row);
    }
    return row;
  });
  assert.equal(rows.length, cases.length);
  console.log(JSON.stringify({ baseline: baseline || null, runtime: JSON.parse(readFileSync(path.join(root, 'node_modules/tree-sitter/package.json'))).version,
    compiler: process.env.CC || 'cc', compilerFlags: ['-std=c11', '-O0', '-D_DEFAULT_SOURCE'],
    sourceBlobs: { scanner: blob(source), parser: blob(parserSource) },
    budgets: { linear: { scannerPerByte: 32, lexerPerByte: 64, doubling: 3 },
      quadratic: { scannerPerBytePerRepetition: 32, lexerPerBytePerRepetition: 128, doubling: 5 } },
    sizes: [32, 64, 128, 256], endings, families, rows }, null, 2));

} finally {
  rmSync(build, { recursive: true, force: true });
}
