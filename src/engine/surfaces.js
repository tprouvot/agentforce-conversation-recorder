/**
 * The chat surfaces, driven by a selector pack (packs/<surface>.json):
 *
 *   Lightning  the Agentforce side panel of Lightning Experience
 *   Messaging  Embedded Messaging in its iframe: the newer widget (its launcher lives inside the frame) or the
 *              classic one (its launcher is in the page)
 *
 * Every element is found through the pack's candidates. When none matches, a structural fallback looks for the
 * element by its role in the chat (a button named like the assistant, the visible text box, the bubble showing the
 * text just sent) and reports what it found through `onHeal`, so the run goes on and the next runs try it first.
 */
import { candidatesOf } from '../selectors/packs.js';
import { findVisible, findExisting, labelCandidates, Tracker } from '../selectors/locate.js';
import { readChat, scrollChat, panelBox, healChat } from './inpage.js';
import { waitStable } from './reply.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TEXT_BOX = [{ role: 'textbox' }, { css: 'textarea' }, { css: '[contenteditable="true"]' }];

class Surface {
  /**
   * @param {any} page
   * @param {any} conv
   * @param {any} pack the effective pack (packs.effectivePack)
   * @param {{ tracker?: Tracker, onHeal?: (elements: object, evidence: object) => void, log?: (msg: string) => void }} [ctx]
   */
  constructor(page, conv, pack, ctx = {}) {
    this.page = page;
    this.conv = conv;
    this.pack = pack;
    this.tracker = ctx.tracker || new Tracker();
    this.onHeal = ctx.onHeal || (() => {});
    this.log = ctx.log || (() => {});
    this.healed = {};
    this.label = 'chat';
  }

  c(name) { return candidatesOf(this.pack, name); }

  /** Where click: and expect-button look, most specific first (each surface narrows it). */
  async clickScopes() { return [this.page]; }

  spec() {
    return { root: this.c('root'), agentText: this.c('agentText'), userText: this.c('userText'), event: this.c('event'), busy: this.c('busy'), row: this.c('row'), panelBox: this.c('panelBox') };
  }

  /** The frame the chat lives in (the page's main frame for Lightning). */
  async chatFrame() { return this.page.mainFrame(); }

  async read() {
    const frame = await this.chatFrame();
    const spec = this.spec();
    const chat = await frame.evaluate(readChat, spec);
    for (const [name, index] of Object.entries(chat.resolved)) if (index >= 0) this.tracker.hit(name, index, spec[name][index]);
    return chat;
  }

  async scroll(arg) {
    const frame = await this.chatFrame();
    return frame.evaluate(scrollChat, { spec: this.spec(), ...arg }).catch(() => false);
  }

  /** Records healed candidates: tried first for the rest of this run, and saved for the next runs by the caller. */
  applyHeal(elements, evidence) {
    for (const [name, candidates] of Object.entries(elements)) {
      if (!candidates || !candidates.length) continue;
      const element = this.pack.elements[name];
      if (!element) continue;
      element.candidates = [...candidates.map(c => ({ ...c, source: 'healed' })), ...element.candidates];
      this.healed[name] = candidates;
    }
    this.onHeal(elements, evidence);
  }

  /** Structural fallback for the messages: anchored on the bubble that shows `sentText`. */
  async heal(sentText) {
    const frame = await this.chatFrame();
    const found = await frame.evaluate(healChat, { sentText }).catch(() => null);
    if (!found || !found.agentText) return null;
    this.log(`the chat markup changed: found the messages by structure (${found.evidence.marker} / ${found.evidence.mirrored}); saved to .afrec/overrides.json`);
    this.applyHeal({ userText: found.userText, agentText: found.agentText }, found.evidence);
    return found;
  }

