/**
 * Signs a throwaway browser context in, off camera, and returns its cookies and storage for the recording context.
 *
 *   alias-user  the sf alias's own user, through a single-use frontdoor URL (sf org open --url-only)
 *   login-as    the alias's admin logs in as the user: Lightning, or the Experience Cloud site of a community user
 *   password    development only: the login form, with a username and password from a credentials file
 *   guest       nothing to do
 *
 * A forced password change or an identity verification screen stops the conversation with an explanation.
 */
import * as sfc from './salesforce.js';
import { findCredentials } from './credentials.js';

const LIGHTNING = /\/lightning\/|\/one\/one\.app/;
const CHANGE_PASSWORD = 'Salesforce wants this user to change their password first: sign in once by hand, then update the credentials file.';
const VERIFY = 'Salesforce wants this user to verify their identity (emailed code or MFA): use Login-As instead (drop credentials:), or trust this IP range in the profile.';
const VERIFICATION_PATH = /\/_ui\/identity\/(verification|totp|mfa|twofactor)|\/identity\/verification|verifyidentity/i;
const CODE_FIELDS = '#emc, input[name="emc"], #tc, input[name="tc"], input[autocomplete="one-time-code"]';
const USER_FIELDS = 'input[type="email"], input[autocomplete="username"], input[name*="user" i], input[id*="user" i], '
  + 'input[placeholder*="@"], input[placeholder*="mail" i], input[placeholder*="user" i]';

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Origin and path only: frontdoor and Login-As URLs carry session tokens in their query. */
export const safeUrl = u => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '(no page)'; } };

/** A screen that needs a person: a forced password change, or an identity verification code. */
async function blocker(page) {
  let pathname = '';
  try { pathname = new URL(page.url()).pathname; } catch { return null; }
  if (/changepassword/i.test(pathname)) return CHANGE_PASSWORD;
  if (VERIFICATION_PATH.test(pathname) || await page.locator(CODE_FIELDS).first().isVisible().catch(() => false)) return VERIFY;
  return null;
}

async function waitUntil(page, ok, failure, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const url = page.url();
    if (url && url !== 'about:blank') {
      const reason = await blocker(page);
      if (reason) throw new Error(reason);
      if (await ok(url)) return url;
    }
    await sleep(500);
  }
  throw new Error(`${failure} (stuck on ${safeUrl(page.url())})`);
}

async function visibleText(page, selector) {
  const el = page.locator(selector).first();
  if (!(await el.isVisible().catch(() => false))) return null;
  return ((await el.innerText().catch(() => '')) || '').trim() || null;
}

