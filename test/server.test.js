import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../src/ui/server.js';
import { loadProject } from '../src/config.js';
import { makeRun, result } from './helpers/runs.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-ui-'));
fs.mkdirSync(path.join(dir, 'scenarios'));
fs.writeFileSync(path.join(dir, 'afrec.config.json'), JSON.stringify({ scenarios: 'scenarios', recordings: '.local/recordings' }));
fs.writeFileSync(path.join(dir, 'scenarios', 'guest.md'), '---\nsite: https://x.example.com/\n---\n1. Hi\n');
fs.writeFileSync(path.join(dir, 'creds.txt'), 'rider@x.example s3cret  (rider)\n');
const recordings = path.join(dir, '.local', 'recordings');
makeRun(recordings, '20261020-100000', [result('Guest', ['Rides cost $4 an hour.'])]);
makeRun(recordings, '20261026-100000', [result('Guest', ['Rides cost $5 an hour.'], { status: 'flagged', flags: ['1: x'] }), result('Rider', [], { status: 'failed', error: 'x' })], '2026-10-26T10:00:00.000Z');
let server;
let base;
let cookie;

before(async () => {
  server = await startServer({ project: loadProject({ dir }), port: 0 });
  base = server.url.replace(/\/\?token=.*$/, '');
  const res = await fetch(server.url, { redirect: 'manual' });
  assert.equal(res.status, 302);
  cookie = res.headers.get('set-cookie').split(';')[0];
});
after(async () => { await server.close(); });

const get = (p, headers = {}) => fetch(base + p, { headers: { cookie, ...headers } });
const send = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { cookie, 'content-type': 'application/json', 'x-afrec-token': server.token, ...headers }, body: JSON.stringify(body) });

test('the token is required, changes need it in a header, and the Host must be the server', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { cookie: 'afrec_token=wrong' } })).status, 401);
  assert.equal((await send('PUT', '/api/scenario', { file: 'x.md', text: '1. Hi' }, { 'x-afrec-token': 'nope' })).status, 403);
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await index.text(), new RegExp(server.token));
});

test('state, scenarios, validation and saving', async () => {
  const state = await (await get('/api/state')).json();
  assert.equal(state.project.scenarios, 'scenarios');
  const list = await (await get('/api/scenarios')).json();
  assert.deepEqual(list.map(f => f.file), ['guest.md']);
  const bad = await (await send('POST', '/api/scenario/validate', { file: 'guest.md', text: '---\nsurface: messaging\n---\n1. Hi\n' })).json();
  assert.match(bad.errors.join(' '), /needs site/);
  const saved = await (await send('PUT', '/api/scenario', { file: 'rider.md', text: '---\nsite: https://x.example.com/\n---\n1. Hi\n2. Extend my rental\n' })).json();
  assert.equal(saved.errors.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'scenarios', 'rider.md')));
  const rendered = await (await send('POST', '/api/scenario/render', { settings: { site: 'https://x.example.com/' }, steps: [{ type: 'message', text: 'Hi' }] })).json();
  assert.match(rendered.text, /^---\nsite: https:\/\/x\.example\.com\/\n---\n1\. Hi\n$/);
});

test('paths cannot leave the project', async () => {
  assert.equal((await get('/api/scenario?file=../afrec.config.json')).status, 400);
  assert.equal((await send('PUT', '/api/scenario', { file: '../../evil.md', text: '1. Hi' })).status, 400);
  assert.equal((await get('/runs/..%2F..%2Fafrec.config.json')).status, 400);
});

