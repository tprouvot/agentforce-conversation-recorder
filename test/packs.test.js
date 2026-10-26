import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allPacks, checkPack, selectPack, effectivePack, recordHealing, readOverrides, releaseName, compareVersions } from '../src/selectors/packs.js';
import { promote } from '../src/selectors/manage.js';

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