async function asAdmin(page, conv) {
  await page.goto(await sfc.frontdoorUrl(conv.org), { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitUntil(page, u => LIGHTNING.test(u), `the frontdoor sign-in of ${conv.org} did not open Lightning`);
}

async function refuseLoginAs(page) {
  const text = await visibleText(page, 'body');
  if (text && /insufficient privileges|don.t have (the )?permission|not (allowed|authorized) to log in/i.test(text)) {
    throw new Error('Login-As was refused: turn on "Administrators Can Log in as Any User" (Setup > Login Access Policies) for the alias\'s admin');
  }
}

const STRATEGIES = {
  async 'lightning:alias-user'(page, conv) {
    await page.goto(await sfc.frontdoorUrl(conv.org), { waitUntil: 'domcontentloaded', timeout: 120000 });
    const url = await waitUntil(page, u => LIGHTNING.test(u), `the frontdoor sign-in of ${conv.org} did not open Lightning`);
    return { baseUrl: new URL(url).origin, who: `${(await sfc.orgInfo(conv.org)).username} (CLI user of ${conv.org})` };
  },

  async 'lightning:login-as'(page, conv) {
    const [org, user] = await Promise.all([sfc.orgInfo(conv.org), sfc.findUser(conv.org, conv.user)]);
    if (user.ContactId) throw new Error(`${user.Username} is an Experience Cloud user: record it with surface: messaging and its site`);
    await asAdmin(page, conv);
    const home = encodeURIComponent('/lightning/page/home');
    await page.goto(`${org.instanceUrl}/servlet/servlet.su?oid=${org.id}&suorgadminid=${user.Id}&retURL=${home}&targetURL=${home}`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    const url = await waitUntil(page, async u => {
      await refuseLoginAs(page);
      if (!LIGHTNING.test(u)) return false;
      const current = await page.evaluate(() => {
        const aura = /** @type {any} */ (window).$A;
        return aura && aura.get && aura.get('$SObjectType.CurrentUser.Id');
      }).catch(() => null);
      return !!current && current.slice(0, 15) === user.Id.slice(0, 15);
    }, `Login-As ${user.Username} did not complete`);
    return { baseUrl: new URL(url).origin, who: `${user.Name} via Login-As (${conv.org})` };
  },

  async 'lightning:password'(page, conv) {
    const { username, password } = findCredentials(conv.credentials, conv.user);
    const loginBase = conv.loginUrl || (await sfc.orgInfo(conv.org)).instanceUrl;
    await page.goto(loginBase, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const userField = page.locator('#username');
    await userField.waitFor({ state: 'visible', timeout: 60000 });
    await userField.fill(username);
    const pw = page.locator('#password');
    if (!(await pw.isVisible().catch(() => false))) await page.locator('#Login').click(); // login discovery asks for the password second
    await pw.waitFor({ state: 'visible', timeout: 30000 });
    await pw.fill(password);
    await pw.press('Enter');
    const submitted = Date.now();
    let detoured = false;
    const url = await waitUntil(page, async u => {
      const error = await visibleText(page, '#error');
      if (error) throw new Error(`login failed for ${username}: ${error}`);
      if (LIGHTNING.test(u)) return true;
      // signed in but parked on an optional prompt (e.g. "Register Your Mobile Phone"): go straight to Lightning
      if (!detoured && Date.now() - submitted > 6000 && !(await page.locator('#username, #password').first().isVisible().catch(() => false))) {
        detoured = true;
        await page.goto(new URL(u).origin + '/lightning/page/home', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
      }
      return false;
    }, `${username} did not reach Lightning after the login form`);
    return { baseUrl: new URL(url).origin, who: `${username} (password)` };
  },

  async 'messaging:login-as'(page, conv) {
    const [org, user] = await Promise.all([sfc.orgInfo(conv.org), sfc.findUser(conv.org, conv.user)]);
    if (!user.ContactId) throw new Error(`${user.Username} is an internal user: record it with surface: lightning, or give credentials: for the site's login page`);
    const network = await sfc.findNetwork(conv.org, user, conv.network);
    await asAdmin(page, conv);
    await page.goto(`${org.instanceUrl}/servlet/servlet.su?oid=${org.id}&retURL=${encodeURIComponent('/' + user.ContactId)}`
      + `&sunetworkid=${network.id}&sunetworkuserid=${user.Id}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const siteHost = new URL(conv.site).host;
    await waitUntil(page, async u => { await refuseLoginAs(page); return new URL(u).host === siteHost; },
      `Login-As ${user.Username} to ${network.name} did not reach ${siteHost} (does the site use another domain?)`);
    await sleep(3000); // the site finishes setting its session cookies
    return { baseUrl: conv.site, who: `${user.Name} via Login-As to ${network.name} (${conv.org})` };
  },

  async 'messaging:password'(page, conv) {
    const { username, password } = findCredentials(conv.credentials, conv.user);
    const site = new URL(conv.site);
    const loginPage = conv.loginUrl || new URL('login', site.href.endsWith('/') ? site.href : site.href + '/').href;
    await page.goto(loginPage, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const userField = page.locator(USER_FIELDS).first();
    await userField.waitFor({ state: 'visible', timeout: 60000 });
    await userField.fill(username);
    const pw = page.locator('input[type="password"]').first();
    if (!(await pw.isVisible().catch(() => false))) {
      await userField.press('Enter');
      await pw.waitFor({ state: 'visible', timeout: 30000 });
    }
    await pw.fill(password);
    await pw.press('Enter');
    const started = Date.now();
    let pressed = false;
    await waitUntil(page, async u => {
      const x = new URL(u);
      if (x.host === site.host && !/\/login\b/i.test(x.pathname)) return true;
      if (!pressed && Date.now() - started > 4000) { // a form that ignores Enter: press its button
        pressed = true;
        const submit = page.locator('button[type="submit"], input[type="submit"]')
          .or(page.getByRole('button', { name: /^(log ?in|sign ?in|continue|submit|next)$/i })).first();
        if (await submit.isVisible().catch(() => false)) await submit.click();
      }
      if (Date.now() - started > 10000) {
        const error = await visibleText(page, '[role="alert"], .slds-text-color_error');
        if (error) throw new Error(`login failed for ${username}: ${error.slice(0, 160)}`);
      }
      return false;
    }, `${username} was not signed in to ${site.host} after the login form`);
    await sleep(2000);
    return { baseUrl: conv.site, who: `${username} (password on the site)` };
  },

  async 'messaging:guest'(page, conv) {
    return { baseUrl: conv.site, who: 'guest visitor' };
  },
};

/** Returns { storageState, baseUrl, who }; storageState is undefined for a guest. A failure leaves `failureShot`. */
export async function signIn(browser, conv, contextOptions, failureShot) {
  const strategy = STRATEGIES[`${conv.surface}:${conv.signIn}`];
  if (conv.signIn === 'guest') return { ...(await strategy(null, conv)), storageState: undefined };
  const context = await browser.newContext(contextOptions);
  let page = null;
  try {
    page = await context.newPage();
    const result = await strategy(page, conv);
    return { ...result, storageState: await context.storageState() };
  } catch (e) {
    if (page && failureShot) await page.screenshot({ path: failureShot }).catch(() => {});
    throw e;
  } finally {
    await context.close().catch(() => {});
  }
}
