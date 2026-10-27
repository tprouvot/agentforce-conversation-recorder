/**
 * Whole conversations through the player, on the fake org's Lightning panel: sign-in, messages, checks, clicks,
 * waits, a hand-off, a failure; screenshots and the transcript. Needs Chromium and a POSIX shell (helpers/player-env.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { usePlayerEnv } from './helpers/player-env.js';
import { recordHealing } from '../src/selectors/packs.js';

const env = usePlayerEnv();
const { skip } = env;
const FRONT = '---\nsurface: lightning\norg: fake\nsettle: 1\ntype delay: 0\nreply timeout: 30\nviewport: 1280x800\nrecord: screenshots\n';

test('a Lightning conversation: messages, checks, a click, a wait, one screenshot per answer, the transcript', { skip }, async () => {
  const { result, dir, events, read } = await env.play(`${FRONT}---
# Rider

1. Hi
   - expect: /hello/i
   - max-seconds: 20
2. How much is a two-hour ride?
   - expect: \\$8
   - expect-not: sorry
   - expect-button: Reserve
3. click: Reserve
   - expect: reserved
4. wait: 1
5. Is the bike broken?
`);
  assert.equal(result.error, null);
  assert.equal(result.who, 'admin@fake.example (CLI user of fake)');
  assert.deepEqual(result.exchanges.map(x => [x.n, x.type, x.reply]), [
    [1, 'message', 'Hello! I can find stations and prices.'],
    [2, 'message', 'A two-hour ride costs $8.'],
    [3, 'click', 'Your bike is reserved until 5 pm.'],
    [4, 'message', 'Sorry, something went wrong.'],
  ]);
  assert.deepEqual(result.exchanges.map(x => x.checks.map(c => `${c.kind}:${c.ok}`)), [
    ['expect:true', 'max-seconds:true'], ['expect:true', 'expect-not:true', 'expect-button:true'], ['expect:true'], [],
  ]);
  assert.deepEqual(result.flags, ['4: the agent answered with an error ("Sorry, something went wrong.")']);
  assert.equal(result.status, 'flagged');
  assert.deepEqual(result.exchanges.map(x => x.screenshot), ['01-hi.png', '02-how-much-is-a-two-hour.png', '03-reserve.png', '04-is-the-bike-broken.png']);
  for (const f of ['00-open.png', ...result.exchanges.map(x => x.screenshot), '99-end.png']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.deepEqual(result.outputs, ['transcript.md'], 'no video was asked for');
  assert.equal(result.selectors.pack, 'lightning');
  assert.equal(result.selectors.apiVersion, 66);
  assert.equal(result.selectors.resolved.launcher, 0);
  assert.equal(result.selectors.resolved.input, 0);
  const sessions = env.org.requests.filter(q => q.path === '/lightning/page/home' && q.cookies.sid === 'SESSION-fake');
  assert.ok(sessions.length >= 2, 'signed in off camera, then recorded with the same session');

  const transcript = read('transcript.md');
  assert.match(transcript, /^# Player\n/, 'named after the file');
  assert.match(transcript, /- Surface: Lightning Agentforce panel\n- Signed in: admin@fake\.example \(CLI user of fake\)/);
  assert.match(transcript, /## 2\. You\n\nHow much is a two-hour ride\?\n\n\*\*Agent\*\* \(answered in \d+ s\):\n\n> A two-hour ride costs \$8\./);
  assert.match(transcript, /- expect-button `Reserve`: ok/);
  assert.match(transcript, /## 3\. Clicked "Reserve"/);
  assert.match(transcript, /!\[Reply 4\]\(04-is-the-bike-broken\.png\)/);
  assert.match(transcript, /## Flags\n\n- 4: the agent answered with an error/);

  const kinds = events.map(e => e.type);
  assert.equal(kinds[0], 'conversation-start');
  assert.equal(kinds.filter(k => k === 'exchange').length, 4);
  assert.deepEqual(events.at(-1), { type: 'conversation-end', conversation: 'Player', status: 'flagged', folder: 'Player' });
});

test('a hand-off ends the conversation: its own checks still run, the steps after it are skipped and flagged', { skip }, async () => {
  const { result, read } = await env.play(`${FRONT}agent: Fleet Assistant
---
1. Hi
2. Can I talk to a human?
   - expect: left
3. Are you still there?
   - expect: never checked
`);
  assert.equal(result.agent, 'Fleet Assistant');
  assert.equal(result.exchanges.length, 2);
  const handoff = result.exchanges[1];
  assert.equal(handoff.handoff, true);
  assert.equal(handoff.reply, '(handed off: Assistant left the conversation)');
  assert.deepEqual(handoff.checks.map(c => c.ok), [true]);
  assert.deepEqual(result.flags, ['2: the agent handed the conversation off, so the 2 step(s) after it were not played']);
  assert.match(read('transcript.md'), /- Surface: Lightning Agentforce panel, agent Fleet Assistant\n/);
});

test('a conversation that cannot sign in fails with the reason, and still writes its transcript', { skip }, async () => {
  const creds = path.join(env.tmp, 'creds.txt');
  fs.writeFileSync(creds, 'someone@fake.example secret\n');
  const stateDir = path.join(env.tmp, 'state-healed');
  recordHealing(stateDir, 'lightning', { userText: [{ class: 'slds-chat-message__text_outbound' }] }, { apiVersion: 66, packVersion: '2026.10.1' });
  const { result, read } = await env.play(`---\nsurface: lightning\nlogin url: ${env.org.url}\nuser: ghost\ncredentials: ${creds}\n---\n1. Hi\n`, { stateDir });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, `no line for "ghost" in ${creds}`);
  assert.deepEqual(result.selectors.healed, ['userText'], 'the healed overrides were picked up before the failure');
  const transcript = read('transcript.md');
  assert.match(transcript, /\*\*Running on healed locators: userText\*\*/);
  assert.match(transcript, /## Failed\n\nno line for "ghost"/);
  assert.match(transcript, /- Signed in: \(not signed in\)/);
});
