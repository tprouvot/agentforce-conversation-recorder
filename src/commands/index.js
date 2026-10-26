/**
 * The afrec commands. Each returns its exit code: 0 fine, 1 something failed or is degraded, 2 bad input or broken.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs, settingsFromFlags, settingSpec } from './args.js';
import { loadProject, saveConfig, PACKAGE_ROOT, CONFIG_FILE, homeDir } from '../config.js';
import { planRun, describePlan, executeRun } from '../engine/run.js';
import { InputBroker, promptOnTerminal } from '../engine/input.js';
import { readScenarioFiles } from '../scenario/parse.js';
import { doctorCheck, describeDoctor } from '../doctor/doctor.js';
import { writeHealBundle, latestDoctorDir } from '../doctor/bundle.js';
import { listFixtures, testFixture, fixtureFromDoctor } from '../doctor/fixtures.js';
import { packStatus, updatePacks, promote, checkPackFile } from '../selectors/manage.js';
import { releaseName } from '../selectors/packs.js';
import { compareRuns, readRun, summarizeComparison } from '../engine/baseline.js';
import { writeRunReport } from '../engine/report.js';
import { listOrgs } from '../engine/salesforce.js';
import { ffmpegBinary } from '../engine/media.js';
import { loadDenylist } from '../denylist.js';

const require = createRequire(import.meta.url);
const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

const HELP = `afrec ${VERSION}: records scripted Agentforce conversations (screenshots, MP4, GIF, transcript). No AI at run time.

Usage: afrec <command> [options]

  run [files|folders]     record conversations (default: the project's scenarios folder)
        --dry-run  --parallel <n>  --out <dir>  --only <name,...>  --headed
        settings for conversations that leave them out: --org --user --site --app --path --agent --surface
        --viewport --record --reply-timeout --settle --type-delay --warmup --input-timeout --network
        --hide-login-as-banner --no-fresh; development only: --credentials --login-url --auth-url
  ui                      the local web UI: edit scenarios, run them, watch progress, browse recordings
        --port <n> (4477)  --host <h> (127.0.0.1)  --no-open
  doctor [scenario]       check the chat against an org: prerequisites, a canary conversation, every locator
        --org --site --user --agent --surface  --canary <text> (repeatable)  --headed
  heal [doctor-dir]       write a repair bundle (for a coding agent) from the last broken doctor check
  selectors list | update [--url u] | promote [--surface s] [--force] | check <pack.json>
  fixtures test [dirs] [--pack file] | add <doctor-dir> --name <name> [--to dir]
  baseline set <run|latest> | clear | show
  compare <run|latest> [--with <run>] [--write]
  setup [--check]         install and check Chromium, ffmpeg, the sf CLI
  init [--org <alias>] [--example ebike|none] [--force]
  orgs                    the orgs the sf CLI knows

  --config <file>         use this afrec.config.json (default: found upward from the current folder)
  --version, --help
`;

const out = s => process.stdout.write(s + '\n');
const err = s => process.stderr.write(s + '\n');

/** Prints run events on the terminal. */
function printer() {
  return e => {
    if (e.type === 'log') out(e.conversation ? `[${e.conversation}] ${e.message}` : e.message);
    else if (e.type === 'warning') err(`warning: ${e.message}`);
  };
}

/** A run folder from a path, a folder name of the project's recordings, or "latest". */
function resolveRunDir(project, ref) {
  if (!ref) throw new Error('give a run folder (or latest)');
  if (ref === 'latest') {
    const dirs = fs.existsSync(project.recordingsDir) ? fs.readdirSync(project.recordingsDir).filter(d => fs.existsSync(path.join(project.recordingsDir, d, 'report.json'))).sort() : [];
    if (!dirs.length) throw new Error(`no run in ${project.recordingsDir}`);
    return path.join(project.recordingsDir, dirs[dirs.length - 1]);
  }
  for (const candidate of [path.resolve(ref), path.join(project.recordingsDir, ref)]) if (fs.existsSync(path.join(candidate, 'report.json'))) return candidate;
  throw new Error(`no run (report.json) at ${ref}`);
}

