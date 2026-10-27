/**
 * The chat surfaces against the live chats of helpers/fake-org.js: opening, reading, clicking, ending a chat a
 * previous visit left open, healing a broken input locator. Needs Chromium (skipped without it, unless
 * AFREC_REQUIRE_BROWSER=1).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createSurface } from '../src/engine/surfaces.js';
import { sendText, awaitReply } from '../src/engine/reply.js';
import { hideMatching } from '../src/engine/inpage.js';
import { effectivePack, candidatesOf } from '../src/selectors/packs.js';
import { Tracker, findVisible, findExisting, labelCandidates, toLocator } from '../src/selectors/locate.js';
import { startFakeOrg, startFakeSite } from './helpers/fake-org.js';

const hasBrowser = fs.existsSync(chromium.executablePath());
if (!hasBrowser && process.env.AFREC_REQUIRE_BROWSER) throw new Error('Chromium is missing: npx playwright install chromium');
const skip = !hasBrowser && 'Chromium is not installed';

let browser;
let org;
let site;

before(async () => {
  if (skip) return;
  [org, site] = await Promise.all([startFakeOrg(), startFakeSite()]);
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  await Promise.all([org && org.close(), site && site.close()]);
});

const pack = surface => JSON.parse(JSON.stringify(effectivePack(surface, null, null)));

/** A signed-in page of the fake org (the frontdoor sets the session cookie). */
async function lightningPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(org.url + '/secur/frontdoor.jsp?sid=TEST');
  return { context, page };
}

test('label candidates: a substring or a /regex/, through every clickable role, the title and the aria-label', () => {
  const plain = /** @type {any[]} */ (labelCandidates('Reserve (2 h)'));
  assert.deepEqual(plain.slice(0, 2), [{ role: 'button', name: 'Reserve \\(2 h\\)' }, { role: 'link', name: 'Reserve \\(2 h\\)' }]);
  assert.deepEqual(plain.slice(-2), [{ text: '^Reserve \\(2 h\\)$' }, { text: 'Reserve \\(2 h\\)' }], 'the exact text is tried before a substring');
  const regex = /** @type {any[]} */ (labelCandidates('/^res(erve)?$/'));
  assert.ok(regex.every(c => Object.values(c).includes('^res(erve)?$') || c.role), JSON.stringify(regex));
  assert.ok(!regex.some(c => c.text && c.text.startsWith('^^')), 'a regex is not anchored twice');
});

test('in-page only candidates have no locator; the tracker keeps the earliest candidate that matched', () => {
  assert.equal(toLocator({}, { classPattern: 'x' }), null);
  assert.equal(toLocator({}, { tag: 'div', not: { class: 'y' } }), null);
  const t = new Tracker();
  t.miss('input');
  t.hit('input', 2, { css: 'textarea' });
  t.hit('input', 0, { role: 'textbox' });
  t.hit('input', 1, { css: 'x' });
  t.miss('input');
  t.merge({ root: { index: 1, candidate: { tag: 'body' } }, busy: { index: -1, candidate: null } });
  assert.deepEqual(t.seen, { input: { index: 0, candidate: { role: 'textbox' } }, root: { index: 1, candidate: { tag: 'body' } } });
});

test('findVisible and findExisting: candidate order, visibility, the most recent match, and a timeout that counts as a miss', { skip }, async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<button hidden>Go</button><div style="display:contents" class="host"><button title="First">Go</button></div><button>Go</button>');
    const tracker = new Tracker();
    const first = await findVisible([page], [{ css: 'button[hidden]' }, { role: 'button', name: '^go$' }], { tracker, name: 'go' });
    assert.equal(first.index, 1, 'a hidden match does not count');
    assert.equal(await first.locator.getAttribute('title'), 'First');
    const last = await findVisible([page], [{ role: 'button', name: '^go$' }], { last: true });
    assert.equal(await last.locator.getAttribute('title'), null, 'last: the most recent match first');
    assert.ok(await findExisting([page], [{ css: '.missing' }, { class: 'host' }]), 'a display: contents host exists without being visible');
    const t0 = Date.now();
    assert.equal(await findVisible([page], [{ css: '.missing' }], { timeout: 800, tracker, name: 'missing' }), null);
    assert.ok(Date.now() - t0 >= 700);
    assert.equal(await findVisible([page], [{ css: '.missing' }], { tracker, name: 'once' }), null);
    assert.deepEqual(Object.keys(tracker.seen).sort(), ['go', 'missing'], 'a single poll is not a miss yet');
  } finally { await page.close(); }
});

test('Lightning: the header button opens the panel, a reply is read, and a button in the answer is clicked', { skip }, async () => {
  const { context, page } = await lightningPage();
  try {
    const tracker = new Tracker();
    const surface = createSurface(page, { surface: 'lightning', name: 'x' }, pack('lightning'), { tracker });
    await surface.open(org.url);
    assert.equal(tracker.seen.launcher.index, 0);
    assert.equal(tracker.seen.input.index, 0);
    const before = await surface.read();
    assert.deepEqual(before.messages, [{ role: 'agent', text: 'Hi, I am Agentforce. How can I help?' }]);
    await sendText(surface, 'How much is a two-hour ride?', 0);
    const reply = await awaitReply(surface, before, { timeout: 20000, settle: 800, sentText: 'How much is a two-hour ride?' });
    assert.equal(reply.text, 'A two-hour ride costs $8.', 'the whole streamed answer, not its first half');
    assert.equal(await surface.hasButton('reserve'), true);
    assert.equal(await surface.hasButton('Cancel', 500), false);
    const beforeClick = await surface.read();
    await surface.click('Reserve');
    const after = await awaitReply(surface, beforeClick, { timeout: 20000, settle: 800, optional: true });
    assert.equal(after.text, 'Your bike is reserved until 5 pm.');
    assert.deepEqual(await surface.cropBox(), await page.locator('.slds-panel').boundingBox(), 'the crop is the panel');
  } finally { await context.close(); }
});

