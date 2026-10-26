/**
 * A run: scenario files in, one folder per conversation and a report out. Conversations run in parallel; two with
 * the same identity (surface, org or site, user) never overlap, because a signed-in chat persists across visits.
 * The CLI, the UI and the library API (src/index.js) all go through planRun() and executeRun().
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readScenarioFiles } from '../scenario/parse.js';
import { resolveAll, assignFolders } from '../scenario/resolve.js';
import { timestamp, PACKAGE_ROOT } from '../config.js';
import { loginSfdxUrl } from './salesforce.js';
import { runConversation } from './player.js';
import { writeRunReport } from './report.js';
import { compareRuns, readRun } from './baseline.js';

const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

/**
 * Reads and resolves the scenarios. Defaults: the project's, then `defaults` (command-line flags); the file wins.
 * @param {{ project: any, inputs: string[], defaults?: object, only?: string[] | null }} options
 */
export function planRun({ project, inputs, defaults = {}, only = null }) {
  const warnings = [];
  const raw = readScenarioFiles(inputs.length ? inputs : [project.scenariosDir], warnings);
  let { conversations, errors } = resolveAll(raw, { ...project.config.defaults, ...defaults });
  if (only && only.length) {
    const missing = only.filter(n => !conversations.some(c => c.name === n));
    if (missing.length) errors.push(`--only: no conversation named ${missing.join(', ')}`);
    conversations = conversations.filter(c => only.includes(c.name));
  }
  assignFolders(conversations);
  return { conversations, warnings, errors };
}

/** The plan as lines of text: who signs in where, what is recorded, which conversations queue behind each other. */
export function describePlan(conversations, parallel) {
  const lines = [`${conversations.length} conversation(s), up to ${parallel} at a time:`];
  const width = Math.max(4, ...conversations.map(c => c.name.length));
  for (const c of conversations) {
    const where = c.surface === 'lightning' ? `${c.org || c.loginUrl} ${c.path || (c.app ? 'app ' + c.app : 'home')}${c.agent ? `, agent ${c.agent}` : ''}` : c.site;
    const who = c.signIn === 'guest' ? 'guest' : c.signIn === 'alias-user' ? `CLI user of ${c.org}` : `${c.user} (${c.signIn})`;
    const record = Object.entries(c.record).filter(([, on]) => on).map(([k]) => k).join('+') || 'transcript only';
    const steps = c.steps.map(s => s.type).reduce((acc, t) => ({ ...acc, [t]: (acc[t] || 0) + 1 }), {});
    lines.push(`  ${c.name.padEnd(width)}  ${c.surface.padEnd(9)} ${who}  @ ${where}`);
    lines.push(`  ${''.padEnd(width)}  ${Object.entries(steps).map(([t, k]) => `${k} ${t}`).join(', ')}; ${record}; ${c.viewport.name}`
      + `${c.needsWarmup ? `; warm-up "${c.warmup}"` : ''}${c.fresh ? '' : '; keeps an open chat'}${c.hideLoginAsBanner ? '; hides the Login-As banner' : ''}`);
  }
  const groups = {};
  conversations.forEach(c => { (groups[c.identity] = groups[c.identity] || []).push(c.name); });
  const queued = Object.values(groups).filter(g => g.length > 1);
  if (queued.length) lines.push(`Same identity, run one after the other: ${queued.map(g => g.join(' -> ')).join('; ')}`);
  return lines;
}

/** Runs `worker` on every item, `limit` at a time, never two items with the same identity at once. */
export function pool(items, limit, worker, onError) {
  const results = new Array(items.length);
  const waiting = items.map((item, index) => ({ item, index }));
  const busy = new Set();
  let running = 0;
  return new Promise(resolve => {
    const pump = () => {
      if (!waiting.length && !running) { resolve(results); return; }
      while (running < limit) {
        const next = waiting.findIndex(w => !busy.has(w.item.identity));
        if (next < 0) break;
        const { item, index } = waiting.splice(next, 1)[0];
        busy.add(item.identity);
        running++;
        worker(item)
          .then(r => { results[index] = r; }, e => { results[index] = onError(item, e); })
          .finally(() => { busy.delete(item.identity); running--; pump(); });
      }
    };
    pump();
  });
}

function warnIfNotIgnored(out, emit) {
  try {
    execFileSync('git', ['check-ignore', '-q', out], { stdio: 'ignore', cwd: path.dirname(out) });
  } catch (e) {
    if (e.status === 1) emit({ type: 'warning', message: `${out} is not ignored by git, and recordings show org data: add it to .gitignore` });
  }
}

/**
 * Records the conversations and writes the run report. Returns { out, results, report }.
 * @param {any[]} conversations from planRun
 * @param {{ project: any, out?: string, parallel?: number, headed?: boolean, emit?: (e: any) => void, broker?: any, signal?: AbortSignal }} options
 */
export async function executeRun(conversations, options) {
  const { project } = options;
  const emit = options.emit || (() => {});
  const parallel = options.parallel || project.config.parallel || 3;
  const out = path.resolve(options.out || path.join(project.recordingsDir, timestamp()));
  fs.mkdirSync(out, { recursive: true });
  warnIfNotIgnored(out, emit);
  emit({ type: 'run-start', out, parallel, conversations: conversations.map(c => ({ name: c.name, folder: c.folder, surface: c.surface })) });

  const authorized = new Set();
  for (const c of conversations.filter(x => x.authUrl)) {
    const key = c.authUrl + '|' + c.org;
    if (authorized.has(key)) continue;
    emit({ type: 'log', message: `authorizing ${c.org} from ${path.basename(c.authUrl)}` });
    await loginSfdxUrl(c.authUrl, c.org);
    authorized.add(key);
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: !options.headed });
  const abort = () => { browser.close().catch(() => {}); };
  if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let results;
  try {
    results = await pool(conversations, parallel,
      conv => runConversation(browser, conv, { out, stateDir: project.stateDir, config: project.config, emit, broker: options.broker }),
      (item, e) => ({ name: item.name, folder: item.folder, file: item.file, surface: item.surface, signIn: item.signIn, who: null, status: 'failed', exchanges: [], flags: [], warnings: [], outputs: [], error: e.message, durationMs: 0, selectors: null }));
  } finally {
    await browser.close().catch(() => {});
  }
  const report = { startedAt, durationMs: Date.now() - t0, out, parallel, version: VERSION, comparison: null };
  const baselineDir = project.config.baseline ? path.resolve(project.recordingsDir, project.config.baseline) : null;
  if (baselineDir && fs.existsSync(path.join(baselineDir, 'report.json')) && baselineDir !== out) {
    try { report.comparison = compareRuns(results, readRun(baselineDir)); } catch (e) { emit({ type: 'warning', message: `baseline: ${e.message}` }); }
  }
  writeRunReport(results, report);
  emit({ type: 'run-end', out, results: results.map(r => ({ name: r.name, status: r.status, folder: r.folder, error: r.error })) });
  return { out, results, report: { ...report, results } };
}
