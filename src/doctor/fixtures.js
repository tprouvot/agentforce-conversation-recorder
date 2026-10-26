/**
 * Offline fixtures: redacted snapshots of real chats (from afrec doctor) and hand-written ones, replayed in
 * Chromium without any org. Each fixture folder holds:
 *
 *   fixture.json   { surface, name, kind, release, apiVersion, sentTexts, expected: { roles, resolved }, heal? }
 *   page.html      the page (Lightning: the panel; Messaging: the iframe)
 *   frame.html     Messaging only: the widget's document
 *
 * A fixture passes when the pack finds the chat's input, reads the messages in the expected roles and order, and
 * resolves each in-page element with a candidate no later than when the fixture was captured. A fixture with
 * `heal` checks the structural fallback instead: the pack must fail, and healing from the sent text must succeed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createSurface } from '../engine/surfaces.js';
import { effectivePack, selectPack } from '../selectors/packs.js';
import { Tracker, findExisting } from '../selectors/locate.js';
import { readChat, healChat } from '../engine/inpage.js';
import { redactTree, renderHtml, redactText, denylistHits } from './redact.js';

const ORIGIN = 'https://fixture.afrec.invalid';
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };

/** Every fixture folder under `roots` (folders holding a fixture.json). */
export function listFixtures(roots) {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    if (fs.existsSync(path.join(dir, 'fixture.json'))) { out.push(dir); return; }
    for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).isDirectory()) walk(path.join(dir, f));
  };
  roots.forEach(walk);
  return out.sort();
}

/** Opens a fixture in a fresh page, served from a fake origin (declarative shadow DOM needs a real navigation). */
export async function openFixture(browser, dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'fixture.json'), 'utf8'));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route(`${ORIGIN}/**`, route => {
    const file = path.join(dir, decodeURIComponent(new URL(route.request().url()).pathname.slice(1)) || 'page.html');
    if (!file.startsWith(dir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/page.html`, { waitUntil: 'load' });
  return { meta, context, page };
}

/**
 * Tests one fixture with a pack (default: the pack the tool would pick for the fixture's release, without the
 * project's overrides). Returns { name, ok, problems, details }.
 * @param {any} browser
 * @param {string} dir
 * @param {{ pack?: any }} [options]
 */
export async function testFixture(browser, dir, { pack } = {}) {
  const { meta, context, page } = await openFixture(browser, dir);
  const problems = [];
  const details = {};
  try {
    const base = pack || effectivePack(meta.surface, meta.apiVersion, null);
    const conv = { surface: meta.surface, site: `${ORIGIN}/page.html`, name: meta.name };
    const tracker = new Tracker();
    const surface = createSurface(page, conv, JSON.parse(JSON.stringify(base)), { tracker });
    const frame = await surface.chatFrame();
    const spec = surface.spec();
    const chat = await frame.evaluate(readChat, spec);
    details.roles = chat.messages.map(m => m.role);
    details.resolved = chat.resolved;
    if (meta.heal) {
      if (chat.resolved.userText >= 0 && chat.resolved.agentText >= 0) problems.push('expected the pack to miss the messages (this fixture tests the structural fallback)');
      const healed = await frame.evaluate(healChat, { sentText: meta.heal.sentText });
      details.heal = healed && healed.evidence;
      if (!healed || !healed.agentText) problems.push('the structural fallback found nothing');
      else {
        if (meta.heal.marker && healed.evidence.marker !== meta.heal.marker) problems.push(`healed on "${healed.evidence.marker}", expected "${meta.heal.marker}"`);
        const healedSpec = { ...spec, userText: [...healed.userText, ...spec.userText], agentText: [...healed.agentText, ...spec.agentText] };
        const after = await frame.evaluate(readChat, healedSpec);
        details.healedRoles = after.messages.map(m => m.role);
        if (JSON.stringify(details.healedRoles) !== JSON.stringify(meta.expected.roles)) problems.push(`after healing, roles ${details.healedRoles.join(',')} instead of ${meta.expected.roles.join(',')}`);
      }
    } else {
      if (JSON.stringify(details.roles) !== JSON.stringify(meta.expected.roles)) problems.push(`roles ${details.roles.join(',') || '(none)'} instead of ${meta.expected.roles.join(',')}`);
      for (const [name, index] of Object.entries(meta.expected.resolved || {})) {
        if (index < 0 || !['root', 'agentText', 'userText'].includes(name)) continue;
        const got = chat.resolved[name];
        if (got < 0) problems.push(`${name}: no candidate matches (captured with candidate ${index + 1})`);
        else if (got > index) problems.push(`${name}: matched by candidate ${got + 1}, later than candidate ${index + 1} when captured`);
      }
      // a snapshot has no styles, so layout (visibility) is the live doctor's job: here a candidate must still match
      const scopes = meta.surface === 'messaging' ? [await /** @type {any} */ (surface).frameLocator()] : [page];
      const input = await findExisting(scopes, base.elements.input.candidates, { tracker, name: 'input' });
      details.input = input ? input.index : -1;
      if (!input) problems.push('input: no candidate matches');
    }
  } catch (e) {
    problems.push(e.message.split('\n')[0]);
  } finally {
    await context.close().catch(() => {});
  }
  return { name: `${meta.surface}/${meta.name}`, dir, ok: !problems.length, problems, details };
}

/**
 * Turns a doctor folder into a fixture: copies its redacted page.html / frame.html and writes fixture.json. Refuses
 * when a denylisted term appears (names that must never be published).
 */
export function fixtureFromDoctor(doctorDir, targetDir, { name, denylist = [] }) {
  const report = JSON.parse(fs.readFileSync(path.join(doctorDir, 'doctor.json'), 'utf8'));
  if (report.status === 'broken' && !report.expected) throw new Error(`${doctorDir}: the doctor check never reached the chat; nothing to make a fixture from`);
  const files = ['page.html', 'frame.html'].filter(f => fs.existsSync(path.join(doctorDir, f)));
  if (!files.length) throw new Error(`${doctorDir}: no snapshot (page.html)`);
  const meta = {
    surface: report.surface, name, kind: 'doctor', release: report.release, apiVersion: report.apiVersion, capturedAt: report.startedAt,
    pack: report.pack, sentTexts: report.sentTexts || [], expected: report.expected,
  };
  const texts = files.map(f => fs.readFileSync(path.join(doctorDir, f), 'utf8')).concat(JSON.stringify(meta));
  const hits = denylistHits(texts.join('\n'), denylist);
  if (hits.length) throw new Error(`the snapshot still contains denylisted term(s): ${hits.join(', ')}; not written`);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(doctorDir, f), path.join(targetDir, f));
  fs.writeFileSync(path.join(targetDir, 'fixture.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

export { redactTree, renderHtml, redactText, selectPack };
