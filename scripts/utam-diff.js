#!/usr/bin/env node
/**
 * Maintenance only, never at run time: an early warning from Salesforce's own page objects. UTAM's
 * salesforce-pageobjects package is updated for each Salesforce release and describes the Agentforce panel
 * (runtime_copilot, runtime_copilot_base). This script downloads the newest version, extracts the panel's
 * selectors, and compares them with the Lightning selector pack and with the last reviewed state
 * (scripts/utam-baseline.json):
 *
 *   - a pack candidate taken from UTAM (source: "utam") that UTAM no longer has: the panel changed, review the pack
 *   - the panel's selectors changed since the baseline: Salesforce reworked the panel, run afrec doctor on a preview
 *     sandbox
 *
 * Exit code: 0 nothing changed, 1 something to review (the weekly GitHub Action opens an issue), 2 error.
 * `--update` records the current state as reviewed. `--markdown` prints the report as Markdown.
 *
 * Only the few selectors the pack relies on and a hash of the rest are stored, not UTAM's content.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { selectPack } from '../src/selectors/packs.js';

const BASELINE = new URL('./utam-baseline.json', import.meta.url);
const args = process.argv.slice(2);
const markdown = args.includes('--markdown');
const sh = (cmd, a, cwd) => execFileSync(cmd, a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' }).trim();

function download() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-utam-'));
  const wanted = (args.find(a => a.startsWith('--version=')) || '').split('=')[1];
  const versions = wanted ? [wanted] : JSON.parse(sh('npm', ['view', 'salesforce-pageobjects', 'versions', '--json'])).reverse();
  for (const v of versions.slice(0, 5)) { // a registry with a minimum release age refuses the newest ones: try older
    try {
      const file = sh('npm', ['pack', `salesforce-pageobjects@${v}`, '--silent'], tmp).split('\n').pop();
      sh('tar', ['-xzf', file], tmp);
      return { version: v, dir: path.join(tmp, 'package') };
    } catch { /* next */ }
  }
  throw new Error('could not download salesforce-pageobjects');
}

/** Every `selector.css` of the panel's UTAM page objects (dist/<namespace>/*.utam.json), with its page object. */
function selectorsOf(dir) {
  const out = new Map();
  const walk = (node, source) => {
    if (Array.isArray(node)) { node.forEach(n => walk(n, source)); return; }
    if (!node || typeof node !== 'object') return;
    if (node.selector && typeof node.selector.css === 'string') out.set(node.selector.css, source);
    Object.values(node).forEach(v => walk(v, source));
  };
  for (const ns of ['runtime_copilot', 'runtime_copilot_base']) {
    const folder = path.join(dir, 'dist', ns);
    if (!fs.existsSync(folder)) continue;
    for (const f of fs.readdirSync(folder).filter(x => x.endsWith('.utam.json'))) {
      try { walk(JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')), `${ns}/${f.replace(/\.utam\.json$/, '')}`); } catch { /* skip a file that does not parse */ }
    }
  }
  return out;
}

function main() {
  const { version, dir } = download();
  const utam = selectorsOf(dir);
  const all = [...utam.keys()].sort();
  const hash = crypto.createHash('sha256').update(all.join('\n')).digest('hex').slice(0, 16);
  const pack = selectPack('lightning', null);
  const fromUtam = Object.entries(pack.elements).flatMap(([name, el]) => el.candidates.filter(c => c.source === 'utam' && c.css).map(c => ({ name, css: c.css })));
  const gone = fromUtam.filter(c => !utam.has(c.css));
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  const relied = fromUtam.map(c => c.css);
  const changed = baseline && baseline.hash !== hash;
  const lines = [
    `UTAM salesforce-pageobjects ${version}: ${all.length} selectors in the Agentforce panel's page objects (hash ${hash})`,
    baseline ? `last reviewed: ${baseline.version} (hash ${baseline.hash})${changed ? ': CHANGED since' : ': unchanged'}` : 'no baseline yet (run with --update)',
    `pack ${pack.id} ${pack.version} takes ${fromUtam.length} candidate(s) from UTAM${gone.length ? `; ${gone.length} no longer in UTAM:` : ', all still in UTAM'}`,
    ...gone.map(c => `  - ${c.name}: ${c.css}`),
  ];
  if (changed) lines.push('', 'Salesforce changed the panel\'s page objects: run `afrec doctor` on a preview sandbox, then `afrec heal` if anything is missing.');
  console.log(markdown ? `## UTAM watch\n\n${lines.map(l => (l.startsWith('  - ') ? l.trim() : l)).join('\n\n')}\n` : lines.join('\n'));
  if (args.includes('--update')) {
    fs.writeFileSync(BASELINE, JSON.stringify({ version, hash, relied, reviewedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
    console.log(`baseline updated: ${new URL(BASELINE).pathname}`);
    return 0;
  }
  return gone.length || changed || !baseline ? 1 : 0;
}

try { process.exitCode = main(); } catch (e) { console.error(`utam-diff: ${e.message}`); process.exitCode = 2; }