async function run(argv) {
  const args = parseArgs(argv, { ...settingSpec(), 'dry-run': 'boolean', parallel: 'number', out: 'string', only: 'list', headed: 'boolean', config: 'string' });
  const project = loadProject({ file: args.config });
  const parallel = Math.max(1, args.parallel || project.config.parallel);
  const { conversations, warnings, errors } = planRun({ project, inputs: args._, defaults: settingsFromFlags(args), only: args.only });
  warnings.forEach(w => err(`warning: ${w}`));
  if (errors.length) { errors.forEach(e => err(`error: ${e}`)); return 2; }
  if (!conversations.length) { err('error: no conversation to record'); return 2; }
  describePlan(conversations, parallel).forEach(out);
  if (args['dry-run']) return 0;
  const broker = new InputBroker();
  const stopPrompt = promptOnTerminal(broker);
  const controller = new AbortController();
  const stop = () => { controller.abort(); setTimeout(() => process.exit(130), 2000); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const { results, report, out: dir } = await executeRun(conversations, { project, out: args.out, parallel, headed: args.headed, emit: printer(), broker, signal: controller.signal });
    const failed = results.filter(r => r.status === 'failed').length;
    const flagged = results.filter(r => r.status === 'flagged').length;
    out(`\n${results.length - failed} of ${results.length} recorded${flagged ? `, ${flagged} flagged` : ''}${failed ? `, ${failed} failed` : ''}.`);
    if (report.comparison) out(summarizeComparison(report.comparison));
    const healed = [...new Set(results.flatMap(r => (r.selectors ? r.selectors.healed : [])))];
    if (healed.length) out(`Running on healed locators (${healed.join(', ')}): run afrec doctor, then afrec selectors promote.`);
    out(`Report: ${path.join(dir, 'report.html')}`);
    return failed ? 1 : 0;
  } finally {
    stopPrompt();
  }
}

async function ui(argv) {
  const args = parseArgs(argv, { port: 'number', host: 'string', 'no-open': 'boolean', config: 'string' });
  const project = loadProject({ file: args.config });
  const { startServer } = await import('../ui/server.js');
  const server = await startServer({ project, port: args.port || 4477, host: args.host || '127.0.0.1' });
  out(`afrec UI for ${project.dir}\n  ${server.url}\n(only this machine can open it; the link carries a one-time token. Ctrl+C to stop)`);
  if (!args['no-open']) openBrowser(server.url);
  await new Promise(() => {});
  return 0;
}

export function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is printed */ }
}

/** The doctor's targets: from a scenario file (one per surface), from flags, or from the project's defaults. */
export function doctorTargets(project, args) {
  if (args._.length) {
    const raws = readScenarioFiles(args._, []);
    const bySurface = new Map();
    for (const r of raws) {
      const s = { ...project.config.defaults, ...settingsFromFlags(args), ...r.settings };
      const surface = s.surface || (s.site ? 'messaging' : 'lightning');
      if (!bySurface.has(surface)) bySurface.set(surface, { settings: { ...s, surface }, file: r.file });
    }
    return [...bySurface.values()];
  }
  const s = { ...project.config.defaults, ...settingsFromFlags(args) };
  if (s.surface) return [{ settings: s }];
  const targets = [];
  if (s.org && !s.site) targets.push({ settings: { ...s, surface: 'lightning' } });
  else if (s.org) targets.push({ settings: { org: s.org, agent: s.agent, surface: 'lightning' } });
  if (s.site) targets.push({ settings: { site: s.site, org: s.org, surface: 'messaging', ...(s.user && !targets.length ? { user: s.user } : {}) } });
  if (!targets.length) throw new Error('nothing to check: give a scenario file, --org (Lightning) and/or --site (Messaging), or set defaults in afrec.config.json');
  return targets;
}

