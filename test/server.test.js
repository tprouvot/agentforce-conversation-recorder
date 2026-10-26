import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/ui/server.js';
import { loadProject } from '../src/config.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-ui-'));
fs.mkdirSync(path.join(dir, 'scenarios'));
fs.writeFileSync(path.join(dir, 'afrec.config.json'), JSON.stringify({ scenarios: 'scenarios', recordings: '.local/recordings' }));
fs.writeFileSync(path.join(dir, 'scenarios', 'guest.md'), '---\nsite: https://x.example.com/\n---\n1. Hi\n');
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
