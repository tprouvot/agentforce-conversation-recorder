import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awaitReply, findEcho } from '../src/engine/reply.js';
import { keepSegments } from '../src/engine/media.js';

/** A surface whose read() walks through scripted chat states, one per poll. */
function scripted(states, extra = {}) {
  let i = 0;
  return { read: async () => states[Math.min(i++, states.length - 1)], ...extra };
}
const chat = (messages, extra = {}) => ({ busy: false, busyText: '', busyWhy: '', events: [], messages, resolved: {}, ...extra });
const U = text => ({ role: 'user', text });
const A = text => ({ role: 'agent', text });
const quick = { timeout: 20000, settle: 1000 };

test('reply: waits while busy, then returns the settled answer', async () => {
  const before = chat([A('Welcome'), U('Hi'), A('Hello')]);
  const s = scripted([chat([...before.messages, U('Q')]), chat([...before.messages, U('Q')], { busy: true }),
    chat([...before.messages, U('Q'), A('Part')]), chat([...before.messages, U('Q'), A('Part one, done')])]);
  const r = await awaitReply(s, before, { ...quick, sentText: 'Q' });
  assert.equal(r.text, 'Part one, done');
});

test('reply: a late answer to the previous message stays out', async () => {
  const before = chat([U('Hi'), A('Welcome')]);
  const s = scripted([chat([U('Hi'), A('Welcome'), A('Late hello'), U('Q'), A('The answer')])]);
  assert.equal((await awaitReply(s, before, { ...quick, sentText: 'Q' })).text, 'The answer');
});

test('echo: anchored on the sent text, even when the panel re-renders without its history', () => {
  const before = chat([A('Welcome'), U('Old question'), A('Old answer')]);
  assert.equal(findEcho(chat([A('Welcome'), U('Old question'), A('Old answer'), U('Which stations have bikes?')]), before, 'Which stations have bikes?'), 3);
  assert.equal(findEcho(chat([A('Welcome'), U('Which stations have bikes?')]), before, 'Which stations have bikes?'), 1);
  assert.equal(findEcho(chat([A('Welcome'), U('Old question'), A('Old answer')]), before, 'Which stations have bikes?'), -1);
  const twice = chat([U('Hi'), A('Hello')]);
  assert.equal(findEcho(chat([U('Hi'), A('Hello'), U('Hi')]), twice, 'Hi'), 2, 'the same text sent again is the new bubble');
  assert.equal(findEcho(chat([U('Hi Sent · Just now')]), chat([]), 'Hi'), 0, 'a bubble with meta text still matches');
});

test('reply: an answer whose bubble goes empty is kept and marked vanished', async () => {
  const before = chat([U('Hi'), A('Hello')]);
  const s = scripted([chat([U('Hi'), A('Hello'), U('Q'), A('Full answer')]), chat([U('Hi'), A('Hello'), U('Q'), A('')])]);
  const r = await awaitReply(s, before, { timeout: 30000, settle: 500, sentText: 'Q' });
  assert.equal(r.text, 'Full answer');
  assert.equal(r.vanished, true);
});

test('reply: a hand-off to a human ends the wait within seconds, and says so', async () => {
  const before = chat([U('Hi'), A('Hello')]);
  const s = scripted([chat([U('Hi'), A('Hello'), U('Q')], { events: ['Assistant left'], busy: true, busyText: 'Transferring...' })]);
  const t0 = Date.now();
  const r = await awaitReply(s, before, { timeout: 60000, settle: 1000, sentText: 'Q' });
  assert.ok(r.handoff && /left/.test(r.text), JSON.stringify(r));
  assert.ok(Date.now() - t0 < 20000);
});

test('reply: a click with no answer returns null', async () => {
  const before = chat([U('Hi'), A('Hello')]);
  const r = await awaitReply(scripted([before]), before, { timeout: 30000, settle: 1000, optional: true });
  assert.equal(r, null);
});

test('reply: when the bubble never shows, the structural fallback gets one chance', async () => {
  const before = chat([]);
  let healed = 0;
  let states = [chat([])];
  const s = {
    read: async () => states[0],
    heal: async text => { healed++; assert.equal(text, 'Q'); states = [chat([U('Q'), A('Found by structure')])]; return { evidence: {} }; },
  };
  const r = await awaitReply(s, before, { timeout: 30000, settle: 500, sentText: 'Q' });
  assert.equal(healed, 1);
  assert.equal(r.text, 'Found by structure');
});

test('video cut: thinking shortened, waits kept to a second, segments merged and sorted', () => {
  const events = [
    { kind: 'ready', step: null, t: 10000 },
    { kind: 'start', step: 0, t: 11000 }, { kind: 'sent', step: 0, t: 13000 },
    { kind: 'first', step: 0, t: 25000 }, { kind: 'last', step: 0, t: 28000 },
    { kind: 'scroll', step: 0, t: 34000 }, { kind: 'read', step: 0, t: 37000 },
    { kind: 'start', step: 1, t: 38000 }, { kind: 'waitEnd', step: 1, t: 48000 },
    { kind: 'end', step: null, t: 50000 },
  ];
  const segments = keepSegments(events, 50000);
  const kept = segments.reduce((sum, [a, b]) => sum + b - a, 0);
  assert.ok(kept < 20000, `kept ${kept} ms`);
  assert.ok(segments.every(([a, b], i) => a < b && (i === 0 || segments[i - 1][1] < a)));
  assert.ok(!segments.some(([a, b]) => a < 20000 && b > 15000), 'the middle of the 12 s thinking pause is cut');
  assert.ok(segments.some(([a, b]) => a <= 38000 && b >= 39000) && !segments.some(([a, b]) => a < 45000 && b > 40000), 'a 10 s wait keeps one second');
});