async function doctor(argv) {
  const args = parseArgs(argv, { ...settingSpec(), canary: 'list', headed: 'boolean', json: 'boolean', config: 'string' });
  const project = loadProject({ file: args.config });
  const targets = doctorTargets(project, args);
  let worst = 0;
  for (const t of targets) {
    const report = await doctorCheck({ project, settings: t.settings, file: t.file, canary: args.canary, headed: args.headed, emit: args.json ? () => {} : printer() });
    out(args.json ? JSON.stringify(report, null, 1) : '\n' + describeDoctor(report));
    worst = Math.max(worst, { healthy: 0, degraded: 1, broken: 2 }[report.status]);
  }
  return worst;
}

async function heal(argv) {
  const args = parseArgs(argv, { surface: 'string', config: 'string' });
  const project = loadProject({ file: args.config });
  const dir = args._[0] ? path.resolve(args._[0]) : latestDoctorDir(project, args.surface);
  if (!dir || !fs.existsSync(path.join(dir, 'doctor.json'))) throw new Error('no doctor check to repair from: run afrec doctor first');
  const bundle = writeHealBundle(project, dir, { denylist: loadDenylist(project.stateDir) });
  out(`Repair bundle: ${bundle}\nGive ${path.join(bundle, 'README.md')} to your coding agent (the bundle holds no org data). It verifies its fix with:\n  afrec fixtures test ${path.join(bundle, 'fixture')} --pack ${path.join(bundle, 'pack.json')}`);
  return 0;
}

async function selectors(argv) {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, { url: 'string', surface: 'string', force: 'boolean', config: 'string', json: 'boolean' });
  const project = loadProject({ file: args.config });
  if (!sub || sub === 'list') {
    const { packs, overrides } = packStatus(project);
    if (args.json) { out(JSON.stringify({ packs, overrides }, null, 1)); return 0; }
    for (const p of packs) out(`${p.id.padEnd(16)} ${p.version.padEnd(10)} from API ${p.minApiVersion} (${releaseName(p.minApiVersion)})  ${p.origin}${p.verified.length ? `  verified: ${p.verified.map(v => v.release || v.apiVersion).join(', ')}` : ''}`);
    for (const [surface, o] of Object.entries(overrides)) out(`healed ${surface}: ${Object.keys(o.elements).join(', ')} (${o.confirmedAt ? `confirmed ${o.confirmedAt.slice(0, 10)}: run afrec selectors promote` : 'not confirmed yet: run afrec doctor'})`);
    return 0;
  }
  if (sub === 'update') {
    const url = args.url || project.config.packsUrl;
    out(`downloading selector packs from ${url}`);
    for (const r of await updatePacks(url)) out(`  ${r.id}${r.version ? ' ' + r.version : ''}: ${r.action}`);
    return 0;
  }
  if (sub === 'promote') {
    const surfaces = args.surface ? [args.surface] : Object.keys(packStatus(project).overrides);
    if (!surfaces.length) { out('no healed locators to promote'); return 0; }
    for (const s of surfaces) {
      const r = promote(project, s, { force: args.force });
      out(`${s}: ${r.pack.id} ${r.pack.version} written to ${r.written.join(', ')}`);
      out(r.inToolRepo ? '  review the diff, run npm test, and open a pull request' : '  it applies now on this machine; to share it, open a pull request with that file on the agentforce-conversation-recorder repository');
    }
    return 0;
  }
  if (sub === 'check') {
    if (!args._[0]) throw new Error('give a pack file');
    const { pack, problems } = checkPackFile(args._[0]);
    out(problems.length ? `${args._[0]}: ${problems.length} problem(s)\n${problems.map(p => '  ' + p).join('\n')}` : `${args._[0]}: valid (${pack.id} ${pack.version}, ${Object.keys(pack.elements).length} elements)`);
    return problems.length ? 2 : 0;
  }
  throw new Error(`unknown: afrec selectors ${sub}`);
}

