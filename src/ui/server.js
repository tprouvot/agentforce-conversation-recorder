/**
 * afrec ui: a local web server for the project. It edits scenario files, starts runs and doctor checks with the
 * same engine as the CLI, streams their progress (server-sent events), answers type-from prompts, and serves the
 * recordings.
 *
 * Security: it listens on 127.0.0.1 only (by default); the printed URL carries a random token that becomes an
 * HttpOnly cookie; every request needs it, changes also need it in the X-Afrec-Token header (so no other site can
 * trigger one), and the Host header must be the server's own (no DNS rebinding). Passwords never go through it: the
 * development-only credentials files are picked by path and only their usernames are listed.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_ROOT, saveConfig } from '../config.js';
import { listScenarioFiles, parseScenarioText, toMarkdown } from '../scenario/parse.js';
import { resolveAll, assignFolders } from '../scenario/resolve.js';
import { loadSchema } from '../schema.js';
import { planRun, describePlan, executeRun } from '../engine/run.js';
import { InputBroker } from '../engine/input.js';
import { listOrgs } from '../engine/salesforce.js';
import { listCredentialUsers } from '../engine/credentials.js';
import { compareRuns, readRun } from '../engine/baseline.js';
import { doctorCheck } from '../doctor/doctor.js';
import { writeHealBundle } from '../doctor/bundle.js';
import { packStatus, updatePacks, promote } from '../selectors/manage.js';
import { loadDenylist } from '../denylist.js';

const PUBLIC = path.join(PACKAGE_ROOT, 'src', 'ui', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8',
};
const VERSION = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

/** `rel` inside `root`, or an error (no path traversal). */
function inside(root, rel) {
  const full = path.resolve(root, String(rel || ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw Object.assign(new Error('path outside the project'), { status: 400 });
  return full;
}

const readBody = req => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', c => { size += c.length; if (size > 2e6) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
  req.on('error', reject);
});

/**
 * @param {{ project: any, port?: number, host?: string }} options
 * @returns {Promise<{ url: string, token: string, close: () => Promise<void>, server: http.Server }>}
 */
