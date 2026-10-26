/**
 * Plays one conversation: picks the selector pack for the org's release, signs in off camera, opens the chat in a
 * fresh recording context, plays every step and its checks, then writes the screenshots, the videos, the timeline and
 * the transcript to the conversation's folder. Progress goes to `ctx.emit` (the terminal or the UI).
 */
import fs from 'node:fs';
import path from 'node:path';
import { signIn } from './auth.js';
import { orgInfo, findAgent } from './salesforce.js';
import { createSurface } from './surfaces.js';
import { sendText, awaitReply, waitStable } from './reply.js';
import { hideMatching, userBubbleRect } from './inpage.js';
import * as media from './media.js';
import { writeTranscript } from './report.js';
import { runCheck, describeFailure, looksBlank, mostlyInside, videoTooLong } from './checks.js';
import { effectivePack, recordHealing, candidatesOf } from '../selectors/packs.js';
import { Tracker } from '../selectors/locate.js';
import { CHECKS } from '../scenario/parse.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const oneLine = text => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 67) + '...' : t; };
const slug = text => String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .trim().split(' ').slice(0, 6).join('-').slice(0, 40) || 'step';
const readingPause = text => Math.max(2000, Math.min(5000, String(text).length * 25));
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export function contextOptions(conv, extra = {}) {
  const v = conv.viewport;
  const options = { viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.scale, ...extra };
  if (v.mobile) Object.assign(options, { isMobile: true, hasTouch: true, userAgent: MOBILE_UA });
  return options;
}

function clip(box, viewport) {
  if (!box) return null;
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.min(box.width, viewport.width - x);
  const height = Math.min(box.height, viewport.height - y);
  return width > 20 && height > 20 ? { x, y, width, height } : null;
}

/** The org's API version (it picks the selector pack), or null for a guest without org. */
async function apiVersionOf(conv) {
  if (!conv.org) return null;
  try { return (await orgInfo(conv.org)).apiVersion; } catch { return null; }
}

/**
 * @param {any} browser a Playwright Browser
 * @param {any} conv a resolved conversation
 * @param {{ out: string, stateDir: string, config: any, emit?: (e: any) => void, broker?: any, tracker?: Tracker, canary?: boolean }} ctx
 */
