import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readScenarioFiles, parseScenarioText, toMarkdown } from '../src/scenario/parse.js';
import { resolveConversation } from '../src/scenario/resolve.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-test-'));
const write = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };

test('markdown: front matter, steps, nested checks, multi-line message, escape, notes', () => {
  const file = write('Rider.md', [
    '---', 'surface: lightning', 'org: myOrg', 'user: fleet.manager', '---',
    '# Title', 'A note that is ignored.', '',
    '1. Hi', '   - expect: Hello',
    '2. First line', '   second line', '',
    '3. click: "Confirm"', '4. wait: 2', '5. \\wait: this is a message', '- expect: /yes|no/',
  ].join('\n'));
  const [raw] = readScenarioFiles([file]);
  assert.deepEqual(raw.steps.map(s => s.type), ['message', 'expect', 'message', 'click', 'wait', 'message', 'expect']);
  assert.equal(raw.steps[2].text, 'First line\nsecond line');
  assert.equal(raw.steps[3].label, 'Confirm');
  assert.equal(raw.steps[5].text, 'wait: this is a message');
  const conv = resolveConversation(raw);
  assert.equal(conv.signIn, 'login-as');
  assert.equal(conv.identity, 'lightning|myOrg|fleet.manager');
});

test('markdown: the new checks, type-from prompt and file, comments after directives', () => {
  const file = write('Checks.md', [
    '---', 'site: https://x.example.com/', '---',
    '1. Hi',
    '2. How much is a two-hour ride?', '   - expect: /\\d/', '   - expect-not: sorry|went wrong', '   - max-seconds: 20', '   - expect-button: /reserve/',
    '3. type-from: prompt one-time code   # from the rider\'s email',
    '4. type-from: /tmp/afrec-code.txt',
  ].join('\n'));
  const conv = resolveConversation(readScenarioFiles([file])[0]);
  assert.deepEqual(conv.steps.map(s => s.type), ['message', 'message', 'expect', 'expect-not', 'max-seconds', 'expect-button', 'message', 'message']);
  assert.equal(conv.steps[4].seconds, 20);
  assert.equal(conv.steps[5].label, '/reserve/');
  assert.deepEqual([conv.steps[6].prompt, conv.steps[6].fromFile, conv.steps[6].label], [true, null, 'one-time code']);
  assert.equal(conv.steps[7].fromFile, '/tmp/afrec-code.txt');
  assert.equal(conv.inputTimeout, 600000);
});

test('markdown: an unknown setting is an error, and a schema violation names the setting', () => {
  assert.throws(() => readScenarioFiles([write('Typo.md', '---\nsit: https://x.example.com/\n---\n1. Hi\n')]), /unknown setting "sit"/);
  const raw = readScenarioFiles([write('Bad.md', '---\nsite: https://x.example.com/\nviewport: huge\n---\n1. Hi\n')])[0];
  assert.throws(() => resolveConversation(raw), /viewport/);
});

test('csv: semicolons, quoted multi-line cell, grouping, inheritance, check columns', () => {
  const file = write('Sheet.csv', 'conversation;surface;site;user;message;expect;max seconds\n'
    + 'Guest;messaging;https://x.example.com/s/;;Hi;;\n'
    + ';;;;"Two lines\nhere";line;15\n'
    + 'Rider;messaging;https://x.example.com/s/;rider.demo;Hi;;\n');
  const raws = readScenarioFiles([file]);
  assert.deepEqual(raws.map(r => r.name), ['Guest', 'Rider']);
  assert.deepEqual(raws[0].steps.map(s => s.type), ['message', 'message', 'expect', 'max-seconds']);
  assert.equal(raws[0].steps[1].text, 'Two lines\nhere');
  const guest = resolveConversation(raws[0]);
  assert.equal(guest.signIn, 'guest');
  assert.equal(guest.needsWarmup, false);
  assert.throws(() => resolveConversation(raws[1]), /Login-As to the site needs org/);
  assert.equal(resolveConversation(raws[1], { org: 'myOrg' }).signIn, 'login-as');
});

test('csv: two values of one setting in a conversation are an error', () => {
  const file = write('Conflict.csv', 'conversation,site,message\nA,https://a.example.com/,Hi\nA,https://b.example.com/,Hello\n');
  assert.throws(() => readScenarioFiles([file]), /two values for site/);
});

test('inference: warm-up, password, alias user, agent only on Lightning, booleans from CSV strings', () => {
  const creds = write('creds.txt', 'u@x.com secret  (note)\n');
  const conv = resolveConversation(readScenarioFiles([write('Warm.md', `---\nsite: https://x.example.com/\nuser: u\ncredentials: ${creds}\n---\n1. Which stations have bikes?\n`)])[0]);
  assert.equal(conv.surface, 'messaging');
  assert.equal(conv.signIn, 'password');
  assert.equal(conv.needsWarmup, true);
  assert.equal(resolveConversation(readScenarioFiles([write('Alias.md', '---\nsurface: lightning\norg: myOrg\n---\n1. Hi\n')])[0]).signIn, 'alias-user');
  const picked = resolveConversation(readScenarioFiles([write('Agent.md', '---\norg: myOrg\nagent: Fleet Assistant\n---\n1. Hi\n')])[0]);
  assert.equal(picked.surface, 'lightning');
  assert.equal(picked.agent, 'Fleet Assistant');
  assert.throws(() => resolveConversation(readScenarioFiles([write('AgentSite.md', '---\nsite: https://x.example.com/\nagent: X\n---\n1. Hi\n')])[0]), /agent: is for the Lightning panel/);
  const csv = readScenarioFiles([write('Bool.csv', 'surface,org,fresh,hide login as banner,user,message\nlightning,myOrg,no,yes,fleet.manager,Hi\n')])[0];
  const resolved = resolveConversation(csv);
  assert.equal(resolved.fresh, false);
  assert.equal(resolved.hideLoginAsBanner, true);
});

test('an expect before any message is an error', () => {
  assert.throws(() => resolveConversation(readScenarioFiles([write('Early.md', '---\nsite: https://x.example.com/\n---\n- expect: x\n1. Hi\n')])[0]), /comes before any message/);
});

test('toMarkdown round-trips settings and steps', () => {
  const steps = [
    { type: 'message', text: 'Hi' }, { type: 'expect', display: 'hello' },
    { type: 'message', text: 'wait: a message that looks like a directive' },
    { type: 'click', label: '/confirm/' }, { type: 'message', prompt: true, fromFile: null, label: 'one-time code' },
    { type: 'max-seconds', seconds: 30 }, { type: 'wait', seconds: 2 },
  ];
  const text = toMarkdown({ settings: { surface: 'messaging', site: 'https://x.example.com/' }, steps, title: 'Demo' });
  const [raw] = parseScenarioText(text, 'demo.md');
  assert.equal(raw.settings.site, 'https://x.example.com/');
  assert.deepEqual(raw.steps.map(s => s.type), ['message', 'expect', 'message', 'click', 'message', 'max-seconds', 'wait']);
  assert.equal(raw.steps[2].text, 'wait: a message that looks like a directive');
  assert.equal(raw.steps[4].prompt, true);
});

test('the e-bike examples parse and resolve', () => {
  const dir = new URL('../examples/ebike/', import.meta.url).pathname;
  const raws = readScenarioFiles([dir]);
  assert.ok(raws.length >= 5, `${raws.length} conversations`);
  for (const r of raws) resolveConversation(r, { org: 'myAdminAlias' });
});
