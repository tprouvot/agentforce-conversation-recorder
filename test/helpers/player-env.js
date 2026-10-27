/**
 * What the player tests share: the fake org and site, the fake sf CLI pointing at the org (alias "fake"), one
 * Chromium, and play() to record a markdown scenario into a fresh folder. Call usePlayerEnv() at the top of a test
 * file: it registers the before/after hooks.
 */
import { before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { runConversation } from '../../src/engine/player.js';
import { parseScenarioText } from '../../src/scenario/parse.js';
import { resolveConversation, assignFolders } from '../../src/scenario/resolve.js';
import { installFakeSf, orgRules, fakeSfSupported } from './fake-sf.js';
import { startFakeOrg, startFakeSite } from './fake-org.js';

const hasBrowser = fs.existsSync(chromium.executablePath());
if (!hasBrowser && process.env.AFREC_REQUIRE_BROWSER) throw new Error('Chromium is missing: npx playwright install chromium');

/** The checks of afrec.config.json, without the blank-screenshot one (the fake chat is plain on purpose). */
export const CHECKS = { gifMaxBytes: 15000000, videoSlackSeconds: 3, minBytesPerMegapixel: 0 };

export function usePlayerEnv() {
  const env = {
    skip: !hasBrowser ? 'Chromium is not installed' : !fakeSfSupported ? 'the fake sf CLI needs a POSIX shell' : false,
    tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-play-')),
    browser: null, org: null, site: null, sf: null,
    /**
     * Records `text` (a markdown scenario) and returns { result, conv, dir, events, read(file) }.
     * @param {string} text
     * @param {{ broker?: any, stateDir?: string }} [ctx]
     */
    async play(text, ctx = {}) {
      const file = path.join(env.tmp, 'Player.md');
      fs.writeFileSync(file, text.replaceAll('{site}', env.site.url));
      const conv = resolveConversation(parseScenarioText(fs.readFileSync(file, 'utf8'), file)[0]);
      assignFolders([conv]);
      const out = fs.mkdtempSync(path.join(env.tmp, 'run-'));
      const events = [];
      const result = await runConversation(env.browser, conv, {
        out, stateDir: ctx.stateDir || path.join(out, '.afrec'), config: { checks: CHECKS }, emit: e => events.push(e), broker: ctx.broker,
      });
      const dir = path.join(out, conv.folder);
      return { result, conv, dir, events, read: f => fs.readFileSync(path.join(dir, f), 'utf8') };
    },
  };
  before(async () => {
    if (env.skip) return;
    [env.org, env.site] = await Promise.all([startFakeOrg(), startFakeSite()]);
    env.sf = installFakeSf(orgRules('fake', env.org.url));
    env.browser = await chromium.launch();
  });
  after(async () => {
    if (env.browser) await env.browser.close();
    if (env.sf) env.sf.restore();
    await Promise.all([env.org && env.org.close(), env.site && env.site.close()]);
  });
  return env;
}
