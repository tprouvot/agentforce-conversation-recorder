#!/usr/bin/env node
/**
 * Fails when a file of the repository mentions a denylisted term (customer names, program names, org domains,
 * agent names): the terms live outside the repository, in .afrec/denylist.txt (gitignored) or
 * ~/.afrec/denylist.txt, one per line.
 *
 *   node scripts/check-denylist.js            every tracked or new file
 *   node scripts/check-denylist.js --staged   the staged content only (what the pre-commit hook runs)
 *   node scripts/check-denylist.js --install  installs that pre-commit hook in .git/hooks
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadDenylist } from '../src/denylist.js';
import { denylistHits } from '../src/doctor/redact.js';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const args = process.argv.slice(2);

if (args.includes('--install')) {
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\n# installed by scripts/check-denylist.js --install\nexec node scripts/check-denylist.js --staged\n', { mode: 0o755 });
  console.log(`installed ${hook}`);
  process.exit(0);
}

const terms = loadDenylist(path.join(root, '.afrec'));
if (!terms.length) {
  console.log('no denylist (.afrec/denylist.txt or ~/.afrec/denylist.txt): nothing to check');
  process.exit(0);
}
const staged = args.includes('--staged');
const git = a => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const files = (staged ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']) : git(['ls-files', '--cached', '--others', '--exclude-standard']))
  .split('\n').filter(Boolean).filter(f => !/^node_modules\//.test(f));
let found = 0;
for (const file of files) {
  let text;
  try { text = staged ? git(['show', `:${file}`]) : fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
  if (text.includes('\u0000')) continue; // binary
  const hits = denylistHits(text, terms);
  if (!hits.length) continue;
  found++;
  console.error(`${file}: ${hits.join(', ')}`);
}
if (found) {
  console.error(`\n${found} file(s) mention denylisted terms: replace them with generic names before committing.`);
  process.exit(1);
}
console.log(`${files.length} file(s) checked against ${terms.length} denylisted term(s): clean`);
