import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = mkdtempSync(path.join(tmpdir(), 'carve-qualification-work-'));
try {
  const executable = path.join(build, 'work');
  const compile = spawnSync(process.env.CC || 'cc', ['-std=c11', '-O2',
    '-I' + path.join(root, 'src'), path.join(root, 'tests/bracket-qualification-work.c'), '-o', executable],
  { encoding: 'utf8', timeout: 120_000 });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  process.stdout.write(run.stdout);
} finally {
  rmSync(build, { recursive: true, force: true });
}
