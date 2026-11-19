import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'corpus');

// Writes the input of every hand-written corpus case to its own file in `dir`
// and returns the paths.
export function writeCorpusCases(dir) {
  const files = [];
  for (const name of readdirSync(corpusDir).filter((file) => file.endsWith('.txt')).sort()) {
    const text = readFileSync(path.join(corpusDir, name), 'utf8');
    for (const match of text.matchAll(/^=+\n[^\n]*\n=+\n([\s\S]*?)\n-{3,}\n/gm)) {
      const file = path.join(dir, `case-${String(files.length).padStart(4, '0')}.crv`);
      writeFileSync(file, `${match[1]}\n`);
      files.push(file);
    }
  }
  return files;
}
