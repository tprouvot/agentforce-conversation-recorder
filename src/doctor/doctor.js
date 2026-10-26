/**
 * afrec doctor: checks that the tool still works against an org, before a demo or on a preview sandbox weeks
 * before a Salesforce release reaches production.
 *
 *   1. prerequisites, read-only: Chromium, ffmpeg, the sf CLI, the org (its API version picks the selector pack),
 *      its active agents, its Embedded Messaging deployments; nothing in the org is changed
 *   2. a canary conversation (neutral messages, by default "Hi" and "What can you help me with?") through the real
 *      chat, recording which candidate of the pack matched each element
 *   3. a redacted snapshot of the chat (structure and UI labels, no org content) and its accessibility tree, the
 *      raw material of an offline fixture or of a repair bundle (afrec heal)
 *
 * Each element is ok (the pack's first candidate matched), fallback (a later one: the primary locator broke),
 * healed (a candidate the structural fallback found), missing, or unused (not needed by this check). The check is
 * healthy, degraded (it works, but on fallback or healed locators) or broken. A passing check confirms the healed
 * overrides it used, which `afrec selectors promote` then turns into a pack entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveConversation, assignFolders } from '../scenario/resolve.js';
import { effectivePack, readOverrides, writeOverrides, candidatesOf } from '../selectors/packs.js';
import { Tracker } from '../selectors/locate.js';
import { signIn } from '../engine/auth.js';
import { orgInfo, activeAgents, findAgent, query } from '../engine/salesforce.js';
import { createSurface } from '../engine/surfaces.js';
import { sendText, awaitReply } from '../engine/reply.js';
import { serializeTree } from '../engine/inpage.js';
import { contextOptions } from '../engine/player.js';
import { ffmpegBinary } from '../engine/media.js';
import { redactTree, renderHtml, redactAria, redactAttrs, redactText } from './redact.js';
import { timestamp } from '../config.js';

const REQUIRED = {
  lightning: ['input', 'root', 'agentText', 'userText'],
  messaging: ['frame', 'input', 'root', 'agentText', 'userText'],
};
const IN_SNAPSHOT = {
  lightning: ['panel', 'chat', 'input', 'root', 'agentText', 'userText', 'event', 'busy', 'row', 'panelBox', 'clearHistory'],
  messaging: ['input', 'idleInput', 'root', 'agentText', 'userText', 'event', 'busy', 'row', 'menu'],
};

const run = (bin, args) => new Promise(resolve => execFile(bin, args, { timeout: 20000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || '') })));

/** Where each element stands after the canary: ok, fallback, healed, missing or unused. */
export function elementStatuses(pack, tracker, surface) {
  return Object.entries(pack.elements).map(([name, element]) => {
    const seen = tracker.seen[name];
    const required = REQUIRED[surface].includes(name);
    if (!seen) return { name, status: required ? 'missing' : 'unused', index: null, required };
    if (seen.index < 0) return { name, status: 'missing', index: -1, required };
    const healedCount = element.candidates.filter(c => c.source === 'healed').length;
    // "any" elements (busy indicators, system events): whichever candidate matched is fine
    const status = seen.index < healedCount ? 'healed' : seen.index === healedCount || element.match === 'any' ? 'ok' : 'fallback';
    return { name, status, index: seen.index - healedCount, candidate: seen.candidate, required };
  });
}

