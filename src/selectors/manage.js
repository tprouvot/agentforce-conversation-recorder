/**
 * afrec selectors: list the packs, download newer ones (data only, schema-checked), promote confirmed healed
 * overrides into a pack, and check a pack file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { allPacks, checkPack, compareVersions, readOverrides, writeOverrides, selectPack, releaseName, BUNDLED_DIR } from './packs.js';
import { homeDir, PACKAGE_ROOT } from '../config.js';

/** Packs and the project's overrides, for `afrec selectors list` and the UI. */
export function packStatus(project) {
  const packs = allPacks().map(({ id, surface, version, minApiVersion, origin, verified }) => ({ id, surface, version, minApiVersion, origin, verified: verified || [] }));
  return { packs, overrides: readOverrides(project.stateDir) };
}

/**
 * Downloads index.json and the packs it lists from `baseUrl`, keeps the ones that are valid and newer than what is
 * installed, and saves them to ~/.afrec/packs. Returns [{ id, version, action }].
 */
export async function updatePacks(baseUrl) {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const get = async name => {
    const res = await fetch(new URL(name, base), { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${new URL(name, base).href}: HTTP ${res.status}`);
    return res.json();
  };
  const index = await get('index.json');
  const current = new Map(allPacks().map(p => [p.id, p]));
  const dir = path.join(homeDir(), 'packs');
  const out = [];
  for (const entry of index.packs || []) {
    if (!/^[\w@.-]+\.json$/.test(entry.file)) { out.push({ id: entry.id, action: `skipped: bad file name ${entry.file}` }); continue; }
    const have = current.get(entry.id);
    if (have && compareVersions(entry.version, have.version) <= 0) { out.push({ id: entry.id, version: have.version, action: 'up to date' }); continue; }
    const pack = await get(entry.file);
    const problems = checkPack(pack);
    if (problems.length) { out.push({ id: entry.id, action: `rejected: ${problems[0]}` }); continue; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, entry.file), JSON.stringify(pack, null, 2) + '\n');
    out.push({ id: pack.id, version: pack.version, action: have ? `updated from ${have.version}` : 'added' });
  }
  return out;
}

const nextVersion = current => {
  const d = new Date();
  const month = `${d.getFullYear()}.${d.getMonth() + 1}`;
  const [y, m, n] = String(current).split('.');
  return `${month}.${`${y}.${Number(m)}` === month ? Number(n) + 1 : 1}`;
};

/**
 * Turns the confirmed overrides of a surface into a pack entry: the healed candidates go first, the version is
 * bumped and the release recorded. In the tool's own repository the bundled pack is updated (ready for a pull
 * request); elsewhere the pack goes to ~/.afrec/packs (it applies at once) and a copy to .afrec/promoted/.
 * @param {{ stateDir: string }} project
 * @param {string} surface
 * @param {{ force?: boolean, writeBundled?: boolean }} [options] writeBundled: update packs/ (default: when in the tool's repository)
 */
export function promote(project, surface, { force = false, writeBundled } = {}) {
  const overrides = readOverrides(project.stateDir);
  const entry = overrides[surface];
  if (!entry || !Object.keys(entry.elements || {}).length) throw new Error(`no healed ${surface} locators to promote`);
  if (!entry.confirmedAt && !force) throw new Error(`the healed ${surface} locators are not confirmed yet: run afrec doctor (it confirms them when the chat works with them), or pass --force`);
  const base = selectPack(surface, entry.apiVersion);
  const { origin, file, ...pack } = JSON.parse(JSON.stringify(base));
  for (const [name, candidates] of Object.entries(entry.elements)) {
    if (!pack.elements[name]) continue;
    const fresh = candidates.map(({ source, ...c }) => ({ ...c, note: `found by the structural fallback on ${String(entry.healedAt).slice(0, 10)}${entry.apiVersion ? ` (API ${entry.apiVersion})` : ''}` }));
    const known = new Set(pack.elements[name].candidates.map(c => JSON.stringify({ ...c, note: undefined })));
    pack.elements[name].candidates = [...fresh.filter(c => !known.has(JSON.stringify({ ...c, note: undefined }))), ...pack.elements[name].candidates];
  }
  pack.version = nextVersion(pack.version);
  pack.verified = [...(pack.verified || []), { apiVersion: entry.apiVersion || null, release: releaseName(entry.apiVersion) || '', date: new Date().toISOString().slice(0, 10), by: entry.confirmedAt ? 'afrec doctor' : 'healing (unconfirmed)' }];
  const problems = checkPack(pack);
  if (problems.length) throw new Error(`the promoted pack would be invalid: ${problems[0]}`);
  const text = JSON.stringify(pack, null, 2) + '\n';
  const written = [];
  const inToolRepo = (writeBundled ?? fs.existsSync(path.join(PACKAGE_ROOT, '.git'))) && !!file && file.startsWith(BUNDLED_DIR);
  if (inToolRepo) { fs.writeFileSync(file, text); written.push(file); } else {
    const home = path.join(homeDir(), 'packs');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, `${pack.id}.json`), text);
    written.push(path.join(home, `${pack.id}.json`));
    const promoted = path.join(project.stateDir, 'promoted');
    fs.mkdirSync(promoted, { recursive: true });
    fs.writeFileSync(path.join(promoted, `${pack.id}.json`), text);
    written.push(path.join(promoted, `${pack.id}.json`));
  }
  delete overrides[surface];
  writeOverrides(project.stateDir, overrides);
  return { pack, written, inToolRepo };
}

/** Checks a pack file: schema and regexes. */
export function checkPackFile(file) {
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { pack, problems: checkPack(pack) };
}