test('a run without conversations is refused with the reason', async () => {
  const res = await send('POST', '/api/runs', { files: [] , only: ['nobody'] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /no conversation named nobody/);
});

/** A raw request, for what fetch cannot send (another Host header). */
const raw = (p, headers) => new Promise((resolve, reject) => {
  const { port } = new URL(base);
  http.get({ host: '127.0.0.1', port, path: p, headers: { cookie, ...headers } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

test('another Host header is refused (DNS rebinding); localhost is the same server', async () => {
  const { port } = new URL(base);
  assert.equal(await raw('/api/state', { host: `evil.example:${port}` }), 421);
  assert.equal(await raw('/api/state', { host: `localhost:${port}` }), 200);
});

test('static files: the UI scripts, and nothing else', async () => {
  const app = await get('/static/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /^text\/javascript/);
  assert.equal(app.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/static/missing.js')).status, 404);
  assert.equal((await get('/static/..%2F..%2Fserver.js')).status, 404);
  assert.equal((await get('/static/../server.js')).status, 404, 'fetch normalizes the dots: /server.js is no route');
});

test('runs: the list newest first with counts, one run compared with the baseline, the baseline set and refused outside', async () => {
  const runs = await (await get('/api/runs')).json();
  assert.deepEqual(runs.map(r => [r.id, r.total, r.recorded, r.flagged, r.failed]), [['20261026-100000', 2, 0, 1, 1], ['20261020-100000', 1, 1, 0, 0]]);
  assert.equal((await send('POST', '/api/baseline', { id: '../../afrec.config.json' })).status, 400);
  assert.deepEqual(await (await send('POST', '/api/baseline', { id: '20261020-100000' })).json(), { baseline: '20261020-100000' });
  const one = await (await get('/api/run?id=20261026-100000')).json();
  assert.equal(one.baseline, '20261020-100000');
  assert.deepEqual(one.report.comparison.conversations.map(c => `${c.name}:${c.status}`), ['Guest:changed', 'Rider:new']);
  const itself = await (await get('/api/run?id=20261020-100000')).json();
  assert.equal(itself.report.comparison, null, 'the baseline is not compared with itself');
  assert.ok((await (await get('/api/runs')).json()).find(r => r.id === '20261020-100000').baseline);
  assert.deepEqual(await (await send('POST', '/api/baseline', {})).json(), { baseline: null });
});

test('run files: served with their own CSP, in byte ranges for the video player; folders and missing files are 404', async () => {
  const file = path.join(recordings, '20261026-100000', 'report.html');
  const size = fs.statSync(file).size;
  const page = await get('/runs/20261026-100000/report.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'unsafe-inline'; frame-ancestors 'none'/);
  assert.equal(Number(page.headers.get('content-length')), size);
  const head = await get('/runs/20261026-100000/report.html', { range: 'bytes=0-9' });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-9/${size}`);
  assert.equal((await head.text()).length, 10);
  const tail = await get('/runs/20261026-100000/report.html', { range: 'bytes=-5' });
  assert.equal(tail.headers.get('content-range'), `bytes ${size - 5}-${size - 1}/${size}`);
  const open = await get('/runs/20261026-100000/report.html', { range: `bytes=${size - 3}-` });
  assert.equal((await open.text()).length, 3);
  const past = await get('/runs/20261026-100000/report.html', { range: `bytes=${size}-` });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${size}`);
  assert.equal((await get('/runs/20261026-100000')).status, 404);
  assert.equal((await get('/runs/20261026-100000/nope.png')).status, 404);
});

test('scenario files: read back with their plan, deleted, and refused when not a parsable .md or .csv', async () => {
  const read = await (await get('/api/scenario?file=guest.md')).json();
  assert.equal(read.text, '---\nsite: https://x.example.com/\n---\n1. Hi\n');
  assert.match(read.parsed.plan[0], /^1 conversation\(s\)/);
  assert.equal((await send('PUT', '/api/scenario', { file: 'notes.txt', text: '1. Hi' })).status, 400);
  const typo = await send('PUT', '/api/scenario', { file: 'typo.md', text: '---\nsit: https://x.example.com/\n---\n1. Hi\n' });
  assert.ok(typo.status >= 400);
  assert.match((await typo.json()).error, /unknown setting "sit"/);
  assert.ok(!fs.existsSync(path.join(dir, 'scenarios', 'typo.md')), 'a file that does not parse is not saved');
  await send('PUT', '/api/scenario', { file: 'nested/gone.md', text: '---\nsite: https://x.example.com/\n---\n1. Hi\n' });
  assert.ok(fs.existsSync(path.join(dir, 'scenarios', 'nested', 'gone.md')));
  assert.deepEqual(await (await send('DELETE', '/api/scenario?file=nested/gone.md')).json(), { ok: true });
  assert.ok(!fs.existsSync(path.join(dir, 'scenarios', 'nested', 'gone.md')));
  assert.equal((await send('DELETE', '/api/scenario?file=../afrec.config.json')).status, 400);
  assert.ok(fs.existsSync(path.join(dir, 'afrec.config.json')));
});

test('credentials files: usernames and notes only, and only inside the project', async () => {
  const users = await (await get('/api/credentials?file=creds.txt')).json();
  assert.deepEqual(users, [{ username: 'rider@x.example', note: 'rider' }]);
  assert.equal((await get('/api/credentials?file=../../etc/passwd')).status, 400);
});

test('the plan, the schema, an unknown route, a body that is not JSON, doctor and heal without a target', async () => {
  const plan = await (await send('POST', '/api/plan', { files: ['guest.md'], parallel: 1 })).json();
  assert.deepEqual(plan.names, ['guest']);
  assert.match(plan.plan[0], /up to 1 at a time/);
  assert.ok((await (await get('/api/schema')).json()).properties.settings);
  const unknown = await get('/api/nope');
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: 'not found' });
  const notJson = await fetch(base + '/api/plan', { method: 'POST', headers: { cookie, 'x-afrec-token': server.token, 'content-type': 'application/json' }, body: '{ files: ' });
  assert.equal(notJson.status, 400);
  assert.deepEqual(await notJson.json(), { error: 'invalid JSON' });
  const doctor = await send('POST', '/api/doctor', { targets: [{}, null] });
  assert.equal(doctor.status, 400);
  assert.match((await doctor.json()).error, /give an org \(Lightning\) or a site \(Messaging\)/);
  assert.deepEqual(await (await get('/api/doctor')).json(), []);
  assert.equal((await send('POST', '/api/heal', { id: '../../..' })).status, 400);
  assert.deepEqual(await (await send('POST', '/api/input', { id: 'x', value: '1' })).json(), { ok: false }, 'no run is waiting for input');
  assert.deepEqual(await (await send('POST', '/api/cancel', {})).json(), { ok: true });
});

test('the event stream says hello with what is running', async () => {
  const controller = new AbortController();
  const res = await fetch(base + '/api/events', { headers: { cookie }, signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.equal(new TextDecoder().decode(value), 'data: {"type":"hello","active":null}\n\n');
  controller.abort();
});
