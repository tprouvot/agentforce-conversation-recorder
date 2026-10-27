/**
 * Signing in, against the fake org and site of helpers/fake-org.js, with the sf CLI faked (helpers/fake-sf.js).
 * Needs Chromium (skipped without it, unless AFREC_REQUIRE_BROWSER=1) and a POSIX shell for the fake sf.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { signIn, safeUrl } from '../src/engine/auth.js';
import { resolveConversation } from '../src/scenario/resolve.js';
import { installFakeSf, orgRules, fakeSfSupported } from './helpers/fake-sf.js';
import { startFakeOrg, startFakeSite } from './helpers/fake-org.js';

const hasBrowser = fs.existsSync(chromium.executablePath());
if (!hasBrowser && process.env.AFREC_REQUIRE_BROWSER) throw new Error('Chromium is missing: npx playwright install chromium');
const skip = !hasBrowser ? 'Chromium is not installed' : !fakeSfSupported ? 'the fake sf CLI needs a POSIX shell' : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-auth-'));
const credentials = path.join(tmp, 'creds.txt');
fs.writeFileSync(credentials, [
  '# test users of the fake org',
  'rider@fake.example secret  (Lightning user)',
  'wrong@fake.example not-the-password',
  'change.me@fake.example x',
  'verify.me@fake.example x',
  'member@riders.example s1te  (site member)',
].join('\n'));
const JORDAN = { Id: '005000000000003AAA', Username: 'jordan@fake.example', Name: 'Jordan Lee', ContactId: null };
const RIDER = { Id: '005000000000004AAA', Username: 'rider.lane@fake.example', Name: 'Rider Lane', ContactId: '003000000000001AAA' };
const options = { viewport: { width: 1280, height: 800 } };
const conv = settings => resolveConversation({ name: 'auth', file: path.join(tmp, 'auth.md'), settings, steps: [{ type: 'message', text: 'Hi' }] });

let browser;
let org;
let site;
let sf;

before(async () => {
  if (skip) return;
  [org, site] = await Promise.all([startFakeOrg({ users: { 'rider@fake.example': 'secret' } }), startFakeSite({ users: { 'member@riders.example': 's1te' } })]);
  org.options.siteUrl = site.url;
  sf = installFakeSf(orgRules('fake', org.url, { users: [JORDAN, RIDER] }));
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (sf) sf.restore();
  await Promise.all([org && org.close(), site && site.close()]);
});

test('safe URLs keep the origin and path: frontdoor and Login-As queries carry sessions', () => {
  assert.equal(safeUrl('https://acme.my.salesforce.com/secur/frontdoor.jsp?sid=00Dxx!AQ'), 'https://acme.my.salesforce.com/secur/frontdoor.jsp');
  assert.equal(safeUrl(''), '(no page)');
});

test('a guest needs no browser and no session', async () => {
  const r = await signIn(null, conv({ site: 'https://riders.example.com/s/' }), options);
  assert.deepEqual(r, { baseUrl: 'https://riders.example.com/s/', who: 'guest visitor', storageState: undefined });
});

test('alias user: the frontdoor signs in, and the session carries over to the recording context', { skip }, async () => {
  const r = await signIn(browser, conv({ surface: 'lightning', org: 'fake' }), options);
  assert.equal(r.baseUrl, org.url);
  assert.equal(r.who, 'admin@fake.example (CLI user of fake)');
  assert.ok(r.storageState.cookies.some(c => c.name === 'sid' && c.value === 'SESSION-fake'));
  const context = await browser.newContext({ storageState: r.storageState });
  try {
    const page = await context.newPage();
    await page.goto(org.url + '/lightning/page/home');
    assert.equal(new URL(page.url()).pathname, '/lightning/page/home', 'not sent back to the login page');
  } finally { await context.close(); }
});

test('Login-As on Lightning: the admin becomes the user, confirmed by the current user Id', { skip }, async () => {
  const r = await signIn(browser, conv({ surface: 'lightning', org: 'fake', user: 'jordan' }), options);
  assert.equal(r.who, 'Jordan Lee via Login-As (fake)');
  const soql = sf.calls().map(c => c[c.indexOf('--query') + 1]).find(q => q && q.includes('FROM User'));
  assert.match(soql, /IsActive = true AND Username LIKE 'jordan@%'/);
  assert.ok(org.requests.some(q => q.path === '/servlet/servlet.su'));
});

test('Login-As refused: the error names the setting to turn on', { skip }, async () => {
  org.options.refuseLoginAs = true;
  try {
    await assert.rejects(signIn(browser, conv({ surface: 'lightning', org: 'fake', user: 'jordan' }), options), /Administrators Can Log in as Any User/);
  } finally { org.options.refuseLoginAs = false; }
});

test('Login-As checks the kind of user first: a community user on Lightning, an internal user on a site', { skip }, async () => {
  await assert.rejects(signIn(browser, conv({ surface: 'lightning', org: 'fake', user: 'rider.lane' }), options), /rider\.lane@fake\.example is an Experience Cloud user/);
  await assert.rejects(signIn(browser, conv({ site: site.url + '/s/', org: 'fake', user: 'jordan' }), options), /jordan@fake\.example is an internal user/);
});

test('Login-As to a site: through the admin, onto the site of the community user', { skip }, async () => {
  const r = await signIn(browser, conv({ site: site.url + '/s/', org: 'fake', user: 'rider.lane' }), options);
  assert.equal(r.baseUrl, site.url + '/s/');
  assert.equal(r.who, 'Rider Lane via Login-As to Riders (fake)');
  assert.ok(site.requests.some(q => q.path === '/s/'));
});

test('password on Lightning: the login form signs in; a wrong password, a password change and an identity check stop with the reason', { skip }, async () => {
  const lightning = user => conv({ surface: 'lightning', loginUrl: org.url, credentials, user });
  const ok = await signIn(browser, lightning('rider'), options);
  assert.equal(ok.who, 'rider@fake.example (password)');
  assert.equal(ok.baseUrl, org.url);
  const shot = path.join(tmp, 'error.png');
  await assert.rejects(signIn(browser, lightning('wrong'), options, shot), /login failed for wrong@fake\.example: Please check your username and password/);
  assert.ok(fs.existsSync(shot), 'a failure leaves a screenshot');
  await assert.rejects(signIn(browser, lightning('change.me'), options), /change their password first/);
  await assert.rejects(signIn(browser, lightning('verify.me'), options), /verify their identity/);
  assert.ok(!sf.calls().some(c => c.join(' ').includes('rider@fake.example')), 'a password login never goes through the sf CLI');
});

test('password on a site: its login page, then the site', { skip }, async () => {
  const r = await signIn(browser, conv({ site: site.url + '/s/', credentials, user: 'member' }), options);
  assert.equal(r.who, 'member@riders.example (password on the site)');
  assert.ok(r.storageState.cookies.some(c => c.name === 'member'));
});