  /** The visible text box: the pack's input, else the last visible text box in the chat scopes. */
  async findInput(scopes, timeout) {
    const hit = await findVisible(scopes, this.c('input'), { timeout, tracker: this.tracker, name: 'input' });
    if (hit) return hit.locator;
    const guess = await findVisible(scopes, TEXT_BOX, { last: true });
    if (!guess) return null;
    const candidate = TEXT_BOX[guess.index];
    this.log(`no input candidate matched: using the chat's ${candidate.css || 'textbox'} (saved to .afrec/overrides.json)`);
    this.applyHeal({ input: [candidate] }, { element: 'input' });
    return guess.locator;
  }

  /** Presses the most recent visible match of `label` in the chat, waiting up to 15 s for it to render. */
  async click(label) {
    const hit = await findVisible(await this.clickScopes(), labelCandidates(label), { timeout: 15000, last: true });
    if (!hit) throw new Error(`no visible button or link "${label}" in the ${this.label} after 15 s`);
    await hit.locator.click();
  }

  /** Whether a button or link matching `label` is visible in the chat (expect-button), waiting up to `timeout`. */
  async hasButton(label, timeout = 5000) {
    return !!(await findVisible(await this.clickScopes(), labelCandidates(label), { timeout, last: true }));
  }
}

export class Lightning extends Surface {
  constructor(page, conv, pack, ctx) {
    super(page, conv, pack, ctx);
    this.label = 'Lightning Agentforce panel';
  }

  async panelScopes() {
    const panel = await findExisting([this.page], this.c('panel'), { tracker: this.tracker, name: 'panel' });
    return panel ? [panel.locator] : [this.page];
  }

  async clickScopes() {
    // the conversation first, then the panel header; never a page button that happens to share the label
    const chat = await findExisting([this.page], this.c('chat'), { tracker: this.tracker, name: 'chat' });
    return [...(chat ? [chat.locator] : []), ...(await this.panelScopes())];
  }

  async input() { return (await this.findInput(await this.panelScopes(), 30000)) || this.page.locator('textarea').first(); }

  async cropBox() { return this.page.mainFrame().evaluate(panelBox, this.spec()); }

