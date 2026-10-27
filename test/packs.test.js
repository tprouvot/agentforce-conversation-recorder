import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allPacks, checkPack, selectPack, effectivePack, recordHealing, readOverrides, releaseName, compareVersions } from '../src/selectors/packs.js';
import http from 'node:http';
import { promote, updatePacks, packStatus, checkPackFile } from '../src/selectors/manage.js';

test('the bundled packs are valid and cover both surfaces', () => {
  const packs = allPacks();
  for (const { origin, file, ...p } of packs) assert.deepEqual(checkPack(p), [], p.id);
  assert.ok(packs.some(p => p.surface === 'lightning') && packs.some(p => p.surface === 'messaging'));
  const index = JSON.parse(fs.readFileSync(new URL('../packs/index.json', import.meta.url), 'utf8'));
  for (const entry of index.packs) assert.equal(packs.find(p => p.id === entry.id).version, entry.version, `packs/index.json is up to date for ${entry.id}`);
});

test('a pack with a bad regex or an unknown key is rejected', () => {
  const pack = { id: 'lightning', surface: 'lightning', version: '2026.10.1', minApiVersion: 60, elements: { input: { candidates: [{ css: 'textarea', name: '(' }] }, x: { candidates: [{ wat: 1 }] } } };
  const problems = checkPack(pack);
  assert.ok(problems.some(p => /name/.test(p)), problems.join('; '));
  assert.ok(problems.some(p => /wat/.test(p)), problems.join('; '));
});

test('release names and versions', () => {
  assert.equal(releaseName(68), "Winter '27");
  assert.equal(releaseName(66), "Spring '26");
  assert.equal(releaseName(64), "Summer '25");
  assert.ok(compareVersions('2026.11.1', '2026.10.9') > 0);
  assert.equal(compareVersions('2026.10.1', '2026.10.1'), 0);
});

test('the pack for a release: the highest minApiVersion at or below it', () => {
  const packs = [
    { id: 'lightning', surface: 'lightning', minApiVersion: 60, version: '1.0.0' },
    { id: 'lightning@v70', surface: 'lightning', minApiVersion: 70, version: '1.0.0' },
  ];
  assert.equal(selectPack('lightning', 68, packs).id, 'lightning');
  assert.equal(selectPack('lightning', 70, packs).id, 'lightning@v70');
  assert.equal(selectPack('lightning', null, packs).id, 'lightning@v70');
  assert.equal(selectPack('lightning', 50, packs).id, 'lightning');
});

test('healed overrides go first, are flagged, and promote into a pack once confirmed', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-state-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-home-'));
  process.env.AFREC_HOME = home;
  try {
    recordHealing(state, 'lightning', { userText: [{ class: 'cx-msg--outgoing' }] }, { apiVersion: 70, packVersion: '2026.10.1' });
    const pack = effectivePack('lightning', 70, state);
    assert.deepEqual(pack.healed, ['userText']);
    assert.equal(pack.elements.userText.candidates[0].class, 'cx-msg--outgoing');
    assert.equal(pack.elements.userText.candidates[0].source, 'healed');
    assert.throws(() => promote({ stateDir: state }, 'lightning', { writeBundled: false }), /not confirmed/);
    const overrides = readOverrides(state);
    overrides.lightning.confirmedAt = new Date().toISOString();
    fs.writeFileSync(path.join(state, 'overrides.json'), JSON.stringify(overrides));
    const r = promote({ stateDir: state }, 'lightning', { writeBundled: false });
    assert.equal(r.pack.elements.userText.candidates[0].class, 'cx-msg--outgoing');
    assert.ok(compareVersions(r.pack.version, '2026.10.1') > 0);
    assert.deepEqual(readOverrides(state), {});
    assert.equal(r.inToolRepo, false);
    assert.ok(fs.existsSync(path.join(home, 'packs', 'lightning.json')));
  } finally {
    delete process.env.AFREC_HOME;
  }
});

test('selectors update: newer valid packs are saved, the rest is reported (up to date, rejected, a bad file name)', async () => {
  const bundled = allPacks().find(p => p.id === 'lightning' && p.origin === 'bundled');
  const { origin, file, ...lightning } = bundled;
  const files = {
    'index.json': { packs: [
      { id: 'messaging', file: 'messaging.json', version: allPacks().find(p => p.id === 'messaging').version },
      { id: 'lightning', file: 'lightning.json', version: '2099.1.1' },
      { id: 'lightning@v70', file: 'lightning@v70.json', version: '2026.11.1' },
      { id: 'broken', file: 'broken.json', version: '2026.11.1' },
      { id: 'evil', file: '../../evil.json', version: '2026.11.1' },
    ] },
    'lightning.json': { ...lightning, version: '2099.1.1' },
    'lightning@v70.json': { ...lightning, id: 'lightning@v70', minApiVersion: 70, version: '2026.11.1' },
    'broken.json': { id: 'broken', surface: 'lightning', version: '2026.11.1', minApiVersion: 60, elements: { input: { candidates: [{ css: 'x', name: '(' }] } } },
  };
  const requested = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.split('/').pop());
    requested.push(name);
    if (!req.url.startsWith('/packs/') || !files[name]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(files[name]));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {any} */ (server.address());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-home-'));
  process.env.AFREC_HOME = home;
  try {
    const url = `http://127.0.0.1:${port}/packs`; // no trailing slash: added
    const r = await updatePacks(url);
    assert.deepEqual(r.map(x => `${x.id}: ${x.action}`), [
      'messaging: up to date',
      `lightning: updated from ${bundled.version}`,
      'lightning@v70: added',
      `broken: rejected: ${checkPack(files['broken.json'])[0]}`,
      'evil: skipped: bad file name ../../evil.json',
    ]);
    assert.ok(!requested.includes('messaging.json'), 'a pack that is up to date is not downloaded');
    assert.deepEqual(fs.readdirSync(path.join(home, 'packs')).sort(), ['lightning.json', 'lightning@v70.json']);
    assert.equal(effectivePack('lightning', 66, null).version, '2099.1.1', 'the downloaded pack wins over the bundled one');
    assert.equal(selectPack('lightning', 70).id, 'lightning@v70');
    const status = packStatus({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-state-')) });
    assert.ok(status.packs.some(p => p.id === 'lightning@v70' && p.origin !== 'bundled'));
    assert.deepEqual(checkPackFile(path.join(home, 'packs', 'lightning@v70.json')).problems, []);
    await assert.rejects(updatePacks(`http://127.0.0.1:${port}/nowhere/`), /nowhere\/index\.json: HTTP 404/);
  } finally {
    delete process.env.AFREC_HOME;
    server.close();
  }
});
