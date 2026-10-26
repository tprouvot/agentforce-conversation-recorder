/**
 * Selector packs: where they come from, which one applies to an org, and the healed overrides layered on top.
 *
 *   bundled     packs/*.json in this package
 *   downloaded  ~/.afrec/packs/*.json, written by `afrec selectors update` (wins over a bundled pack with the same id
 *               when its version is newer)
 *   overrides   <project>/.afrec/overrides.json: candidates the structural fallback found during a run, tried first,
 *               and flagged in every report until `afrec doctor` confirms them and `afrec selectors promote` turns
 *               them into a pack entry
 *
 * A pack applies from its minApiVersion; for an org at API version V the pack of that surface with the highest
 * minApiVersion <= V is used (the newest pack when V is unknown, e.g. a guest on a site).
 */
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, homeDir } from '../config.js';
import { loadSchema, validate } from '../schema.js';

export const BUNDLED_DIR = path.join(PACKAGE_ROOT, 'packs');

/** "Winter '27" for 68.0: three releases a year, Spring '24 being 60.0. */
export function releaseName(apiVersion) {
  const v = Math.floor(Number(apiVersion));
  if (!(v >= 30)) return null;
  const idx = v - 60;
  const season = ['Spring', 'Summer', 'Winter'][((idx % 3) + 3) % 3];
  const year = 24 + Math.floor(idx / 3) + (season === 'Winter' ? 1 : 0);
  return `${season} '${String(year).padStart(2, '0')}`;
}

/** Compares YYYY.MM.N versions. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** The problems of a pack against schema/pack.schema.json, plus regexes that do not compile. */
export function checkPack(pack) {
  const schema = loadSchema('pack');
  const problems = validate(pack, schema);
  for (const [name, element] of Object.entries(pack.elements || {})) {
    (element.candidates || []).forEach((c, i) => {
      for (const key of ['name', 'tagPattern', 'classPattern', 'text', 'title', 'label']) {
        if (c[key] === undefined) continue;
        try { new RegExp(c[key]); } catch (e) { problems.push(`elements.${name}.candidates[${i}].${key}: ${e.message}`); }
      }
    });
  }
  return problems;
}

function readPackDir(dir, origin) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'index.json').map(f => {
    const file = path.join(dir, f);
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    const problems = checkPack(pack);
    if (problems.length) throw new Error(`${file}: invalid selector pack: ${problems.slice(0, 3).join('; ')}`);
    return { ...pack, origin, file };
  });
}

/** Every known pack: bundled ones, and downloaded ones that are newer than the bundled pack of the same id. */
export function allPacks() {
  const bundled = readPackDir(BUNDLED_DIR, 'bundled');
  const downloaded = readPackDir(path.join(homeDir(), 'packs'), 'downloaded');
  const byId = new Map(bundled.map(p => [p.id, p]));
  for (const p of downloaded) {
    const current = byId.get(p.id);
    if (!current || compareVersions(p.version, current.version) > 0) byId.set(p.id, p);
  }
  return [...byId.values()];
}

/** The pack for a surface at an org's API version (null or undefined: the newest). */
export function selectPack(surface, apiVersion, packs = allPacks()) {
  const mine = packs.filter(p => p.surface === surface).sort((a, b) => a.minApiVersion - b.minApiVersion);
  if (!mine.length) throw new Error(`no selector pack for ${surface}`);
  if (!apiVersion) return mine[mine.length - 1];
  const fitting = mine.filter(p => p.minApiVersion <= Number(apiVersion));
  return fitting.length ? fitting[fitting.length - 1] : mine[0];
}

const overridesFile = stateDir => path.join(stateDir, 'overrides.json');

/** { [surface]: { elements: { [name]: candidate[] }, healedAt, apiVersion, confirmedAt, packVersion } } */
export function readOverrides(stateDir) {
  const file = overridesFile(stateDir);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`); }
}

export function writeOverrides(stateDir, overrides) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = overridesFile(stateDir);
  if (!Object.keys(overrides).length) { fs.rmSync(file, { force: true }); return; }
  fs.writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n');
}

/**
 * Records candidates the structural fallback found, so the next runs try them first.
 * @param {string} stateDir
 * @param {string} surface
 * @param {Record<string, any[]>} elements
 * @param {{ apiVersion?: number | null, packVersion?: string }} [meta]
 */
export function recordHealing(stateDir, surface, elements, { apiVersion, packVersion } = {}) {
  const overrides = readOverrides(stateDir);
  const entry = overrides[surface] || { elements: {} };
  for (const [name, candidates] of Object.entries(elements)) entry.elements[name] = candidates.map(c => ({ ...c, source: 'healed' }));
  Object.assign(entry, { healedAt: new Date().toISOString(), apiVersion: apiVersion || entry.apiVersion || null, packVersion: packVersion || null, confirmedAt: null });
  overrides[surface] = entry;
  writeOverrides(stateDir, overrides);
  return entry;
}

/**
 * The pack a run uses: the selected pack with the project's overrides tried first. `healed` lists the elements that
 * run on healed candidates, which every report flags.
 */
export function effectivePack(surface, apiVersion, stateDir) {
  const base = selectPack(surface, apiVersion);
  const override = stateDir ? readOverrides(stateDir)[surface] : null;
  const elements = {};
  for (const [name, element] of Object.entries(base.elements)) elements[name] = { ...element, candidates: [...element.candidates] };
  const healed = [];
  if (override) {
    for (const [name, candidates] of Object.entries(override.elements || {})) {
      if (!elements[name]) continue;
      elements[name].candidates = [...candidates, ...elements[name].candidates];
      healed.push(name);
    }
  }
  return {
    id: base.id, surface, version: base.version, origin: base.origin, minApiVersion: base.minApiVersion,
    apiVersion: apiVersion || null, release: releaseName(apiVersion), elements, healed,
    confirmedAt: override ? override.confirmedAt || null : null,
  };
}

/** Candidates of an element (an empty list when the pack has no such element). */
export const candidatesOf = (pack, name) => (pack.elements[name] ? pack.elements[name].candidates : []);