  async open(baseUrl) {
    const target = this.conv.path || (this.conv.app ? `/lightning/app/${this.conv.app}` : '/lightning/page/home');
    await this.page.goto(baseUrl + target, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const started = Date.now();
    let clicked = false;
    let input = null;
    while (Date.now() - started < 150000) {
      input = await findVisible([this.page], this.c('input'), { tracker: this.tracker, name: 'input' });
      if (input) break;
      const gotIt = await findVisible([this.page], this.c('firstUse'));
      if (gotIt) { await gotIt.locator.click(); await sleep(2000); continue; } // first-use screens
      if (await this.pickerShown()) break;
      if (!clicked) {
        const launcher = await findVisible([this.page], this.c('launcher'), { tracker: this.tracker, name: 'launcher' })
          || (Date.now() - started > 30000 ? await this.healLauncher() : null);
        if (launcher) { await launcher.locator.click(); clicked = true; await sleep(3000); continue; }
      }
      if (clicked && Date.now() - started > 45000) break; // the panel opened (or not): let the fallback look for the input
      await sleep(1000);
    }
    if (!clicked && !input && !(await this.pickerShown())) {
      this.tracker.miss('launcher');
      throw new Error('no Agentforce button in the Lightning header: does this user have an agent and the Agentforce permission?');
    }
    if (this.conv.agent || await this.pickerShown()) await this.pickAgent(this.conv.agent);
    if (!input && !(await this.findInput(await this.panelScopes(), 20000))) throw new Error('the Agentforce panel opened but its chat input never appeared');
    await waitStable(this, 20000); // the welcome message
  }

  /** A header button named like the assistant, when no launcher candidate matches. */
  async healLauncher() {
    const loose = { role: 'button', name: 'agentforce|einstein|copilot|assistant' };
    const hit = await findVisible([this.page], [loose]);
    if (!hit) return null;
    const name = ((await hit.locator.getAttribute('aria-label').catch(() => null)) || (await hit.locator.innerText().catch(() => '')) || '').trim();
    const healed = name ? { role: 'button', name: `^${escapeRe(name)}$` } : loose;
    this.log(`no launcher candidate matched: using the header button "${name}" (saved to .afrec/overrides.json)`);
    this.applyHeal({ launcher: [healed] }, { element: 'launcher', name });
    return hit;
  }

  async pickerShown() { return !!(await findVisible([this.page], this.c('agentItem').filter(c => c.css))); }

  /** Picks `agent` in the panel's agent selector (opening it from the header when needed). */
  async pickAgent(agent) {
    const items = async () => {
      const out = [];
      for (const c of this.c('agentItem')) {
        const hit = await findVisible([this.page], [c]);
        if (!hit) continue;
        const loc = c.css ? this.page.locator(c.css) : this.page.getByRole(c.role);
        const n = await loc.count();
        for (let i = 0; i < n; i++) {
          const item = loc.nth(i);
          if (!(await item.isVisible().catch(() => false))) continue;
          const labelEl = await findVisible([item], this.c('agentItemLabel'));
          out.push({ item, label: ((labelEl ? await labelEl.locator.innerText() : await item.innerText()) || '').trim().split('\n')[0] });
        }
        if (out.length) break;
      }
      return out;
    };
    let list = await items();
    if (!list.length && agent) {
      const switcher = await findVisible(await this.panelScopes(), this.c('agentSwitcher'), { tracker: this.tracker, name: 'agentSwitcher' });
      if (switcher) { await switcher.locator.click(); await sleep(1500); list = await items(); }
    }
    if (!list.length) {
      if (agent) this.log(`no agent selector in the panel: "${agent}" is assumed to be the panel's agent`);
      return null;
    }
    if (!agent) throw new Error(`the panel asks which agent to use (${list.map(i => i.label).join(', ')}): set agent: to one of them`);
    const wanted = new RegExp(`^${escapeRe(agent)}$`, 'i');
    const pick = list.find(i => wanted.test(i.label)) || list.find(i => new RegExp(escapeRe(agent), 'i').test(i.label));
    if (!pick) throw new Error(`no agent "${agent}" in the panel's selector (${list.map(i => i.label).join(', ')})`);
    await pick.item.click();
    await sleep(800);
    const submit = await findVisible(await this.panelScopes(), this.c('agentSubmit'), { timeout: 5000, tracker: this.tracker, name: 'agentSubmit' });
    if (submit) await submit.locator.click();
    await sleep(2000);
    this.log(`picked the agent "${pick.label}"`);
    return pick.label;
  }

  async reset() {
    const chat = await this.read();
    if (!chat.messages.some(m => m.role === 'user')) return false;
    const clear = await findVisible(await this.panelScopes(), this.c('clearHistory'), { tracker: this.tracker, name: 'clearHistory' });
    if (!clear) return false;
    await clear.locator.click();
    await sleep(1500);
    const confirm = await findVisible([this.page], this.c('confirm'), { timeout: 3000 });
    if (confirm) await confirm.locator.click();
    const end = Date.now() + 15000;
    while (Date.now() < end && (await this.read()).messages.some(m => m.role === 'user')) await sleep(1000);
    return true;
  }
}

export class Messaging extends Surface {
  constructor(page, conv, pack, ctx) {
    super(page, conv, pack, ctx);
    this.label = 'Embedded Messaging widget';
    this.frameCss = null;
    this.frame = null;
  }

  /** The iframe selector that matches on this page (waits up to `timeout`). */
  async frameSelector(timeout = 0) {
    if (this.frameCss) return this.frameCss;
    const end = Date.now() + timeout;
    do {
      const cands = this.c('frame');
      for (let i = 0; i < cands.length; i++) {
        if (await this.page.locator(cands[i].css).count().catch(() => 0)) {
          this.tracker.hit('frame', i, cands[i]);
          this.frameCss = cands[i].css;
          return this.frameCss;
        }
      }
      if (Date.now() >= end) break;
      await sleep(1000);
    } while (Date.now() < end);
    return null;
  }

  async frameLocator() {
    const css = await this.frameSelector(60000);
    if (!css) throw new Error('no Embedded Messaging frame on the page');
    return this.page.frameLocator(css).first();
  }

