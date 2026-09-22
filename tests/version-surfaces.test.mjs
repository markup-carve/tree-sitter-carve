// scripts/version-surfaces.mjs has to FAIL on each drift it claims to catch,
// not only pass on the real manifests. Each case copies the manifests into a
// scratch git repository, breaks one surface, and runs the guard there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(repo, 'scripts/version-surfaces.mjs');
const MANIFESTS = ['package.json', 'package-lock.json', 'tree-sitter.json', 'Cargo.toml', 'pyproject.toml', 'Makefile'];
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;

function scratch(mutate = () => {}) {
    const dir = mkdtempSync(join(tmpdir(), 'version-surfaces-'));
    for (const f of MANIFESTS) copyFileSync(join(repo, f), join(dir, f));
    mutate(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    return dir;
}

function run(dir, ...args) {
    const r = spawnSync(process.execPath, [guard, ...args, '--root', dir], { encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    return r;
}

const editJson = (dir, file, edit) => {
    const p = join(dir, file);
    const data = JSON.parse(readFileSync(p, 'utf8'));
    edit(data);
    writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
};

test('the real manifests pass', () => {
    const r = run(scratch());
    assert.equal(r.status, 0, r.stdout);
});

test('a lock whose top-level version lags fails', () => {
    const r = run(scratch((d) => editJson(d, 'package-lock.json', (l) => { l.version = '0.0.1'; })));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /package-lock\.json \(top-level version\) declares '0\.0\.1'/);
});

test('a lock whose packages[""] version lags fails', () => {
    const r = run(scratch((d) => editJson(d, 'package-lock.json', (l) => { l.packages[''].version = '0.0.1'; })));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /package-lock\.json \(packages\[""\]\.version\) declares '0\.0\.1'/);
});

test('a tag the manifests do not carry fails every surface', () => {
    const r = run(scratch(), '99.0.0');
    assert.equal(r.status, 1);
    assert.equal((r.stdout.match(/::error::/g) ?? []).length, 7);
});

test('a tracked file declaring the version with no reader fails', () => {
    const r = run(scratch((d) => {
        mkdirSync(join(d, 'bindings'));
        writeFileSync(join(d, 'bindings/setup.cfg'), `[metadata]\nversion = ${version}\n`);
    }));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /bindings\/setup\.cfg:2 declares the package version but no reader compares it/);
});
