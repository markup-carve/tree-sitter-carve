/**
 * Every surface a release moves declares the same version.
 *
 * Run: `node scripts/version-surfaces.mjs [expected] [--root dir]`
 * `expected` defaults to package.json's version, which is what a rehearsal
 * compares against; the release workflow passes the tag.
 *
 * Two halves, so the list cannot drift. READERS names how each known manifest
 * spells its version. DISCOVERY then greps every tracked file for a version
 * declaration carrying the expected version, and fails on any file no reader
 * covers. A new manifest that carries the version is an error here until it
 * gets a reader, instead of a surface nobody compares.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const rootAt = args.indexOf('--root');
const root = rootAt >= 0 ? resolve(args[rootAt + 1]) : process.cwd();
const positional = args.filter((_, i) => rootAt < 0 || (i !== rootAt && i !== rootAt + 1));

const read = (file) => readFileSync(resolve(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const line = (file, re) => (read(file).match(re) ?? [])[1];

// A TOML reader takes the first `version` inside the named table only, so a
// dependency's version further down cannot answer for the package.
const tomlTable = (file, table) => {
    const text = read(file);
    const start = text.search(new RegExp(`^\\[${table.replace('.', '\\.')}\\]\\s*$`, 'm'));
    if (start < 0) return undefined;
    const rest = text.slice(start).split('\n').slice(1);
    for (const l of rest) {
        if (/^\[/.test(l)) return undefined;
        const m = l.match(/^version\s*=\s*"([^"]*)"/);
        if (m) return m[1];
    }
    return undefined;
};

const READERS = {
    'package.json': [['version', (f) => json(f).version]],
    'package-lock.json': [
        ['top-level version', (f) => json(f).version],
        ['packages[""].version', (f) => json(f).packages?.['']?.version],
    ],
    'tree-sitter.json': [['metadata.version', (f) => json(f).metadata?.version]],
    'Cargo.toml': [['[package] version', (f) => tomlTable(f, 'package')]],
    'pyproject.toml': [['[project] version', (f) => tomlTable(f, 'project')]],
    'Makefile': [['VERSION', (f) => line(f, /^VERSION\s*:?=\s*(\S+)/m)]],
};

const expected = (positional[0] ?? json('package.json').version).replace(/^v/, '');
const errors = [];

let compared = 0;
for (const [file, readers] of Object.entries(READERS)) {
    if (!existsSync(resolve(root, file))) {
        errors.push(`${file} is missing; every release surface has to exist`);
        continue;
    }
    for (const [what, get] of readers) {
        const got = get(file);
        compared += 1;
        if (got !== expected) {
            errors.push(`${file} (${what}) declares '${got ?? '(none)'}', expected '${expected}'`);
        }
    }
}

// DISCOVERY, for both the expected version and the one package.json holds, so
// a stale manifest nobody reads is found on a bump too. Files that mention a
// version without declaring the package's own are skipped: the changelog
// (checked by its own step) and the corpora.
const IGNORED = /^(CHANGELOG\.md|test\/|spec$|spec\/)/;
const versions = [...new Set([expected, json('package.json').version])];
const alternatives = versions.map((v) => v.replace(/\./g, '\\.')).join('|');
const declaration = new RegExp(`\\bversion\\b["']?\\s*[:=]+\\s*["']?v?(?:${alternatives})(?![\\d.])`, 'i');
let tracked = [];
try {
    tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
    errors.push('git ls-files failed; cannot look for unguarded version surfaces');
}
for (const file of tracked) {
    if (READERS[file] || IGNORED.test(file)) continue;
    let text;
    try {
        text = read(file);
    } catch {
        continue;
    }
    if (text.includes('\0')) continue;
    const hit = text.split('\n').findIndex((l) => declaration.test(l));
    if (hit >= 0) {
        errors.push(`${file}:${hit + 1} declares the package version but no reader compares it; add one to READERS`);
    }
}

if (errors.length) {
    for (const e of errors) console.log(`::error::${e}`);
    console.log(`version-surfaces: ${errors.length} problem(s) against ${expected}`);
    process.exit(1);
}
console.log(`version-surfaces: ${compared} surface(s) in ${Object.keys(READERS).length} file(s) agree on ${expected}; no unguarded declaration`);
