import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = mkdtempSync(path.join(tmpdir(), 'carve-qualification-parser-work-'));
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
  writeFileSync(path.join(build, 'parser.c'), input('src/parser.c'));
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
    path.join(root, 'tests/bracket-qualification-parser-work.c'), path.join(build, 'parser.c'),
    path.join(build, 'scanner.c'), path.join(measuredRuntime, 'src/lib.c'), '-o', executable],
  { encoding: 'utf8', timeout: 120_000 });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  const run = spawnSync(executable, baseline ? ['baseline'] : [], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, (run.stderr || String(run.error)) + '\n' + run.stdout);
  process.stdout.write(run.stdout);
  console.log(baseline ? `Bracket qualification parser work: baseline ${baseline}.` : "Bracket qualification parser work: table-cell qualification stays linear; paragraph comments retain their baseline budgets.");
  
} finally {
  rmSync(build, { recursive: true, force: true });
}