async function fixtures(argv) {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, { pack: 'string', name: 'string', to: 'string', config: 'string' });
  const project = loadProject({ file: args.config });
  if (sub === 'add') {
    if (!args._[0] || !args.name) throw new Error('usage: afrec fixtures add <doctor-dir> --name <name>');
    const doctorDir = path.resolve(args._[0]);
    const report = JSON.parse(fs.readFileSync(path.join(doctorDir, 'doctor.json'), 'utf8'));
    const inToolRepo = fs.existsSync(path.join(PACKAGE_ROOT, '.git'));
    const target = args.to ? path.resolve(args.to) : path.join(inToolRepo ? path.join(PACKAGE_ROOT, 'fixtures') : path.join(project.stateDir, 'fixtures'), report.surface, args.name);
    fixtureFromDoctor(doctorDir, target, { name: args.name, denylist: loadDenylist(project.stateDir) });
    out(`fixture written to ${target}`);
    return 0;
  }
  if (sub === 'test') {
    const roots = args._.length ? args._.map(d => path.resolve(d)) : [path.join(PACKAGE_ROOT, 'fixtures'), path.join(project.stateDir, 'fixtures')];
    const dirs = listFixtures(roots);
    if (!dirs.length) { out('no fixture found'); return 0; }
    const pack = args.pack ? JSON.parse(fs.readFileSync(args.pack, 'utf8')) : null;
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    let failed = 0;
    try {
      for (const dir of dirs) {
        const r = await testFixture(browser, dir, { pack: pack && pack.surface === JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8')).surface ? pack : undefined });
        if (!r.ok) failed++;
        out(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : '\n      ' + r.problems.join('\n      ')}`);
      }
    } finally { await browser.close(); }
    out(`${dirs.length - failed} of ${dirs.length} fixtures pass`);
    return failed ? 1 : 0;
  }
  throw new Error('usage: afrec fixtures test [dirs] [--pack file] | add <doctor-dir> --name <name>');
}

async function baseline(argv) {
  const [sub, ...rest] = argv;
  const args = parseArgs(rest, { config: 'string' });
  const project = loadProject({ file: args.config });
  if (sub === 'set') {
    const dir = resolveRunDir(project, args._[0]);
    saveConfig(project, { baseline: path.relative(project.recordingsDir, dir) });
    out(`baseline: ${dir}`);
    return 0;
  }
  if (sub === 'clear') { saveConfig(project, { baseline: null }); out('baseline cleared'); return 0; }
  if (!sub || sub === 'show') { out(project.config.baseline ? path.join(project.recordingsDir, project.config.baseline) : 'no baseline (afrec baseline set <run>)'); return 0; }
  throw new Error(`unknown: afrec baseline ${sub}`);
}

async function compare(argv) {
  const args = parseArgs(argv, { with: 'string', write: 'boolean', config: 'string' });
  const project = loadProject({ file: args.config });
  const dir = resolveRunDir(project, args._[0] || 'latest');
  const against = args.with ? resolveRunDir(project, args.with) : project.config.baseline ? path.join(project.recordingsDir, project.config.baseline) : null;
  if (!against) throw new Error('no baseline: afrec baseline set <run>, or pass --with <run>');
  const current = readRun(dir);
  const cmp = compareRuns(current.results, readRun(against));
  out(summarizeComparison(cmp));
  if (args.write) { const { results, ...run } = current; writeRunReport(results, { ...run, out: dir, comparison: cmp }); out(`updated ${path.join(dir, 'report.html')}`); }
  return cmp.conversations.some(c => c.status !== 'same') ? 1 : 0;
}

const runCmd = (bin, args) => new Promise(resolve => execFile(bin, args, { timeout: 60000, shell: process.platform === 'win32' }, (e, stdout, stderr) => resolve({ ok: !e, text: String(stdout || stderr || '').trim() })));

async function setup(argv) {
  const args = parseArgs(argv, { check: 'boolean' });
  let ok = true;
  const line = (good, name, detail) => { out(`${good ? '✓' : '✗'} ${name}: ${detail}`); if (!good) ok = false; };
  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 20, 'Node', `${process.versions.node}${major >= 20 ? '' : ' (20 or later needed)'}`);
  const { chromium } = await import('playwright');
  let browserOk = fs.existsSync(chromium.executablePath());
  if (!browserOk && !args.check) {
    out('installing Chromium for Playwright...');
    const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    const r = await new Promise(resolve => spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' }).on('exit', code => resolve(code === 0)));
    browserOk = r && fs.existsSync(chromium.executablePath());
  }
  line(browserOk, 'Chromium', browserOk ? 'installed' : 'missing: afrec setup (or npx playwright install chromium)');
  try {
    const f = await runCmd(ffmpegBinary(), ['-version']);
    line(f.ok, 'ffmpeg', f.ok ? f.text.split('\n')[0].slice(0, 50) : 'does not run: npm rebuild ffmpeg-static, or set FFMPEG_PATH');
  } catch (e) { line(false, 'ffmpeg', e.message); }
  const sf = await runCmd('sf', ['--version']);
  line(sf.ok, 'sf CLI', sf.ok ? sf.text.split('\n')[0] : 'missing: npm install --global @salesforce/cli, then sf org login web');
  if (sf.ok) {
    try { const orgs = await listOrgs(); out(`  ${orgs.length} org(s) known to the sf CLI (afrec orgs checks their connection)`); } catch { /* listing is a bonus */ }
  }
  return ok ? 0 : 1;
}

async function init(argv) {
  const args = parseArgs(argv, { org: 'string', example: 'string', force: 'boolean' });
  const dir = process.cwd();
  const file = path.join(dir, CONFIG_FILE);
  if (fs.existsSync(file) && !args.force) throw new Error(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  const config = {
    $schema: './node_modules/agentforce-conversation-recorder/schema/config.schema.json',
    scenarios: 'scenarios', recordings: '.local/recordings', defaults: args.org ? { org: args.org } : {}, parallel: 3, baseline: null,
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  out(`wrote ${CONFIG_FILE}`);
  const scenarios = path.join(dir, 'scenarios');
  fs.mkdirSync(scenarios, { recursive: true });
  const example = args.example || 'ebike';
  if (example !== 'none') {
    const src = path.join(PACKAGE_ROOT, 'examples', example);
    if (!fs.existsSync(src)) throw new Error(`no example "${example}" (available: ${fs.readdirSync(path.join(PACKAGE_ROOT, 'examples')).join(', ')})`);
    for (const f of fs.readdirSync(src)) {
      const target = path.join(scenarios, f);
      if (!fs.existsSync(target) || args.force) fs.copyFileSync(path.join(src, f), target);
    }
    out(`copied the ${example} example scenarios to scenarios/ (edit org:, site: and user: to match your org)`);
  }
  const gitignore = path.join(dir, '.gitignore');
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const missing = ['.local/', '.afrec/'].filter(l => !current.split(/\r?\n/).includes(l));
  if (missing.length) {
    fs.appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}# afrec: recordings and local state show org data\n${missing.join('\n')}\n`);
    out(`added ${missing.join(', ')} to .gitignore`);
  }
  out('next: afrec setup, then afrec run --dry-run, then afrec ui');
  return 0;
}

async function orgs() {
  for (const o of await listOrgs({ check: true })) out(`${(o.alias || '-').padEnd(28)} ${o.connected ? 'connected    ' : 'not connected'}  ${o.sandbox ? 'sandbox' : o.scratch ? 'scratch' : ''}`);
  return 0;
}

const COMMANDS = { run, ui, doctor, heal, selectors, fixtures, baseline, compare, setup, init, orgs };

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') { out(HELP); return 0; }
  if (command === '--version' || command === '-v') { out(VERSION); return 0; }
  if (rest.includes('--help') || rest.includes('-h')) { out(HELP); return 0; }
  if (COMMANDS[command]) return COMMANDS[command](rest);
  if (/\.(md|csv)$/i.test(command) || fs.existsSync(command)) return run(argv); // afrec scenarios/ == afrec run scenarios/
  err(`unknown command "${command}" (afrec --help)`);
  return 2;
}

export { homeDir };