async function prerequisites(conv) {
  const out = [];
  const add = (name, ok, detail, level = 'error') => out.push({ name, ok, detail, level: ok ? 'ok' : level });
  add('node', Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`);
  try {
    const f = await run(ffmpegBinary(), ['-version']);
    add('ffmpeg', f.ok, f.ok ? f.out.split('\n')[0].slice(0, 60) : 'ffmpeg does not run: npm rebuild ffmpeg-static, or set FFMPEG_PATH', 'warn');
  } catch (e) { add('ffmpeg', false, e.message, 'warn'); }
  if (!conv.org) return { list: out, apiVersion: null };
  let apiVersion = null;
  try {
    const org = await orgInfo(conv.org);
    apiVersion = org.apiVersion;
    add('org', true, `${conv.org} connected, API ${org.apiVersion}`);
  } catch (e) { add('org', false, e.message); return { list: out, apiVersion }; }
  try {
    const agents = await activeAgents(conv.org);
    const employee = agents.filter(a => a.type === 'InternalCopilot');
    const service = agents.filter(a => a.type && a.type !== 'InternalCopilot');
    if (conv.surface === 'lightning') add('agents', employee.length > 0, `${employee.length} active employee agent(s)${employee.length ? '' : ': the Lightning panel needs one'}`, 'warn');
    else add('agents', agents.length > 0, `${service.length} active service agent(s)`, 'warn');
    if (conv.agent) { const a = await findAgent(conv.org, conv.agent); add('agent', true, `${a.label} (${a.type || 'type unknown'})`); }
  } catch (e) { add('agents', false, e.message, 'warn'); }
  if (conv.surface === 'messaging') {
    try {
      const rows = await query(conv.org, 'SELECT DeveloperName, IsEnabled FROM EmbeddedServiceConfig', { tooling: true });
      const enabled = rows.filter(r => r.IsEnabled !== false);
      add('deployments', enabled.length > 0, `${enabled.length} enabled Embedded Service deployment(s)`, 'warn');
    } catch (e) { add('deployments', false, `could not list Embedded Service deployments (${e.message})`, 'warn'); }
  }
  return { list: out, apiVersion };
}

/**
 * Runs one check. `settings` are a conversation's settings (a scenario's front matter, or flags).
 * @param {{ project: any, settings: object, file?: string, canary?: string[], headed?: boolean, emit?: (e: any) => void, browser?: any }} options
 */
export async function doctorCheck(options) {
  const { project } = options;
  const emit = options.emit || (() => {});
  const canary = options.canary || project.config.doctor.canary;
  const conv = resolveConversation({ name: 'doctor', file: options.file || path.join(project.dir, 'doctor.md'), settings: { ...options.settings, fresh: true, warmup: false }, steps: canary.map(text => ({ type: 'message', text })) }, project.config.defaults);
  assignFolders([conv]);
  const dir = path.join(project.stateDir, 'doctor', `${timestamp()}-${conv.surface}`);
  fs.mkdirSync(dir, { recursive: true });
  const log = message => emit({ type: 'log', conversation: `doctor ${conv.surface}`, message });
  const report = {
    surface: conv.surface, target: conv.surface === 'lightning' ? conv.org : new URL(conv.site).host, startedAt: new Date().toISOString(),
    prereqs: [], apiVersion: null, release: null, pack: null, elements: [], exchanges: [], busySeen: false, status: 'broken', error: null,
    healedNow: [], confirmed: [], dir, files: [],
  };
  log('checking prerequisites (read-only)');
  const pre = await prerequisites(conv);
  report.prereqs = pre.list;
  report.apiVersion = pre.apiVersion;
  const pack = effectivePack(conv.surface, pre.apiVersion, project.stateDir);
  report.release = pack.release;
  report.pack = { id: pack.id, version: pack.version, origin: pack.origin, healed: pack.healed };
  if (pre.list.some(p => p.level === 'error')) { report.error = 'a prerequisite failed'; return finish(report, dir); }

  const tracker = new Tracker();
  const { chromium } = await import('playwright');
  const browser = options.browser || await chromium.launch({ headless: !options.headed });
  let context = null;
  try {
    log(`signing in (${conv.signIn})`);
    const auth = await signIn(browser, conv, contextOptions(conv), path.join(dir, 'error.png'));
    context = await browser.newContext(contextOptions(conv, { storageState: auth.storageState }));
    const page = await context.newPage();
    const surface = createSurface(page, conv, pack, {
      tracker, log,
      onHeal: elements => {
        report.healedNow.push(...Object.keys(elements));
        const overrides = readOverrides(project.stateDir);
        const entry = overrides[conv.surface] || { elements: {} };
        for (const [name, candidates] of Object.entries(elements)) entry.elements[name] = candidates.map(c => ({ ...c, source: 'healed' }));
        Object.assign(entry, { healedAt: new Date().toISOString(), apiVersion: pre.apiVersion, packVersion: pack.version, confirmedAt: null });
        overrides[conv.surface] = entry;
        writeOverrides(project.stateDir, overrides);
      },
    });
    log(`opening the ${surface.label}`);
    await surface.open(auth.baseUrl);
    if (conv.signIn !== 'guest') await surface.reset().catch(() => false);
    for (const text of canary) {
      const before = await surface.read();
      const t0 = Date.now();
      log(`canary: ${text}`);
      try {
        await sendText(surface, text, 0);
        const busyWatch = setInterval(() => surface.read().then(c => { if (c.busy) report.busySeen = true; }).catch(() => {}), 500);
        const reply = await awaitReply(surface, before, { timeout: conv.replyTimeout, settle: conv.surface === 'messaging' ? 8000 : 4000, sentText: text }).finally(() => clearInterval(busyWatch));
        report.exchanges.push({ text, ok: !!reply && !reply.handoff, seconds: Math.round((reply.first - t0) / 1000), chars: reply.text.length, handoff: !!reply.handoff });
      } catch (e) {
        report.exchanges.push({ text, ok: false, error: e.message.split('\n')[0] });
        break;
      }
    }
    const chat = await surface.read();
    report.expected = { roles: chat.messages.map(m => m.role), resolved: chat.resolved };
    report.sentTexts = canary.map(t => redactText(t));
    log('saving a redacted snapshot of the chat');
    await snapshot(page, surface, conv, pack, dir, report);
    await page.screenshot({ path: path.join(dir, 'screenshot.png') }).catch(() => {});
    report.files.push('screenshot.png (local only: shows org data)');
  } catch (e) {
    report.error = e.message.split('\n')[0];
    log(`FAILED: ${report.error}`);
  } finally {
    if (context) await context.close().catch(() => {});
    if (!options.browser) await browser.close().catch(() => {});
  }
  report.elements = elementStatuses(pack, tracker, conv.surface);
  const exchangesOk = report.exchanges.length === canary.length && report.exchanges.every(x => x.ok);
  const missing = report.elements.filter(e => e.required && e.status === 'missing');
  const degraded = report.elements.some(e => e.status === 'fallback' || e.status === 'healed') || report.healedNow.length;
  report.status = !report.error && exchangesOk && !missing.length ? (degraded ? 'degraded' : 'healthy') : 'broken';
  if (report.status !== 'broken') confirmOverrides(project, conv.surface, report);
  return finish(report, dir);
}

/** Healed overrides that this check used successfully (and did not just create) are confirmed. */
function confirmOverrides(project, surface, report) {
  const overrides = readOverrides(project.stateDir);
  const entry = overrides[surface];
  if (!entry) return;
  const used = report.elements.filter(e => e.status === 'healed' && !report.healedNow.includes(e.name)).map(e => e.name);
  const all = Object.keys(entry.elements || {});
  if (!all.length || all.some(n => report.healedNow.includes(n))) return;
  if (used.length || all.every(n => !report.elements.find(e => e.name === n && e.status === 'missing'))) {
    entry.confirmedAt = new Date().toISOString();
    entry.confirmedBy = { apiVersion: report.apiVersion, doctor: path.basename(report.dir) };
    writeOverrides(project.stateDir, overrides);
    report.confirmed = all;
  }
}

async function snapshot(page, surface, conv, pack, dir, report) {
  const frame = await surface.chatFrame();
  const rootCandidates = conv.surface === 'lightning' ? candidatesOf(pack, 'panel') : [];
  const raw = await frame.evaluate(serializeTree, { rootCandidates });
  const tree = redactTree(raw.tree);
  const body = renderHtml(tree);
  if (conv.surface === 'lightning') {
    fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Lightning Agentforce panel (redacted snapshot)</title></head>\n<body>\n${body}</body>\n</html>\n`);
  } else {
    const css = await surface.frameSelector(5000);
    const frameAttrs = redactAttrs(await page.locator(css).first().evaluate(el => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]))).catch(() => ({ id: 'embeddedMessagingFrame' })));
    frameAttrs.src = 'frame.html';
    delete frameAttrs.sandbox; // masked tokens would sandbox the fixture's frame; neither matters to a locator
    delete frameAttrs.allow;
    const attrs = Object.entries(frameAttrs).map(([k, v]) => ` ${k}="${String(v).replace(/"/g, '&quot;')}"`).join('');
    fs.writeFileSync(path.join(dir, 'page.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Embedded Messaging (redacted snapshot)</title></head>\n<body>\n<iframe${attrs} style="width:400px;height:720px;border:0"></iframe>\n</body>\n</html>\n`);
    fs.writeFileSync(path.join(dir, 'frame.html'), `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"></head>\n${body}</html>\n`);
  }
  report.files.push('page.html', ...(conv.surface === 'messaging' ? ['frame.html'] : []));
  try {
    const scopes = conv.surface === 'lightning' ? await surface.panelScopes() : [(await surface.frameLocator()).locator('body')];
    fs.writeFileSync(path.join(dir, 'aria.yml'), redactAria(await scopes[0].ariaSnapshot()));
    report.files.push('aria.yml');
  } catch { /* the accessibility tree is a bonus */ }
  report.inSnapshot = IN_SNAPSHOT[conv.surface];
}

