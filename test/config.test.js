import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProject, saveConfig, findProjectDir, homeDir, timestamp } from '../src/config.js';
import { loadDenylist } from '../src/denylist.js';
import { listCredentialUsers, findCredentials } from '../src/engine/credentials.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-config-'));
const dir = (...parts) => { const d = path.join(tmp, ...parts); fs.mkdirSync(d, { recursive: true }); return d; };

test('the project: found upward from a sub-folder, defaults filled in, nested settings merged', () => {
  const root = dir('found');
  fs.writeFileSync(path.join(root, 'afrec.config.json'), JSON.stringify({ scenarios: 'convs', parallel: 5, checks: { gifMaxBytes: 1000 } }));
  const deep = dir('found', 'convs', 'deep');
  assert.equal(findProjectDir(deep), root);
  const p = loadProject({ dir: deep });
  assert.equal(p.dir, root);
  assert.equal(p.scenariosDir, path.join(root, 'convs'));
  assert.equal(p.recordingsDir, path.join(root, '.local', 'recordings'));
  assert.equal(p.stateDir, path.join(root, '.afrec'));
  assert.equal(p.config.parallel, 5);
  assert.deepEqual(p.config.checks, { gifMaxBytes: 1000, videoSlackSeconds: 3, minBytesPerMegapixel: 7000 }, 'one check changed, the others kept');
  assert.deepEqual(p.config.doctor.canary, ['Hi', 'What can you help me with?']);
});

test('no afrec.config.json: the folder itself, with every default', () => {
  const lone = dir('lone');
  const p = loadProject({ dir: lone });
  assert.equal(p.file, null);
  assert.equal(p.dir, lone);
  assert.equal(p.config.parallel, 3);
  assert.equal(p.config.baseline, null);
});

test('a config that does not parse or breaks the schema names its file', () => {
  const broken = path.join(dir('broken'), 'afrec.config.json');
  fs.writeFileSync(broken, '{ "parallel": 3,, }');
  assert.throws(() => loadProject({ file: broken }), e => /** @type {Error} */ (e).message.startsWith(broken + ': '));
  fs.writeFileSync(broken, JSON.stringify({ parallel: 11 }));
  assert.throws(() => loadProject({ file: broken }), /parallel/);
  fs.writeFileSync(broken, JSON.stringify({ checks: { gifMaxByte: 1 } }));
  assert.throws(() => loadProject({ file: broken }), /gifMaxByte/);
});

test('saveConfig: creates the file when missing, keeps the other keys, refuses an invalid change', () => {
  const p = loadProject({ dir: dir('save') });
  saveConfig(p, { baseline: '20261026-100000' });
  assert.equal(p.file, path.join(p.dir, 'afrec.config.json'));
  assert.equal(p.config.baseline, '20261026-100000');
  fs.writeFileSync(p.file, JSON.stringify({ scenarios: 'convs', baseline: '20261026-100000' }));
  saveConfig(p, { baseline: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.file, 'utf8')), { scenarios: 'convs', baseline: null });
  assert.throws(() => saveConfig(p, { parallel: 'many' }), /parallel/);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.file, 'utf8')), { scenarios: 'convs', baseline: null }, 'an invalid change is not written');
  assert.equal(p.config.parallel, 3);
});

test('home folder and timestamps', () => {
  const saved = process.env.AFREC_HOME;
  try {
    process.env.AFREC_HOME = 'relative/home';
    assert.equal(homeDir(), path.resolve('relative/home'));
    delete process.env.AFREC_HOME;
    assert.equal(homeDir(), path.join(os.homedir(), '.afrec'));
  } finally { if (saved === undefined) delete process.env.AFREC_HOME; else process.env.AFREC_HOME = saved; }
  assert.equal(timestamp(new Date(2026, 0, 5, 7, 8, 9)), '20260105-070809');
  assert.ok(timestamp(new Date(2026, 0, 5, 7, 8, 9)) < timestamp(new Date(2026, 9, 26, 0, 0, 0)), 'they sort by time');
});

test('the denylist: the project\'s and the home folder\'s, comments and blank lines dropped, each term once', () => {
  const state = dir('deny', '.afrec');
  const home = dir('deny', 'home');
  fs.writeFileSync(path.join(state, 'denylist.txt'), '# customers\nHarbor Lights\n\nPier 9   # a station\r\nharbor.example\n');
  fs.writeFileSync(path.join(home, 'denylist.txt'), 'Harbor Lights\nJordan Lee\n');
  const saved = process.env.AFREC_HOME;
  process.env.AFREC_HOME = home;
  try {
    assert.deepEqual(loadDenylist(state), ['Harbor Lights', 'Pier 9', 'harbor.example', 'Jordan Lee']);
    assert.deepEqual(loadDenylist(null), ['Harbor Lights', 'Jordan Lee']);
    assert.deepEqual(loadDenylist(dir('deny', 'none')), ['Harbor Lights', 'Jordan Lee'], 'a missing file is fine');
  } finally { if (saved === undefined) delete process.env.AFREC_HOME; else process.env.AFREC_HOME = saved; }
});

test('credentials: users listed without passwords; a user found by full username or the part before the @', () => {
  const file = path.join(dir('creds'), 'creds.txt');
  fs.writeFileSync(file, '# dev org test users\nrider@x.example s3cret  (Rider, EU)\nFleet.Manager@x.example pw2\nfleet.manager@y.example pw3\nlonely\n');
  assert.deepEqual(listCredentialUsers(file), [
    { username: 'rider@x.example', note: 'Rider, EU' },
    { username: 'Fleet.Manager@x.example', note: null },
    { username: 'fleet.manager@y.example', note: null },
  ], 'a line without a password is not a user');
  assert.ok(!JSON.stringify(listCredentialUsers(file)).includes('s3cret'));
  assert.deepEqual(findCredentials(file, 'RIDER'), { username: 'rider@x.example', password: 's3cret' });
  assert.deepEqual(findCredentials(file, 'fleet.manager@y.example'), { username: 'fleet.manager@y.example', password: 'pw3' });
  assert.throws(() => findCredentials(file, 'fleet.manager'), /"fleet\.manager" matches 2 lines in .*: use the full username/);
  assert.throws(() => findCredentials(file, 'ghost'), /no line for "ghost"/);
});
