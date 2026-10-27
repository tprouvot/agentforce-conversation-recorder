/**
 * afrec doctor and afrec heal: element statuses, the terminal summary, the public report, the repair bundle, and
 * whole checks against the fake org (helpers/fake-org.js): healthy, a failed prerequisite, healed locators confirmed
 * then promoted. The live checks need Chromium and a POSIX shell for the fake sf CLI.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { doctorCheck, describeDoctor, elementStatuses } from '../src/doctor/doctor.js';
import { writeHealBundle, latestDoctorDir, publicReport } from '../src/doctor/bundle.js';
import { fixtureFromDoctor, testFixture } from '../src/doctor/fixtures.js';
import { Tracker } from '../src/selectors/locate.js';
import { recordHealing, readOverrides } from '../src/selectors/packs.js';
import { promote } from '../src/selectors/manage.js';
import { loadProject } from '../src/config.js';
import { installFakeSf, orgRules, fakeSfSupported } from './helpers/fake-sf.js';
import { startFakeOrg } from './helpers/fake-org.js';

const hasBrowser = fs.existsSync(chromium.executablePath());
if (!hasBrowser && process.env.AFREC_REQUIRE_BROWSER) throw new Error('Chromium is missing: npx playwright install chromium');
const live = !hasBrowser ? 'Chromium is not installed' : !fakeSfSupported ? 'the fake sf CLI needs a POSIX shell' : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-doctor-'));
process.env.AFREC_HOME = path.join(tmp, 'home'); // promoted packs land here, and ~/.afrec/packs stays out of the tests
let n = 0;
/** A fresh project: its own .afrec, so doctor folders never collide. */
const project = () => {
  const dir = path.join(tmp, `project-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'afrec.config.json'), '{}');
  return loadProject({ dir });
};

let browser;
let org;
let sf;
before(async () => {
  if (live) return;
  org = await startFakeOrg();
  sf = installFakeSf(orgRules('fake', org.url));
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (sf) sf.restore();
  if (org) await org.close();
});

test('element statuses: ok, fallback, healed, missing, unused, and "any" elements', () => {
  const pack = { elements: {
    input: { candidates: [{ css: 'a' }, { css: 'b' }] },
    root: { candidates: [{ tag: 'x', source: 'healed' }, { tag: 'y' }] },
    agentText: { candidates: [{ class: 'p' }, { class: 'q' }] },
    userText: { candidates: [{ class: 'u' }] },
    busy: { match: 'any', candidates: [{ class: 'b1' }, { class: 'b2' }] },
    clearHistory: { candidates: [{ title: 'c' }] },
  } };
  const t = new Tracker();
  t.hit('input', 1, { css: 'b' });
  t.hit('root', 0, { tag: 'x' });
  t.hit('agentText', 0, { class: 'p' });
  t.miss('userText');
  t.hit('busy', 1, { class: 'b2' });
  const byName = Object.fromEntries(elementStatuses(pack, t, 'lightning').map(e => [e.name, e]));
  assert.deepEqual(Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, v.status])),
    { input: 'fallback', root: 'healed', agentText: 'ok', userText: 'missing', busy: 'ok', clearHistory: 'unused' });
  assert.equal(byName.input.index, 1);
  assert.equal(byName.root.index, -1, 'healed candidates are counted before the pack\'s own');
  assert.equal(byName.userText.required, true);
  assert.equal(byName.clearHistory.required, false);
});

test('the public report keeps no alias, host or local path, and no prerequisite detail', () => {
  const r = publicReport({
    surface: 'messaging', target: 'riders.example.com', dir: '/Users/me/project/.afrec/doctor/x', release: "Winter '27", apiVersion: 66, status: 'broken',
    error: 'no Embedded Messaging launcher on https://riders.example.com/s/ (see /Users/me/project/.afrec/doctor/x/error.png)',
    exchanges: [{ text: 'Hi', ok: false, error: 'timeout on riders.example.com' }],
    prereqs: [{ name: 'org', ok: true, level: 'ok', detail: 'myAlias connected, API 66' }], elements: [], healedNow: [],
  });
  const text = JSON.stringify(r);
  assert.ok(!/riders\.example\.com|\/Users\/me|myAlias/.test(text), text);
  assert.match(r.error, /launcher on https:\/\/<target>\/s\//);
  assert.deepEqual(r.prereqs, [{ name: 'org', ok: true, level: 'ok' }]);
  assert.equal(r.target, undefined);
});

test('the summary: every element and prerequisite, and the next step when broken', () => {
  const report = {
    surface: 'lightning', target: 'myOrg', status: 'broken', release: "Winter '27", apiVersion: 66, pack: { id: 'lightning', version: '2026.10.1', origin: 'bundled' },
    prereqs: [{ name: 'node', ok: true, level: 'ok', detail: 'Node 24' }, { name: 'agents', ok: false, level: 'warn', detail: '0 active employee agent(s)' }],
    exchanges: [{ text: 'Hi', ok: true, seconds: 3 }, { text: 'What can you help me with?', ok: false, error: 'no reply within 180 s' }],
    busySeen: false, elements: [{ name: 'input', status: 'fallback', index: 1, required: true }, { name: 'menu', status: 'unused' }, { name: 'userText', status: 'missing', required: true }],
    healedNow: ['userText'], confirmed: [], error: null, dir: '/p/.afrec/doctor/20261026-lightning',
  };
  const text = describeDoctor(report);
  assert.match(text, /^lightning @ myOrg: BROKEN \(Winter '27, API 66\)\n  selector pack lightning 2026\.10\.1 \(bundled\)/);
  assert.match(text, /! agents: 0 active employee agent\(s\)/);
  assert.match(text, /✓ canary "Hi": answered in 3 s\n  ✗ canary "What can you help me with\?": no reply within 180 s/);
  assert.match(text, /! busy indicator never seen/);
  assert.match(text, /! input +fallback \(candidate 2\)/);
  assert.ok(!/menu/.test(text), 'unused elements are left out');
  assert.match(text, /healed during this check: userText/);
  assert.match(text, /next: afrec heal \/p\/\.afrec\/doctor\/20261026-lightning/);
});

test('a fixture needs a snapshot of a chat that opened, without denylisted terms', () => {
  const dir = path.join(tmp, 'doctor-dirs', 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'doctor.json'), JSON.stringify({ surface: 'lightning', status: 'broken' }));
  assert.throws(() => fixtureFromDoctor(dir, path.join(tmp, 'f1'), { name: 'x' }), /never reached the chat/);
  fs.writeFileSync(path.join(dir, 'doctor.json'), JSON.stringify({ surface: 'lightning', status: 'healthy', expected: { roles: [] } }));
  assert.throws(() => fixtureFromDoctor(dir, path.join(tmp, 'f1'), { name: 'x' }), /no snapshot/);
  fs.writeFileSync(path.join(dir, 'page.html'), '<p>Welcome to Harbor Lights</p>');
  assert.throws(() => fixtureFromDoctor(dir, path.join(tmp, 'f1'), { name: 'x', denylist: ['harbor lights'] }), /denylisted term\(s\): harbor lights; not written/);
  assert.ok(!fs.existsSync(path.join(tmp, 'f1')));
});

test('the newest doctor folder, of any surface or of one', () => {
  const p = project();
  assert.equal(latestDoctorDir(p), null);
  for (const d of ['20261001-100000-lightning', '20261002-100000-messaging', '20261001-120000-lightning']) fs.mkdirSync(path.join(p.stateDir, 'doctor', d), { recursive: true });
  assert.equal(path.basename(latestDoctorDir(p)), '20261002-100000-messaging');
  assert.equal(path.basename(latestDoctorDir(p, 'lightning')), '20261001-120000-lightning');
});

test('a failed prerequisite stops the check before any browser starts, and says what to do next', { skip: !fakeSfSupported && 'the fake sf CLI needs a POSIX shell' }, async () => {
  const own = installFakeSf([]); // knows no org
  try {
    const report = await doctorCheck({ project: project(), settings: { surface: 'lightning', org: 'nowhere' }, browser: { newContext() { throw new Error('no browser expected'); } } });
    assert.equal(report.status, 'broken');
    assert.equal(report.error, 'a prerequisite failed');
    const orgCheck = report.prereqs.find(p => p.name === 'org');
    assert.deepEqual([orgCheck.ok, orgCheck.level], [false, 'error']);
    assert.match(orgCheck.detail, /sf org display failed: fake sf: no rule/);
    assert.ok(fs.existsSync(path.join(report.dir, 'doctor.json')));
    assert.match(describeDoctor(report), /✗ org: sf org display failed/);
  } finally { own.restore(); }
});

test('a healthy check: canary answered, every required element on its first candidate, a snapshot that replays offline', { skip: live }, async () => {
  const p = project();
  const report = await doctorCheck({ project: p, settings: { surface: 'lightning', org: 'fake' }, browser });
  assert.equal(report.error, null);
  assert.equal(report.status, 'healthy', describeDoctor(report));
  assert.deepEqual(report.exchanges.map(x => [x.text, x.ok]), [['Hi', true], ['What can you help me with?', true]]);
  assert.equal(report.busySeen, true);
  assert.equal(report.apiVersion, 66);
  assert.equal(report.release, "Spring '26");
  const status = Object.fromEntries(report.elements.map(e => [e.name, e.status]));
  for (const name of ['launcher', 'panel', 'input', 'root', 'agentText', 'userText']) assert.equal(status[name], 'ok', name);
  assert.match(report.prereqs.find(x => x.name === 'org').detail, /^fake connected, API 66$/);
  assert.match(report.prereqs.find(x => x.name === 'agents').detail, /^1 active employee agent\(s\)$/);
  for (const f of ['doctor.json', 'page.html', 'aria.yml', 'screenshot.png']) assert.ok(fs.existsSync(path.join(report.dir, f)), f);
  assert.ok(!/stations and prices/.test(fs.readFileSync(path.join(report.dir, 'page.html'), 'utf8')), 'the agent\'s answers are redacted');

  const fixture = path.join(tmp, 'fixture-from-doctor');
  const meta = fixtureFromDoctor(report.dir, fixture, { name: 'fake-org' });
  assert.deepEqual(meta.expected.roles, ['agent', 'user', 'agent', 'user', 'agent']);
  const replay = await testFixture(browser, fixture);
  assert.ok(replay.ok, replay.problems.join('; '));

  const bundle = writeHealBundle(p, report.dir);
  assert.deepEqual(fs.readdirSync(bundle).sort(), ['README.md', 'aria.yml', 'doctor.json', 'failing.json', 'fixture', 'pack.json', 'pack.schema.json', 'page.html']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bundle, 'failing.json'), 'utf8')), []);
  const shared = fs.readFileSync(path.join(bundle, 'doctor.json'), 'utf8');
  assert.ok(!shared.includes(org.url) && !shared.includes(p.dir), 'no org URL or local path in the bundle');
  assert.match(fs.readFileSync(path.join(bundle, 'README.md'), 'utf8'), /afrec fixtures test fixture --pack pack\.json/);
  // another project: bundle folders are named to the second, so a second bundle now would share the first one's folder
  const other = project();
  assert.throws(() => writeHealBundle(other, report.dir, { denylist: ['Agentforce'] }), /denylisted terms in .*: no bundle written/);
  assert.deepEqual(fs.readdirSync(path.join(other.stateDir, 'heal')), [], 'the refused bundle was removed');
});

test('healed locators: a check that works with them confirms them, and promote turns them into a pack version', { skip: live }, async () => {
  const p = project();
  recordHealing(p.stateDir, 'lightning', { userText: [{ class: 'slds-chat-message__text_outbound' }] }, { apiVersion: 66, packVersion: '2026.10.1' });
  assert.throws(() => promote(p, 'lightning', { writeBundled: false }), /not confirmed yet/);
  const report = await doctorCheck({ project: p, settings: { surface: 'lightning', org: 'fake' }, canary: ['Hi'], browser });
  assert.equal(report.status, 'degraded', describeDoctor(report));
  assert.equal(report.elements.find(e => e.name === 'userText').status, 'healed');
  assert.deepEqual(report.confirmed, ['userText']);
  assert.match(describeDoctor(report), /confirmed healed locators: userText: run afrec selectors promote/);
  assert.ok(readOverrides(p.stateDir).lightning.confirmedAt);
  const r = promote(p, 'lightning', { writeBundled: false });
  assert.equal(r.inToolRepo, false);
  assert.deepEqual(r.pack.verified.at(-1).by, 'afrec doctor');
  assert.ok(fs.existsSync(path.join(process.env.AFREC_HOME, 'packs', 'lightning.json')));
  assert.ok(fs.existsSync(path.join(p.stateDir, 'promoted', 'lightning.json')));
  assert.deepEqual(readOverrides(p.stateDir), {});
});
