#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = mkdtempSync(path.join(tmpdir(), 'carve-scanner-state-'));
try {
  const binary = path.join(build, 'scanner-serialization');
  const compile = spawnSync(
    process.env.CC || 'cc',
    ['-std=c11', '-Wall', '-Wextra', '-Isrc',
      'tests/scanner-serialization.c', '-o', binary],
    { cwd: root, encoding: 'utf8' },
  );
  if (compile.status !== 0) {
    process.stderr.write(compile.stderr || compile.stdout);
    process.exit(compile.status ?? 1);
  }
  const run = spawnSync(binary, [], { cwd: root, encoding: 'utf8' });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(build, { recursive: true, force: true });
}