function finish(report, dir) {
  fs.writeFileSync(path.join(dir, 'doctor.json'), JSON.stringify(report, null, 1));
  return report;
}

/** Lines for the terminal. */
export function describeDoctor(report) {
  const icon = { ok: '✓', fallback: '!', healed: '~', missing: '✗', unused: '·' };
  const lines = [
    `${report.surface} @ ${report.target}: ${report.status.toUpperCase()}${report.release ? ` (${report.release}, API ${report.apiVersion})` : ''}`,
    `  selector pack ${report.pack ? `${report.pack.id} ${report.pack.version} (${report.pack.origin})` : '-'}`,
    ...report.prereqs.map(p => `  ${p.ok ? '✓' : p.level === 'warn' ? '!' : '✗'} ${p.name}: ${p.detail}`),
    ...report.exchanges.map(x => `  ${x.ok ? '✓' : '✗'} canary "${x.text}": ${x.ok ? `answered in ${x.seconds} s` : x.error || (x.handoff ? 'handed off' : 'no answer')}`),
    `  ${report.busySeen ? '✓' : '!'} busy indicator ${report.busySeen ? 'seen while the agent worked' : 'never seen: answers end on the settle timer only'}`,
    '  elements:',
    ...report.elements.filter(e => e.status !== 'unused').map(e => `    ${icon[e.status]} ${e.name.padEnd(16)} ${e.status}${e.status === 'fallback' ? ` (candidate ${e.index + 1})` : ''}${e.required ? '' : ' '}`),
  ];
  if (report.healedNow.length) lines.push(`  healed during this check: ${report.healedNow.join(', ')} (saved to .afrec/overrides.json; run afrec doctor again to confirm)`);
  if (report.confirmed.length) lines.push(`  confirmed healed locators: ${report.confirmed.join(', ')}: run afrec selectors promote`);
  if (report.error) lines.push(`  error: ${report.error}`);
  lines.push(`  details: ${report.dir}`);
  if (report.status === 'broken') lines.push(`  next: afrec heal ${report.dir}  (a repair bundle for a coding agent)`);
  return lines.join('\n');
}
