import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = mkdtempSync(path.join(tmpdir(), 'carve-bracket-work-'));
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
  const executable = path.join(build, 'work');
  const compile = spawnSync(process.env.CC || 'cc', ['-std=c11', '-O0', '-D_DEFAULT_SOURCE',
    '-I' + path.join(root, 'src'), '-I' + path.join(runtime, 'include'), '-I' + path.join(runtime, 'src'),
    path.join(root, 'tests/literal-bracket-work.c'), path.join(build, 'parser.c'),
    path.join(build, 'scanner.c'), path.join(runtime, 'src/lib.c'), '-o', executable],
  { encoding: 'utf8', timeout: 120_000 });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  const run = spawnSync(executable, baseline ? ['baseline'] : [], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr + String(run.error));
  process.stdout.write(run.stdout);
  console.log(baseline ? `Literal brackets: baseline ${baseline}.` : 'Literal brackets: full-parser scanner work stays within 32 advances per input byte.');
} finally {
  rmSync(build, { recursive: true, force: true });
}
