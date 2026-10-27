/**
 * What a run writes and plans: transcripts, report.md / report.json / report.html, the dry-run plan, and the pool that
 * runs conversations in parallel without two of the same identity at once. The last test runs executeRun itself
 * (Chromium, skipped without it unless AFREC_REQUIRE_BROWSER=1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { writeTranscript, writeRunReport, minutes } from '../src/engine/report.js';
import { describePlan, pool, planRun, executeRun } from '../src/engine/run.js';
import { readScenarioFiles } from '../src/scenario/parse.js';
import { resolveAll, assignFolders } from '../src/scenario/resolve.js';
import { loadProject } from '../src/config.js';
import { makeRun, result } from './helpers/runs.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-report-'));
const hasBrowser = fs.existsSync(chromium.executablePath());
if (!hasBrowser && process.env.AFREC_REQUIRE_BROWSER) throw new Error('Chromium is missing: npx playwright install chromium');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('durations: seconds, then minutes and seconds', () => {
  assert.equal(minutes(400), '0 s');
  assert.equal(minutes(59400), '59 s');
  assert.equal(minutes(59600), '1 min 00 s');
  assert.equal(minutes(185000), '3 min 05 s');
});

test('a transcript: the warm-up, clicks, missing replies, failed checks, flags, warnings, the failure', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'transcript-'));
  const conv = { name: 'Rider', surface: 'messaging', site: 'https://riders.example.com/s/', file: path.join(process.cwd(), 'scenarios', 'rider.md') };
  writeTranscript(conv, {
    ...result('Rider', []), agent: null, who: 'Rider Lane via Login-As', startedAt: '2026-10-26T09:30:00.000Z',
    selectors: { pack: 'messaging', version: '2026.10.1', release: "Winter '27", healed: ['agentText'] },
    warmup: { text: 'Hi', reply: 'Welcome!\nHow can I help?' },
    exchanges: [
      { n: 1, type: 'message', text: 'Extend my rental', reply: 'Until when?', seconds: 4, screenshot: '01-extend-my-rental.png', checks: [{ kind: 'expect', pattern: 'when', ok: true }] },
      { n: 2, type: 'click', label: 'Two hours', reply: null, seconds: null, screenshot: null, checks: [{ kind: 'expect', pattern: 'extended', ok: false }] },
    ],
    flags: ['2: the reply does not match extended'], warnings: ['2: the agent still looked busy after 180 s'], error: 'the page crashed',
  }, dir);
  const t = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
  assert.match(t, /^# Rider\n\n- Surface: Embedded Messaging on https:\/\/riders\.example\.com\/s\/\n- Signed in: Rider Lane via Login-As\n/);
  assert.ok(t.includes(`- Script: ${path.join('scenarios', 'rider.md')}\n`), 'relative to the working folder');
  assert.match(t, /- Selectors: messaging 2026\.10\.1 for Winter '27\n- \*\*Running on healed locators: agentText\*\*/);
  assert.match(t, /_Warm-up: "Hi" was sent first.*_\n\n> Welcome!\n> How can I help\?\n/);
  assert.match(t, /## 1\. You\n\nExtend my rental\n\n\*\*Agent\*\* \(answered in 4 s\):\n\n> Until when\?\n\n- expect `when`: ok\n\n!\[Reply 1\]\(01-extend-my-rental\.png\)/);
  assert.match(t, /## 2\. Clicked "Two hours"\n\n\*\*Agent\*\*:\n\n_no reply_\n\n- \*\*expect `extended`: the reply does not match extended \(flagged\)\*\*/);
  assert.match(t, /## Flags\n\n- 2: the reply does not match extended\n\n## Warnings\n\n- 2: the agent still looked busy after 180 s\n\n## Failed\n\nthe page crashed\n\n!\[Last screen\]\(error\.png\)/);
});

test('the run report: counts, a row per conversation with its files, healed, flags, warnings, failures and the comparison', () => {
  const out = fs.mkdtempSync(path.join(tmp, 'run-'));
  const results = [
    result('Guest one', ['Hi'], { outputs: ['transcript.md', 'conversation.gif', 'conversation.mp4', 'conversation.webm'] }),
    result('Rider', ['x'], { status: 'flagged', flags: ['1: the answer took longer than 10 s'], warnings: ['video: no ffmpeg'], selectors: { pack: 'messaging', version: '1', healed: ['userText'] } }),
    result('Fleet', [], { surface: 'lightning', status: 'failed', who: null, error: 'no Agentforce button', exchanges: [], outputs: ['transcript.md'] }),
  ];
  writeRunReport(results, { startedAt: '2026-10-26T10:00:00.000Z', durationMs: 125000, out, parallel: 2, version: '0.1.0', comparison: { baseline: '2026-10-20T10:00:00.000Z', conversations: [{ name: 'Guest one', status: 'same' }, { name: 'Rider', status: 'changed' }] } });
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(md, /3 conversation\(s\), 2 recorded, 1 flagged, 1 failed, in 2 min 05 s\./);
  assert.match(md, /\| Guest one \| Embedded Messaging \| guest visitor \| recorded \| 1 \| 30 s \| \[transcript\]\(Guest%20one\/transcript\.md\) · \[gif\]\(Guest%20one\/conversation\.gif\) · \[mp4\]\(Guest%20one\/conversation\.mp4\) \|/);
  assert.ok(!md.includes('.webm'), 'the raw WebM is not linked');
  assert.match(md, /\| Fleet \| Lightning Agentforce panel \| - \| FAILED \| 0 \|/);
  assert.match(md, /## Running on healed locators\n\n- Rider: userText\n/);
  assert.match(md, /## Flags\n\n- Rider, exchange 1: the answer took longer than 10 s\n/);
  assert.match(md, /## Warnings\n\n- Rider: video: no ffmpeg\n/);
  assert.match(md, /## Failures\n\n- Fleet: no Agentforce button \(last screen: Fleet\/error\.png\)\n/);
  assert.match(md, /## Compared with the baseline\n\n- Rider: changed\n/);
  const json = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(json.results.map(r => r.status), ['recorded', 'flagged', 'failed']);
  assert.equal(json.out, out);
  assert.match(fs.readFileSync(path.join(out, 'report.html'), 'utf8'), /^<!doctype html>/i);
  const same = fs.mkdtempSync(path.join(tmp, 'run-'));
  writeRunReport([result('Guest one', ['Hi'])], { startedAt: '2026-10-26T10:00:00.000Z', durationMs: 1000, out: same, parallel: 1, comparison: { baseline: 'x', conversations: [{ name: 'Guest one', status: 'same' }] } });
  assert.match(fs.readFileSync(path.join(same, 'report.md'), 'utf8'), /## Compared with the baseline\n\nNothing changed\./);
});

test('the plan: who signs in where, what is recorded, and which conversations queue behind each other', () => {
  const file = path.join(fs.mkdtempSync(path.join(tmp, 'plan-')), 'plan.csv');
  fs.writeFileSync(file, 'conversation,surface,org,site,user,app,record,warmup,fresh,message\n'
    + 'Fleet,lightning,myOrg,,,Service,screenshots,,,Hi\n'
    + 'Fleet again,lightning,myOrg,,,,video gif,,no,Hello\n'
    + 'Rider,messaging,myOrg,https://riders.example.com/s/,rider,,none,Hello there,,Extend my rental\n'
    + 'Guest,messaging,,https://riders.example.com/s/,,,,,,Hi\n');
  const { conversations, errors } = resolveAll(readScenarioFiles([file]));
  assert.deepEqual(errors, []);
  assignFolders(conversations);
  const lines = describePlan(conversations, 2);
  assert.equal(lines[0], '4 conversation(s), up to 2 at a time:');
  assert.match(lines[1], /^ {2}Fleet +lightning CLI user of myOrg {2}@ myOrg app Service$/);
  assert.match(lines[2], /1 message; screenshots; desktop$/);
  assert.match(lines[4], /1 message; video\+gif; desktop; keeps an open chat$/);
  assert.match(lines[5], /Rider +messaging rider \(login-as\) {2}@ https:\/\/riders\.example\.com\/s\/$/);
  assert.match(lines[6], /1 message; transcript only; desktop; warm-up "Hello there"$/);
  assert.match(lines[7], /Guest +messaging guest {2}@ https:\/\/riders\.example\.com\/s\/$/);
  assert.equal(lines.at(-1), 'Same identity, run one after the other: Fleet -> Fleet again');
});

test('the pool: at most `limit` at once, never two of one identity at once, results in input order, errors in place', async () => {
  const items = [
    { name: 'a1', identity: 'A' }, { name: 'a2', identity: 'A' }, { name: 'b', identity: 'B' }, { name: 'c', identity: 'C' }, { name: 'boom', identity: 'D' }, { name: 'a3', identity: 'A' },
  ];
  const running = new Map();
  let peak = 0;
  const order = [];
  const results = await pool(items, 2, async item => {
    assert.ok(![...running.values()].includes(item.identity), `${item.name} overlaps another ${item.identity}`);
    running.set(item.name, item.identity);
    peak = Math.max(peak, running.size);
    order.push(item.name);
    await sleep(item.identity === 'A' ? 30 : 10);
    running.delete(item.name);
    if (item.name === 'boom') throw new Error('it broke');
    return item.name.toUpperCase();
  }, (item, e) => `${item.name} failed: ${e.message}`);
  assert.deepEqual(results, ['A1', 'A2', 'B', 'C', 'boom failed: it broke', 'A3']);
  assert.equal(peak, 2);
  assert.deepEqual(order.slice(0, 2), ['a1', 'b'], 'a2 waits for a1, so b goes first');
  assert.deepEqual(await pool([], 3, async () => 1), []);
});

test('planning: the project\'s scenarios by default, --only filters and names the missing ones', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'planrun-'));
  fs.mkdirSync(path.join(root, 'scenarios'));
  fs.writeFileSync(path.join(root, 'afrec.config.json'), JSON.stringify({ defaults: { site: 'https://riders.example.com/s/' } }));
  fs.writeFileSync(path.join(root, 'scenarios', 'a.md'), '1. Hi\n');
  fs.writeFileSync(path.join(root, 'scenarios', 'b.md'), '1. Hi\n');
  const project = loadProject({ dir: root });
  assert.deepEqual(planRun({ project, inputs: [] }).conversations.map(c => [c.name, c.surface]), [['a', 'messaging'], ['b', 'messaging']]);
  const only = planRun({ project, inputs: [], only: ['b', 'z'] });
  assert.deepEqual(only.conversations.map(c => c.name), ['b']);
  assert.deepEqual(only.errors, ['--only: no conversation named z']);
  assert.equal(planRun({ project, inputs: [], defaults: { site: 'https://other.example.com/' } }).conversations[0].site, 'https://other.example.com/', 'flags win over the project defaults');
});

test('a whole run: a failing conversation is reported, the baseline compared, an output folder git does not ignore warned about', { skip: !hasBrowser && 'Chromium is not installed' }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'execute-')));
  let git = true;
  try { execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' }); } catch { git = false; }
  fs.writeFileSync(path.join(root, 'afrec.config.json'), JSON.stringify({ baseline: '20261020-100000' }));
  fs.writeFileSync(path.join(root, 'creds.txt'), 'someone@x.example pw\n');
  fs.mkdirSync(path.join(root, 'scenarios'));
  fs.writeFileSync(path.join(root, 'scenarios', 'Fleet.md'), '---\nsurface: lightning\nlogin url: https://login.example.invalid\nuser: ghost\ncredentials: ../creds.txt\n---\n1. Hi\n');
  const project = loadProject({ dir: root });
  makeRun(project.recordingsDir, '20261020-100000', [result('Fleet', ['Hello'])]);
  const { conversations, errors } = planRun({ project, inputs: [] });
  assert.deepEqual(errors, []);
  const events = [];
  const { out, results, report } = await executeRun(conversations, { project, emit: e => events.push(e) });
  assert.equal(path.dirname(out), project.recordingsDir);
  assert.deepEqual(results.map(r => [r.name, r.status]), [['Fleet', 'failed']]);
  assert.match(results[0].error, /no line for "ghost"/);
  assert.equal(report.comparison.conversations[0].status, 'changed');
  for (const f of ['report.md', 'report.json', 'report.html', 'Fleet/transcript.md']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.equal(events.filter(e => e.type === 'run-start').length, 1);
  assert.equal(events.at(-1).type, 'run-end');
  assert.deepEqual(events.at(-1).results, [{ name: 'Fleet', status: 'failed', folder: 'Fleet', error: results[0].error }]);
  if (git) assert.ok(events.some(e => e.type === 'warning' && /is not ignored by git/.test(e.message)), JSON.stringify(events.filter(e => e.type === 'warning')));
});
