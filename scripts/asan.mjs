#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseShortRun } from './participants.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = path.join(root, 'node_modules', 'tree-sitter', 'vendor', 'tree-sitter', 'lib');
const corpus = path.join(root, 'spec', 'tests', 'corpus');
const optimization = process.env.ASAN_OPTIMIZATION || '3';
if (!['2', '3'].includes(optimization)) throw new Error('ASAN_OPTIMIZATION must be 2 or 3');

const build = mkdtempSync(path.join(tmpdir(), 'carve-asan-'));
try {
  const generated = [
    ['div-400.crv', ':::: note\n'.repeat(400) + 'x\n'],
    ['quote-400.crv', '> '.repeat(400) + 'x\n'],
    ['list-400.crv', '- '.repeat(400) + 'x\n'],
  ];
  for (const [name, source] of generated) writeFileSync(path.join(build, name), source);
  const documents = readdirSync(corpus)
    .filter((name) => name.endsWith('.crv'))
    .map((name) => path.join(corpus, name));
  documents.push(...generated.map(([name]) => path.join(build, name)));
  refuseShortRun({
    label: 'ASAN CORPUS', actual: documents.length, atLeast: 1000,
    of: 'corpus and nesting document(s)',
    hint: 'initialize the spec submodule before running the sanitizer.',
  });

  const binary = path.join(build, 'asan-driver');
  const compile = spawnSync(process.env.CC || 'cc', [
    '-D_GNU_SOURCE', '-std=c11', '-g', `-O${optimization}`,
    '-fsanitize=address', '-fno-omit-frame-pointer',
    `-I${path.join(ts, 'include')}`, `-I${path.join(ts, 'src')}`, '-Isrc',
    'tests/asan-driver.c', path.join(ts, 'src', 'lib.c'),
    'src/parser.c', 'src/scanner.c', '-o', binary,
  ], { cwd: root, encoding: 'utf8' });
  if (compile.status !== 0) {
    process.stderr.write(compile.stderr || compile.stdout);
    process.exit(compile.status ?? 1);
  }
  const run = spawnSync(binary, documents, {
    cwd: root, encoding: 'utf8', timeout: 300_000,
    env: { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:halt_on_error=1' },
  });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(build, { recursive: true, force: true });
}