export async function runConversation(browser, conv, ctx) {
  const dir = path.join(ctx.out, conv.folder);
  fs.mkdirSync(dir, { recursive: true });
  const emit = ctx.emit || (() => {});
  const log = message => emit({ type: 'log', conversation: conv.name, message });
  const result = {
    name: conv.name, folder: conv.folder, file: conv.file, surface: conv.surface, signIn: conv.signIn, who: null, agent: conv.agent || null,
    status: 'recorded', exchanges: [], flags: [], warnings: [], outputs: [], error: null, startedAt: new Date().toISOString(), selectors: null, durationMs: 0,
  };
  emit({ type: 'conversation-start', conversation: conv.name, folder: conv.folder });
  const started = Date.now();
  const recordVideo = conv.record.video || conv.record.gif;
  const checks = ctx.config.checks;
  const events = [];
  let videoStart = Date.now();
  const mark = (kind, step = null, at = Date.now()) => events.push({ kind, step, t: at - videoStart });
  let context = null;
  let page = null;
  let video = null;
  let crop = null;
  let surface = null;
  const tracker = ctx.tracker || new Tracker();

  try {
    const apiVersion = await apiVersionOf(conv);
    const pack = effectivePack(conv.surface, apiVersion, ctx.stateDir);
    result.selectors = { pack: pack.id, version: pack.version, origin: pack.origin, release: pack.release, apiVersion, healed: [...pack.healed], healedNow: [], resolved: {} };
    if (pack.healed.length) log(`running on healed locators: ${pack.healed.join(', ')}`);
    if (conv.agent && conv.org && conv.signIn !== 'password') {
      const agent = await findAgent(conv.org, conv.agent);
      if (agent.type && agent.type !== 'InternalCopilot') result.warnings.push(`the agent "${agent.label}" is a ${agent.type} agent, not an employee agent: the Lightning panel may not offer it`);
      result.agent = agent.label;
    }

    log(`signing in (${conv.signIn})`);
    const auth = await signIn(browser, conv, contextOptions(conv), path.join(dir, 'error.png'));
    result.who = auth.who;
    context = await browser.newContext(contextOptions(conv, {
      storageState: auth.storageState,
      ...(recordVideo ? { recordVideo: { dir: path.join(dir, '.raw'), size: { width: conv.viewport.width, height: conv.viewport.height } } } : {}),
    }));
    if (conv.hideLoginAsBanner) await context.addInitScript(hideMatching, candidatesOf(pack, 'loginAsBanner').filter(c => c.css));
    videoStart = Date.now();
    page = await context.newPage();
    video = page.video();
    surface = createSurface(page, conv, pack, {
      tracker,
      log,
      onHeal: (elements, evidence) => {
        recordHealing(ctx.stateDir, conv.surface, elements, { apiVersion, packVersion: pack.version });
        for (const name of Object.keys(elements)) {
          if (!result.selectors.healed.includes(name)) result.selectors.healed.push(name);
          result.selectors.healedNow.push(name);
        }
        result.warnings.push(`healed ${Object.keys(elements).join(', ')} by structure (${JSON.stringify(evidence)}): saved to .afrec/overrides.json`);
        emit({ type: 'heal', conversation: conv.name, surface: conv.surface, elements: Object.keys(elements) });
      },
    });
    log(`opening the ${surface.label} as ${auth.who}`);
    await surface.open(auth.baseUrl);
    if (conv.fresh && conv.signIn !== 'guest' && await surface.reset()) log('ended the chat a previous visit left open');
    // On Messaging the first message opens the conversation: the welcome comes first, sometimes an answer after it.
    let firstSettle = conv.surface === 'messaging' ? Math.max(conv.settle, 12000) : conv.settle;
    if (conv.needsWarmup) {
      log(`warm-up "${conv.warmup}" (the first message only opens the conversation)`);
      const before = await surface.read();
      await sendText(surface, conv.warmup, 0);
      const reply = await awaitReply(surface, before, { timeout: conv.replyTimeout, settle: firstSettle, sentText: conv.warmup });
      firstSettle = conv.settle;
      result.warmup = { text: conv.warmup, reply: reply.text };
    }
    await surface.read();
    await surface.scroll({ bottom: true });
    mark('ready');
    if (conv.record.screenshots) await page.screenshot({ path: path.join(dir, '00-open.png') });

    let n = 0;
    let stopped = false; // the conversation ended early: a hand-off, or no input for type-from
    let stoppedForInput = false;
    let skipped = 0;
    for (let i = 0; i < conv.steps.length; i++) {
      const step = conv.steps[i];
      const target = result.exchanges[result.exchanges.length - 1];
      if (stopped && (!CHECKS.includes(step.type) || skipped)) { skipped++; continue; } // after a hand-off only its own checks run
      if (CHECKS.includes(step.type)) {
        const check = await runCheck(step, target, surface);
        target.checks.push(check);
        if (!check.ok) { result.flags.push(`${target.n}: ${describeFailure(check)}`); log(`   ${check.kind} ${check.pattern}: failed (flagged)`); }
        continue;
      }
      if (step.type === 'wait') {
        mark('start', i);
        await sleep(step.seconds * 1000);
        mark('waitEnd', i);
        continue;
      }
      let text = step.text;
      if (step.prompt) {
        const label = step.label || (step.fromFile ? path.basename(step.fromFile) : 'one-time code');
        log(`${n + 1}. waiting for the ${label} (UI, terminal${step.fromFile ? ` or ${step.fromFile}` : ''}; up to ${Math.round(conv.inputTimeout / 60000)} min)`);
        text = ctx.broker
          ? await ctx.broker.request({ conversation: conv.name, n: n + 1, label, file: step.fromFile, timeout: conv.inputTimeout })
          : null;
        if (text === null) { // nothing came: the recording ends at the prompt, which is still worth keeping
          result.flags.push(`${n + 1}: no ${label} was given within ${Math.round(conv.inputTimeout / 60000)} min, so the recording ends before this step`);
          log('   no input arrived: the recording ends here (flagged)');
          stopped = true;
          stoppedForInput = true;
          skipped++;
          continue;
        }
      }
      n++;
      await waitStable(surface, 30000); // nothing still arriving from the previous turn
      const before = await surface.read();
      const userIndex = before.messages.filter(m => m.role === 'user').length;
      mark('start', i);
      emit({ type: 'step', conversation: conv.name, n, kind: step.type, text: step.prompt ? '•'.repeat(text.length) : step.text || step.label });
      if (step.type === 'message') {
        log(`${n}. ${step.prompt ? `typing ${text.length} characters` : oneLine(text)}`);
        await sendText(surface, text, recordVideo ? conv.typeDelay : 0);
      } else {
        log(`${n}. click "${step.label}"`);
        await surface.click(step.label);
      }
      const sentAt = Date.now();
      mark('sent', i, sentAt);
      const reply = await awaitReply(surface, before, { timeout: conv.replyTimeout, settle: firstSettle, optional: step.type === 'click', sentText: step.type === 'message' ? text : '' });
      firstSettle = conv.settle;
      const shown = step.prompt ? `${'•'.repeat(text.length)} (typed from the ${step.label || 'prompt'})` : step.text;
      const exchange = { n, type: step.type, text: shown, label: step.label, reply: reply ? reply.text : null, seconds: null, screenshot: null, checks: [], handoff: false };
      if (reply) {
        mark('first', i, reply.first);
        mark('last', i, reply.last);
        exchange.seconds = Math.max(0, Math.round((reply.first - sentAt) / 1000));
        if (reply.warning) result.warnings.push(`${n}: ${reply.warning}`);
        if (reply.vanished) result.flags.push(`${n}: the answer appeared, then the chat showed its bubble empty, so the screenshot and the end of the video miss it`);
        if (/something went wrong/i.test(reply.text)) result.flags.push(`${n}: the agent answered with an error ("${oneLine(reply.text)}")`);
        if (reply.handoff) { stopped = true; exchange.handoff = true; }
        log(reply.handoff ? `   handed off: ${reply.handoff.replace(/\s+/g, ' ')}`
          : `   answered in ${exchange.seconds} s${reply.vanished ? ', then the bubble went empty (flagged)' : ''}`);
      } else {
        log('   no reply (fine for a click)');
      }
      if (step.type === 'message' && reply) { await surface.read(); await surface.scroll({ userIndex }); }
      mark('scroll', i);
      await sleep(300);
      if (conv.record.screenshots) {
        exchange.screenshot = `${pad(n)}-${slug(step.prompt ? 'code' : step.text || step.label)}.png`;
        const box = clip(await surface.cropBox().catch(() => null), conv.viewport);
        const shot = path.join(dir, exchange.screenshot);
        await page.screenshot({ path: shot, ...(box ? { clip: box } : {}) });
        if (looksBlank(shot, checks.minBytesPerMegapixel)) result.flags.push(`${n}: the screenshot ${exchange.screenshot} looks blank`);
        if (step.type === 'message' && reply && !reply.handoff && box) {
          const frame = await surface.chatFrame();
          const rect = await frame.evaluate(userBubbleRect, { spec: surface.spec(), userIndex }).catch(() => null);
          const offset = conv.surface === 'messaging' ? box : { x: 0, y: 0 };
          const inPage = rect && { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
          if (inPage && !mostlyInside(inPage, box)) result.flags.push(`${n}: the screenshot ${exchange.screenshot} does not show the question`);
        }
      }
      if (recordVideo && reply) await sleep(readingPause(reply.text));
      mark('read', i);
      await surface.scroll({ bottom: true });
      result.exchanges.push(exchange);
      emit({ type: 'exchange', conversation: conv.name, exchange });
    }
    if (skipped && !stoppedForInput) result.flags.push(`${n}: the agent handed the conversation off, so the ${skipped} step(s) after it were not played`);
    await sleep(500);
    mark('end');
    crop = await surface.cropBox().catch(() => null);
    if (conv.record.screenshots) await page.screenshot({ path: path.join(dir, '99-end.png') });
  } catch (e) {
    result.status = 'failed';
    result.error = e.message.split('\n')[0];
    log(`FAILED: ${result.error}`);
    if (page) await page.screenshot({ path: path.join(dir, 'error.png') }).catch(() => {});
  } finally {
    if (page) await page.close().catch(() => {});
    if (video) {
      try {
        await video.saveAs(path.join(dir, 'conversation.webm'));
        await video.delete();
      } catch (e) {
        result.warnings.push('video: ' + e.message.split('\n')[0]);
      }
    }
    if (context) await context.close().catch(() => {});
    fs.rmSync(path.join(dir, '.raw'), { recursive: true, force: true });
  }
  if (result.selectors) result.selectors.resolved = Object.fromEntries(Object.entries(tracker.seen).map(([k, v]) => [k, v.index]));

  const webm = path.join(dir, 'conversation.webm');
  if (fs.existsSync(webm) && result.status !== 'failed') {
    const end = events.find(e => e.kind === 'end');
    const segments = media.keepSegments(events, end ? end.t : Date.now() - videoStart);
    fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify({ events, segments }, null, 1));
    try {
      const mp4 = path.join(dir, 'conversation.mp4');
      log('cutting the video');
      await media.makeMp4(webm, mp4, segments);
      if (videoTooLong(await media.probeDuration(mp4), segments, checks.videoSlackSeconds)) result.flags.push('video: the MP4 is longer than its cut list: the thinking pauses may not be cut');
      if (conv.record.gif) {
        const gif = path.join(dir, 'conversation.gif');
        await media.makeGif(mp4, gif, crop, conv.viewport);
        const size = fs.statSync(gif).size;
        if (checks.gifMaxBytes && size > checks.gifMaxBytes) result.flags.push(`video: the GIF is ${(size / 1e6).toFixed(1)} MB, above the ${(checks.gifMaxBytes / 1e6).toFixed(1)} MB limit`);
        result.outputs.push('conversation.gif');
      }
      if (conv.record.video) result.outputs.push('conversation.mp4', 'conversation.webm');
      else { fs.rmSync(mp4, { force: true }); fs.rmSync(webm, { force: true }); }
    } catch (e) {
      result.warnings.push(e.message.split('\n')[0]);
      result.outputs.push('conversation.webm');
    }
  } else if (fs.existsSync(webm)) {
    result.outputs.push('conversation.webm');
  }
  if (result.status !== 'failed' && result.flags.length) result.status = 'flagged';
  result.durationMs = Date.now() - started;
  writeTranscript(conv, result, dir);
  result.outputs.unshift('transcript.md');
  log(`${result.status} in ${Math.round(result.durationMs / 1000)} s -> ${dir}`);
  emit({ type: 'conversation-end', conversation: conv.name, status: result.status, folder: conv.folder });
  return result;
}