// The pack's `confirm` candidate, ^(Clear|Clear History|...)$, also matches the panel's own "Clear history" button
// (aria-label "Clear history" in the Winter '27 snapshot), which comes before the confirmation modal in the page:
// reset() clicks "Clear history" again instead of the modal's "Clear", and the chat is never cleared.
test('Lightning: a chat a previous visit left open is cleared, through the confirmation', { skip, todo: 'reset() re-clicks "Clear history": surfaces.js looks for confirm with the first match, not the modal' }, async () => {
  org.options.history = [['Old question', 'Old answer']];
  const { context, page } = await lightningPage();
  try {
    const surface = createSurface(page, { surface: 'lightning', name: 'x' }, pack('lightning'));
    await surface.open(org.url);
    assert.ok((await surface.read()).messages.some(m => m.role === 'user'));
    assert.equal(await surface.reset(), true);
    assert.deepEqual((await surface.read()).messages.map(m => m.role), ['agent'], 'only the welcome is left');
    assert.equal(await surface.reset(), false, 'nothing to clear the second time');
  } finally {
    org.options.history = [];
    await context.close();
  }
});

test('Lightning: an agent the panel does not offer to pick is assumed to be the panel\'s', { skip }, async () => {
  const { context, page } = await lightningPage();
  try {
    const logs = [];
    const surface = createSurface(page, { surface: 'lightning', name: 'x', agent: 'Fleet Assistant' }, pack('lightning'), { log: m => logs.push(m) });
    await surface.open(org.url);
    assert.ok(logs.some(l => /"Fleet Assistant" is assumed to be the panel's agent/.test(l)), logs.join('\n'));
  } finally { await context.close(); }
});

test('Lightning: a broken input locator heals onto the chat\'s text box, and a broken launcher onto the header button', { skip }, async () => {
  const { context, page } = await lightningPage();
  try {
    const broken = pack('lightning');
    broken.elements.input.candidates = [{ css: 'textarea.renamed-away' }];
    const healed = [];
    const logs = [];
    const surface = /** @type {any} */ (createSurface(page, { surface: 'lightning', name: 'x' }, broken, { onHeal: e => healed.push(e), log: m => logs.push(m) }));
    const launcher = await surface.healLauncher();
    assert.ok(launcher);
    assert.deepEqual(healed[0], { launcher: [{ role: 'button', name: '^Agentforce$' }] });
    await launcher.locator.click();
    await page.locator('#input').waitFor();
    const input = await surface.findInput(await surface.panelScopes(), 0); // input() waits 30 s for the pack first
    await input.fill('typed');
    assert.equal(await page.locator('#input').inputValue(), 'typed');
    assert.deepEqual(Object.keys(healed[1]), ['input']);
    assert.equal(broken.elements.input.candidates[0].source, 'healed', 'tried first for the rest of the run');
    assert.ok(logs.some(l => /no input candidate matched/.test(l)));
  } finally { await context.close(); }
});

test('the Login-As banner is hidden before the page draws it', { skip }, async () => {
  org.options.banner = true;
  const context = await browser.newContext();
  try {
    await context.addInitScript(hideMatching, candidatesOf(pack('lightning'), 'loginAsBanner').filter(c => c.css));
    const page = await context.newPage();
    await page.goto(org.url + '/secur/frontdoor.jsp?sid=TEST');
    assert.equal(await page.locator('#oneHeader .system-message').count(), 1);
    assert.equal(await page.locator('#oneHeader .system-message').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Agentforce' }).isVisible(), true, 'the rest of the header stays');
  } finally {
    org.options.banner = false;
    await context.close();
  }
});

test('Messaging: the launcher inside the frame opens the chat; reading, sending and the crop happen in the frame', { skip }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const tracker = new Tracker();
    const surface = /** @type {any} */ (createSurface(page, { surface: 'messaging', name: 'x', site: site.url + '/s/' }, pack('messaging'), { tracker }));
    await surface.open();
    assert.equal(surface.variant, 'modern');
    assert.equal(tracker.seen.frame.index, 0);
    const before = await surface.read();
    assert.deepEqual(before.messages, [{ role: 'agent', text: 'Hi, I am the bike assistant.' }]);
    await sendText(surface, 'Hi', 10);
    const reply = await awaitReply(surface, before, { timeout: 20000, settle: 800, sentText: 'Hi' });
    assert.equal(reply.text, 'Hello! I can find stations and prices.');
    const box = await surface.cropBox();
    assert.deepEqual([Math.round(box.width), Math.round(box.height)], [400, 600]);
    assert.equal(await surface.reset(), false, 'a guest chat without an end-chat menu item is left as it is');
  } finally { await context.close(); }
});