  async chatFrame() {
    if (this.frame && !this.frame.isDetached()) return this.frame;
    const css = await this.frameSelector(60000);
    if (!css) throw new Error('no Embedded Messaging frame on the page');
    const handle = await this.page.locator(css).first().elementHandle({ timeout: 60000 });
    this.frame = await handle.contentFrame();
    if (!this.frame) throw new Error('the Embedded Messaging frame has no content');
    return this.frame;
  }

  async clickScopes() { return [await this.frameLocator()]; }

  async input() { return (await this.findInput([await this.frameLocator()], 30000)) || (await this.frameLocator()).locator('textarea').first(); }

  async cropBox() { return this.page.locator(await this.frameSelector(5000)).first().boundingBox(); }

  async open() {
    await this.page.goto(this.conv.site, { waitUntil: 'domcontentloaded', timeout: 120000 });
    let launcher = null;
    const started = Date.now();
    while (!launcher && Date.now() - started < 120000) {
      const classic = await findVisible([this.page], this.c('classicLauncher'), { tracker: this.tracker, name: 'classicLauncher' });
      if (classic) { launcher = classic; this.variant = 'classic'; break; }
      if (await this.frameSelector()) {
        const frame = await this.frameLocator();
        const modern = await findVisible([frame], this.c('launcher'), { tracker: this.tracker, name: 'launcher' })
          || (Date.now() - started > 40000 ? await this.healLauncher(frame) : null);
        if (modern) { launcher = modern; this.variant = 'modern'; break; }
      }
      await sleep(1000);
    }
    if (!launcher) throw new Error(`no Embedded Messaging launcher on ${this.conv.site} after 120 s (is the deployment published and its agent active?)`);
    await launcher.locator.click();
    this.frame = null;
    if (!(await this.findInput([await this.frameLocator()], 90000))) throw new Error('the chat opened but its input never appeared');
    await waitStable(this, 8000);
  }

  /** A button in the frame named like a chat launcher, when no launcher candidate matches. */
  async healLauncher(frame) {
    const loose = { role: 'button', name: 'chat|message|ask|help|agent|start|conversation' };
    const hit = await findVisible([frame], [loose]);
    if (!hit) return null;
    const name = ((await hit.locator.getAttribute('aria-label').catch(() => null)) || (await hit.locator.innerText().catch(() => '')) || '').trim();
    this.log(`no launcher candidate matched: using the frame's button "${name}" (saved to .afrec/overrides.json)`);
    this.applyHeal({ launcher: [name ? { role: 'button', name: `^${escapeRe(name)}$` } : loose] }, { element: 'launcher', name });
    return hit;
  }

  /** Ends the chat a signed-in user left open: a verified chat persists across visits and keeps its agent version. */
  async reset() {
    const frame = await this.frameLocator();
    if (await findVisible([frame], this.c('idleInput'))) return false; // classic widget: no conversation is open
    const menu = await findVisible([frame], this.c('menu'), { tracker: this.tracker, name: 'menu' });
    if (!menu) return false;
    await menu.locator.click();
    await sleep(1000);
    const endItem = await findVisible([frame], this.c('endChat'), { tracker: this.tracker, name: 'endChat' });
    if (!endItem) { await this.page.keyboard.press('Escape'); return false; }
    await endItem.locator.click();
    await sleep(2000);
    const confirm = await findVisible([frame], this.c('confirmEnd'), { timeout: 3000 });
    if (confirm) await confirm.locator.click();
    await sleep(2000);
    const again = await findVisible([frame], this.c('newConversation'), { timeout: 5000, tracker: this.tracker, name: 'newConversation' });
    if (again) await again.locator.click();
    await sleep(2500);
    this.frame = null;
    if (!(await this.findInput([await this.frameLocator()], 60000))) throw new Error('the chat did not reopen after ending the previous one');
    return true;
  }
}

/** @returns {Lightning | Messaging} */
export const createSurface = (page, conv, pack, ctx) => (conv.surface === 'lightning' ? new Lightning(page, conv, pack, ctx) : new Messaging(page, conv, pack, ctx));
