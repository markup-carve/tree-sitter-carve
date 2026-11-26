#!/usr/bin/env node
// Builds tests/bracket-growth-driver.c against the vendored runtime at -O2, the
// level the CLI builds the scanner at, and runs it (#770).
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = path.join(root, 'node_modules', 'tree-sitter', 'vendor', 'tree-sitter', 'lib');

const build = mkdtempSync(path.join(tmpdir(), 'carve-bracket-growth-'));
try {
  const binary = path.join(build, 'bracket-growth');
  const compile = spawnSync(process.env.CC || 'cc', [
    '-D_GNU_SOURCE', '-std=c11', '-O2',
    `-I${path.join(ts, 'include')}`, `-I${path.join(ts, 'src')}`, '-Isrc',
    'tests/bracket-growth-driver.c', path.join(ts, 'src', 'lib.c'),
    'src/parser.c', 'src/scanner.c', '-o', binary,
  ], { cwd: root, encoding: 'utf8' });
  if (compile.status !== 0) {
    process.stderr.write(compile.stderr || compile.stdout);
    process.exit(compile.status ?? 1);
  }
  const run = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 600_000 });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(build, { recursive: true, force: true });
}
