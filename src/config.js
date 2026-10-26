/**
 * The project: the folder holding afrec.config.json (searched upward from the working directory, else the working
 * directory itself), its settings with defaults filled in, and the tool's own folders.
 *
 *   <project>/.afrec/            local state, gitignored: overrides.json (healed selectors), doctor/, heal/, baseline
 *   ~/.afrec/packs/              selector packs downloaded by `afrec selectors update` (AFREC_HOME moves ~/.afrec)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from './schema.js';

export const CONFIG_FILE = 'afrec.config.json';
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PACKS_URL = 'https://raw.githubusercontent.com/tprouvot/agentforce-conversation-recorder/main/packs/';

const DEFAULTS = {
  scenarios: 'scenarios',
  recordings: '.local/recordings',
  defaults: {},
  parallel: 3,
  baseline: null,
  checks: { gifMaxBytes: 15000000, videoSlackSeconds: 3, minBytesPerMegapixel: 7000 },
  doctor: { canary: ['Hi', 'What can you help me with?'] },
  packsUrl: DEFAULT_PACKS_URL,
};

/** The folder holding afrec.config.json, from `start` upward; null when there is none. */
export function findProjectDir(start = process.cwd()) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * @param {{ dir?: string, file?: string }} [options] an explicit config file, or the folder to start the search from
 */
export function loadProject(options = {}) {
  const file = options.file ? path.resolve(options.file) : (() => { const d = findProjectDir(options.dir); return d ? path.join(d, CONFIG_FILE) : null; })();
  const dir = file ? path.dirname(file) : path.resolve(options.dir || process.cwd());
  let user = {};
  if (file) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file}: ${e.message}`); }
    const problems = validate(user, loadSchema('config'));
    if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  }
  const config = {
    ...DEFAULTS, ...user,
    checks: { ...DEFAULTS.checks, ...(user.checks || {}) },
    doctor: { ...DEFAULTS.doctor, ...(user.doctor || {}) },
  };
  return {
    dir,
    file,
    config,
    scenariosDir: path.resolve(dir, config.scenarios),
    recordingsDir: path.resolve(dir, config.recordings),
    stateDir: path.join(dir, '.afrec'),
  };
}

/** Writes changed keys back to afrec.config.json (creating it when missing), keeping the others as they are. */
export function saveConfig(project, changes) {
  const file = project.file || path.join(project.dir, CONFIG_FILE);
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = { ...current, ...changes };
  const problems = validate(next, loadSchema('config'));
  if (problems.length) throw new Error(problems.join('; '));
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  project.file = file;
  Object.assign(project.config, changes);
}

/** ~/.afrec, or AFREC_HOME. */
export function homeDir() {
  return process.env.AFREC_HOME ? path.resolve(process.env.AFREC_HOME) : path.join(os.homedir(), '.afrec');
}

export const timestamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
