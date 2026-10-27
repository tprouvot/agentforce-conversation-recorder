/**
 * The player's recordings and prompts: a Messaging guest recorded to MP4 and GIF with the thinking cut, and a
 * one-time code typed from the prompt (masked everywhere) or never given. Needs Chromium and a POSIX shell
 * (helpers/player-env.js); the video goes through ffmpeg-static.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { usePlayerEnv } from './helpers/player-env.js';
import { InputBroker } from '../src/engine/input.js';
import { probeDuration } from '../src/engine/media.js';

const env = usePlayerEnv();
const { skip } = env;

test('a Messaging guest recorded to MP4 and GIF: the timeline is cut, the raw video kept, the frame cropped', { skip }, async () => {
  const { result, dir, read } = await env.play('---\nsite: {site}/s/\nsettle: 1\nviewport: 1280x800\n---\n1. Hi\n   - expect: stations\n');
  assert.equal(result.error, null);
  assert.equal(result.who, 'guest visitor');
  assert.equal(result.exchanges[0].reply, 'Hello! I can find stations and prices.');
  assert.deepEqual(result.outputs, ['transcript.md', 'conversation.gif', 'conversation.mp4', 'conversation.webm']);
  assert.deepEqual(result.flags, []);
  assert.equal(result.status, 'recorded');
  assert.ok(!fs.existsSync(path.join(dir, '.raw')), 'the raw recording folder is cleaned up');
  const timeline = JSON.parse(read('timeline.json'));
  assert.deepEqual(['ready', 'start', 'sent', 'first', 'last', 'scroll', 'read', 'end'].filter(k => !timeline.events.some(e => e.kind === k)), []);
  const kept = timeline.segments.reduce((sum, [a, b]) => sum + b - a, 0) / 1000;
  const mp4 = await probeDuration(path.join(dir, 'conversation.mp4'));
  const webm = timeline.events.find(e => e.kind === 'end').t / 1000;
  assert.ok(Math.abs(mp4 - kept) < 1.5, `the MP4 (${mp4} s) is its cut list (${kept} s)`);
  assert.ok(mp4 < webm, `the MP4 (${mp4} s) is shorter than the raw recording (${webm} s)`);
  assert.equal(fs.readFileSync(path.join(dir, 'conversation.gif')).subarray(0, 6).toString(), 'GIF89a');
  assert.match(read('transcript.md'), /- Surface: Embedded Messaging on http:\/\/127\.0\.0\.1:\d+\/s\//);
});

test('a one-time code from the prompt is typed into the chat but never shown, logged or written', { skip }, async () => {
  const broker = new InputBroker();
  const asked = [];
  broker.on('request', r => { asked.push(r); setTimeout(() => broker.answer(r.id, '424242'), 200); });
  const { result, events, read } = await env.play('---\nsurface: lightning\norg: fake\nsettle: 1\ntype delay: 0\nrecord: none\n---\n1. Hi\n2. type-from: prompt one-time code\n', { broker });
  assert.deepEqual(asked.map(r => [r.conversation, r.n, r.label]), [['Player', 2, 'one-time code']]);
  assert.equal(result.exchanges.length, 2);
  assert.equal(result.exchanges[1].text, '•••••• (typed from the one-time code)');
  assert.equal(result.exchanges[1].reply, 'Hello! I can find stations and prices.', 'the code reached the chat');
  assert.ok(!JSON.stringify(events).includes('424242'), 'not in the progress events');
  assert.ok(!JSON.stringify(result).includes('424242'), 'not in the result');
  assert.ok(!read('transcript.md').includes('424242'), 'not in the transcript');
  assert.deepEqual(result.outputs, ['transcript.md'], 'record: none keeps the transcript only');
});

test('a prompt with nobody to answer it (no broker) ends the recording there, flagged, without the hand-off flag', { skip }, async () => {
  const { result } = await env.play('---\nsurface: lightning\norg: fake\nsettle: 1\ntype delay: 0\nrecord: none\n---\n1. Hi\n2. type-from: prompt one-time code\n3. Thanks\n   - expect: never checked\n');
  assert.equal(result.exchanges.length, 1);
  assert.deepEqual(result.flags, ['2: no one-time code was given within 10 min, so the recording ends before this step']);
  assert.equal(result.status, 'flagged');
});