export async function startServer({ project, port = 4477, host = '127.0.0.1' }) {
  const token = crypto.randomBytes(18).toString('base64url');
  const clients = new Set();
  /** @type {{ id: string, kind: string, status: string, events: any[], broker?: InputBroker, controller?: AbortController, out?: string, result?: any } | null} */
  let active = null;
  let orgCache = null;

  const broadcast = event => {
    const e = { ...event, at: Date.now() };
    if (active) { active.events.push(e); if (active.events.length > 5000) active.events.shift(); }
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(line);
  };

  const listRuns = () => {
    if (!fs.existsSync(project.recordingsDir)) return [];
    return fs.readdirSync(project.recordingsDir).filter(d => fs.existsSync(path.join(project.recordingsDir, d, 'report.json'))).sort().reverse().map(id => {
      try {
        const r = readRun(path.join(project.recordingsDir, id));
        const count = s => r.results.filter(x => x.status === s).length;
        return { id, startedAt: r.startedAt, durationMs: r.durationMs, total: r.results.length, recorded: count('recorded'), flagged: count('flagged'), failed: count('failed'), names: r.results.map(x => x.name), baseline: project.config.baseline === id };
      } catch (e) { return { id, error: e.message }; }
    });
  };

  const listDoctor = () => {
    const root = path.join(project.stateDir, 'doctor');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).sort().reverse().slice(0, 20).map(d => {
      try { return { id: d, ...JSON.parse(fs.readFileSync(path.join(root, d, 'doctor.json'), 'utf8')) }; } catch { return null; }
    }).filter(Boolean);
  };

  const scenarioList = () => {
    if (!fs.existsSync(project.scenariosDir)) return [];
    return listScenarioFiles([project.scenariosDir]).map(file => {
      const rel = path.relative(project.scenariosDir, file);
      try {
        const raws = parseScenarioText(fs.readFileSync(file, 'utf8'), file);
        const { errors } = resolveAll(raws, project.config.defaults);
        return { file: rel, conversations: raws.map(r => ({ name: r.name, surface: r.settings.surface || (r.settings.site ? 'messaging' : 'lightning'), steps: r.steps.length })), errors };
      } catch (e) { return { file: rel, conversations: [], errors: [e.message] }; }
    });
  };

  const validateText = (file, text) => {
    const warnings = [];
    const full = inside(project.scenariosDir, file);
    const raws = parseScenarioText(text, full, warnings);
    const { conversations, errors } = resolveAll(raws, project.config.defaults);
    assignFolders(conversations);
    return { conversations: raws.map(r => ({ name: r.name, settings: r.settings, steps: r.steps.map(({ where, ...s }) => s) })), plan: conversations.length ? describePlan(conversations, project.config.parallel) : [], errors, warnings };
  };

  const startRun = body => {
    if (active && active.status === 'running') throw Object.assign(new Error(`a ${active.kind} is already running`), { status: 409 });
    const inputs = (body.files || []).map(f => inside(project.scenariosDir, f));
    const { conversations, warnings, errors } = planRun({ project, inputs, defaults: body.defaults || {}, only: body.only || null });
    if (errors.length) throw Object.assign(new Error(errors.join('\n')), { status: 400 });
    if (!conversations.length) throw Object.assign(new Error('no conversation to record'), { status: 400 });
    const broker = new InputBroker();
    const controller = new AbortController();
    active = { id: crypto.randomUUID(), kind: 'run', status: 'running', events: [], broker, controller };
    const run = active;
    broker.on('request', req => broadcast({ type: 'input-request', ...req }));
    broker.on('resolved', r => broadcast({ type: 'input-resolved', ...r }));
    warnings.forEach(w => broadcast({ type: 'warning', message: w }));
    executeRun(conversations, { project, parallel: body.parallel || project.config.parallel, headed: !!body.headed, emit: broadcast, broker, signal: controller.signal })
      .then(r => { run.status = 'done'; run.out = r.out; broadcast({ type: 'done', kind: 'run', id: path.basename(r.out) }); })
      .catch(e => { run.status = 'failed'; broadcast({ type: 'done', kind: 'run', error: e.message }); });
    return { id: active.id, plan: describePlan(conversations, body.parallel || project.config.parallel) };
  };

  const startDoctor = body => {
    if (active && active.status === 'running') throw Object.assign(new Error(`a ${active.kind} is already running`), { status: 409 });
    const targets = (body.targets || []).filter(t => t && (t.org || t.site));
    if (!targets.length) throw Object.assign(new Error('give an org (Lightning) or a site (Messaging)'), { status: 400 });
    active = { id: crypto.randomUUID(), kind: 'doctor', status: 'running', events: [] };
    const run = active;
    (async () => {
      const reports = [];
      for (const t of targets) {
        try { reports.push(await doctorCheck({ project, settings: t, canary: body.canary && body.canary.length ? body.canary : undefined, headed: !!body.headed, emit: broadcast })); } catch (e) { broadcast({ type: 'warning', message: `doctor: ${e.message}` }); }
      }
      run.status = 'done';
      run.result = reports.map(r => path.basename(r.dir));
      broadcast({ type: 'done', kind: 'doctor', ids: run.result });
    })();
    return { id: active.id };
  };

  const routes = {
    'GET /api/state': () => ({
      version: VERSION, project: { dir: project.dir, hasConfig: !!project.file, config: project.config, scenarios: path.relative(project.dir, project.scenariosDir), recordings: path.relative(project.dir, project.recordingsDir) },
      packs: packStatus(project), active: active && { id: active.id, kind: active.kind, status: active.status, pending: active.broker ? active.broker.pending() : [] },
    }),
    'GET /api/orgs': async () => {
      if (!orgCache || Date.now() - orgCache.at > 60000) orgCache = { at: Date.now(), orgs: await listOrgs() };
      return orgCache.orgs;
    },
    'GET /api/schema': () => loadSchema('scenario'),
    'GET /api/scenarios': () => scenarioList(),
    'GET /api/scenario': (req, url) => {
      const file = inside(project.scenariosDir, url.searchParams.get('file'));
      const text = fs.readFileSync(file, 'utf8');
      let parsed = null;
      try { parsed = validateText(path.relative(project.scenariosDir, file), text); } catch (e) { parsed = { error: e.message }; }
      return { file: path.relative(project.scenariosDir, file), text, parsed };
    },
    'POST /api/scenario/validate': (req, url, body) => {
      try { return validateText(body.file || 'scenario.md', String(body.text || '')); } catch (e) { return { errors: [e.message], conversations: [], plan: [], warnings: [] }; }
    },
    'POST /api/scenario/render': (req, url, body) => ({ text: toMarkdown({ settings: body.settings || {}, steps: body.steps || [], title: body.title || '' }) }),
    'PUT /api/scenario': (req, url, body) => {
      const file = inside(project.scenariosDir, body.file);
      if (!/\.(md|csv)$/i.test(file)) throw Object.assign(new Error('a scenario file ends with .md or .csv'), { status: 400 });
      parseScenarioText(String(body.text || ''), file); // a file that does not parse is not saved
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(body.text || ''));
      return validateText(path.relative(project.scenariosDir, file), String(body.text || ''));
    },
    'DELETE /api/scenario': (req, url) => { fs.rmSync(inside(project.scenariosDir, url.searchParams.get('file'))); return { ok: true }; },
    'GET /api/credentials': (req, url) => listCredentialUsers(inside(project.dir, url.searchParams.get('file'))),
    'POST /api/plan': (req, url, body) => {
      const inputs = (body.files || []).map(f => inside(project.scenariosDir, f));
      const { conversations, warnings, errors } = planRun({ project, inputs, defaults: body.defaults || {}, only: body.only || null });
      return { plan: conversations.length ? describePlan(conversations, body.parallel || project.config.parallel) : [], errors, warnings, names: conversations.map(c => c.name) };
    },
    'POST /api/runs': (req, url, body) => startRun(body),
    'POST /api/cancel': () => { if (active && active.controller) active.controller.abort(); return { ok: true }; },
    'POST /api/input': (req, url, body) => ({ ok: !!(active && active.broker && active.broker.answer(body.id, body.value)) }),
    'GET /api/runs': () => listRuns(),
    'GET /api/run': (req, url) => {
      const id = url.searchParams.get('id');
      const dir = inside(project.recordingsDir, id);
      const report = readRun(dir);
      const base = project.config.baseline && project.config.baseline !== id ? path.join(project.recordingsDir, project.config.baseline) : null;
      if (!report.comparison && base && fs.existsSync(path.join(base, 'report.json'))) report.comparison = compareRuns(report.results, readRun(base));
      return { id, report, baseline: project.config.baseline };
    },
    'POST /api/baseline': (req, url, body) => {
      if (body.id) inside(project.recordingsDir, body.id);
      saveConfig(project, { baseline: body.id || null });
      return { baseline: project.config.baseline };
    },
    'POST /api/doctor': (req, url, body) => startDoctor(body),
    'GET /api/doctor': () => listDoctor(),
    'POST /api/heal': (req, url, body) => {
      const dir = inside(path.join(project.stateDir, 'doctor'), body.id);
      return { dir: writeHealBundle(project, dir, { denylist: loadDenylist(project.stateDir) }) };
    },
    'POST /api/selectors/update': async () => updatePacks(project.config.packsUrl),
    'POST /api/selectors/promote': (req, url, body) => { const r = promote(project, body.surface, { force: !!body.force }); return { version: r.pack.version, written: r.written }; },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const send = (status, body, headers = {}) => {
      const isBuffer = Buffer.isBuffer(body);
      res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(isBuffer || typeof body === 'string' ? {} : { 'Content-Type': 'application/json' }), ...headers });
      res.end(isBuffer || typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      const expectedHost = `${host}:${server.address() && typeof server.address() === 'object' ? /** @type {any} */ (server.address()).port : port}`;
      if (req.headers.host !== expectedHost && req.headers.host !== expectedHost.replace('127.0.0.1', 'localhost')) return send(421, 'wrong host');
      const cookie = Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2));
      if (url.pathname === '/' && url.searchParams.get('token') === token) {
        return send(302, '', { Location: '/', 'Set-Cookie': `afrec_token=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (cookie.afrec_token !== token) return send(401, 'Open the link afrec ui printed (it carries the access token).', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (req.method !== 'GET' && req.headers['x-afrec-token'] !== token) return send(403, { error: 'missing X-Afrec-Token' });

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__AFREC_TOKEN__', token);
        return send(200, html, { 'Content-Type': TYPES['.html'], 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'" });
      }
      if (url.pathname.startsWith('/static/')) {
        const file = inside(PUBLIC, url.pathname.slice('/static/'.length));
        if (!fs.existsSync(file)) return send(404, 'not found');
        return send(200, fs.readFileSync(file), { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      }
      if (url.pathname.startsWith('/runs/')) {
        const file = inside(project.recordingsDir, decodeURIComponent(url.pathname.slice('/runs/'.length)));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'not found');
        return serveFile(req, res, file);
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', active: active && { id: active.id, kind: active.kind, status: active.status } })}\n\n`);
        if (active) for (const e of active.events) res.write(`data: ${JSON.stringify({ ...e, replay: true })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(404, { error: 'not found' });
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      return send(200, await handler(req, url, body));
    } catch (e) {
      return send(e.status || 500, { error: e.message });
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(undefined)); });
  const actual = /** @type {any} */ (server.address()).port;
  return {
    url: `http://${host}:${actual}/?token=${token}`,
    token,
    server,
    close: () => new Promise(resolve => { for (const c of clients) c.end(); server.close(() => resolve(undefined)); }),
  };
}

/** Serves a file, with byte ranges so videos can seek. */
function serveFile(req, res, file) {
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (path.extname(file) === '.html') headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'";
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}
