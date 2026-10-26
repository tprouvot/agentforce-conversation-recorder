/**
 * The browser scripts: they parse, and a report renders in Chromium (overview, one conversation, the baseline diff)
 * with no script error. Skipped without Chromium, unless AFREC_REQUIRE_BROWSER=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { renderReportHtml } from '../src/engine/report-html.js';

const pub = name => new URL(`../src/ui/public/${name}`, import.meta.url);
const hasBrowser = fs.existsSync(chromium.executablePath());

test('the UI scripts parse', () => {
  for (const name of ['render.js', 'app.js']) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(pub(name), 'utf8'), { filename: name }), name);
});

const report = {
  startedAt: '2026-10-26T10:00:00.000Z', durationMs: 61000, parallel: 2, version: '0.1.0',
  comparison: { baseline: '2026-10-20T10:00:00.000Z', conversations: [{ name: 'Guest', status: 'changed', exchanges: [{ n: 1, status: 'changed', similarity: 0.6, secondsBefore: 4, diff: [{ op: '=', text: 'Rides cost ' }, { op: '-', text: '$4' }, { op: '+', text: '$5' }] }], flagsAdded: [], flagsResolved: [] }] },
  results: [{
    name: 'Guest', folder: 'Guest', surface: 'messaging', who: 'guest visitor', status: 'flagged', durationMs: 30000, outputs: ['transcript.md'],
    flags: ['1: the answer took longer than 2 s (answered in 3 s)'], warnings: [], error: null,
    selectors: { pack: 'messaging', version: '2026.10.1', release: null, healed: ['userText'] },
    exchanges: [{ n: 1, type: 'message', text: 'How much is a ride? <img src=x onerror=alert(1)>', reply: 'Rides cost $5 an hour. </script><b>bold</b>', seconds: 3, screenshot: null, checks: [{ kind: 'max-seconds', pattern: '2', ok: false, detail: 'answered in 3 s' }, { kind: 'expect', pattern: 'cost', ok: true }] }],
  }],
};

test('report.html renders, escapes org text, and shows the diff', { skip: !hasBrowser && 'Chromium is not installed' }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.setContent(renderReportHtml(report));
    await page.waitForSelector('.conv');
    assert.match(await page.textContent('body'), /Running on healed locators \(userText\)/);
    await page.click('.conv');
    await page.waitForSelector('.exchange');
    assert.equal(await page.locator('.bubble.agent b').count(), 0, 'answers are text, never HTML');
    assert.match(await page.textContent('.bubble.agent'), /<\/script><b>bold<\/b>/);
    assert.match(await page.textContent('.checks'), /slower than 2 s/);
    assert.equal(await page.locator('.diff del').textContent(), '$4');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
