/**
 * Replays every fixture (fixtures/<surface>/<name>/) in Chromium against the bundled packs, offline. These tests need
 * Playwright's Chromium (afrec setup); without it they are skipped, unless AFREC_REQUIRE_BROWSER=1 (CI).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { listFixtures, testFixture, openFixture } from '../src/doctor/fixtures.js';
import { effectivePack } from '../src/selectors/packs.js';
import { createSurface } from '../src/engine/surfaces.js';
import { awaitReply } from '../src/engine/reply.js';
import { serializeTree, readChat } from '../src/engine/inpage.js';
import { redactTree, renderHtml } from '../src/doctor/redact.js';

const root = new URL('../fixtures/', import.meta.url).pathname;
const hasBrowser = fs.existsSync(chromium.executablePath());
if (!hasBrowser && process.env.AFREC_REQUIRE_BROWSER) throw new Error('Chromium is missing: npx playwright install chromium');
let browser = null;

before(async () => { if (hasBrowser) browser = await chromium.launch(); });
after(async () => { if (browser) await browser.close(); });

for (const dir of listFixtures([root])) {
  const name = dir.slice(root.length);
  test(`fixture ${name}`, { skip: !hasBrowser && 'Chromium is not installed' }, async () => {
    const r = await testFixture(browser, dir);
    assert.ok(r.ok, `${r.problems.join('; ')}\n${JSON.stringify(r.details)}`);
  });
}

test('the structural fallback, end to end: awaitReply heals and the reader then sees the chat', { skip: !hasBrowser && 'Chromium is not installed' }, async () => {
  const { context, page } = await openFixture(browser, `${root}lightning/synthetic-renamed`);
  try {
    const healedNames = [];
    const surface = createSurface(page, { surface: 'lightning', name: 'x' }, JSON.parse(JSON.stringify(effectivePack('lightning', null, null))), { onHeal: e => healedNames.push(...Object.keys(e)) });
    const before = { messages: [], events: [] };
    // the "agent" has already answered in the fixture: once healed, the answer after the bubble is found
    const r = await awaitReply(surface, before, { timeout: 30000, settle: 500, sentText: 'What can you help me with?' });
    assert.equal(r.text, 'I can summarize accounts and list open cases.');
    assert.deepEqual(healedNames.sort(), ['agentText', 'userText']);
  } finally { await context.close(); }
});

test('a snapshot of a fixture renders back to a page the reader understands (serialize, redact, render)', { skip: !hasBrowser && 'Chromium is not installed' }, async () => {
  const { context, page } = await openFixture(browser, `${root}lightning/synthetic-panel`);
  try {
    const pack = effectivePack('lightning', null, null);
    const raw = await page.evaluate(serializeTree, { rootCandidates: pack.elements.panel.candidates });
    const html = `<!doctype html><html><body>${renderHtml(redactTree(raw.tree))}</body></html>`;
    const again = await browser.newPage();
    // served from a URL: declarative shadow DOM needs a real navigation
    await again.route('https://snap.afrec.invalid/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await again.goto('https://snap.afrec.invalid/');
    const chat = await again.evaluate(readChat, { root: pack.elements.root.candidates, agentText: pack.elements.agentText.candidates, userText: pack.elements.userText.candidates, event: pack.elements.event.candidates, busy: pack.elements.busy.candidates });
    assert.deepEqual(chat.messages.map(m => m.role), ['agent', 'user', 'agent']);
    assert.ok(!/summarize/.test(chat.messages[2].text), 'the answer is redacted');
    await again.close();
  } finally { await context.close(); }
});
