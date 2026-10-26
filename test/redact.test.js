import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactAttrs, redactTree, renderHtml, redactAria, denylistHits } from '../src/doctor/redact.js';

test('text: UI vocabulary stays, names, emails, URLs, Ids and digits go', () => {
  const out = redactText('Hi Jordan, I am the Harbor Lights Assistant. Write to jordan.lee@harbor.example or see https://harbor.example/x?id=001Ab00000XyZ12AAA. Send 42');
  assert.ok(!/Jordan|Harbor|Lights|harbor\.example|001Ab|42/.test(out), out);
  assert.match(out, /^Hi x{6}, I x{2} the x{6} x{6} Assistant\. /);
  assert.match(out, /user@example\.invalid/);
  assert.match(out, /https:\/\/example\.invalid\//);
  assert.match(out, /Send 00$/);
});

test('attributes: structure kept, free text redacted, URLs and styles dropped', () => {
  const out = redactAttrs({
    class: 'slds-chat-message__text_inbound record-001Ab00000XyZ12', id: 'msg-123', role: 'listitem', 'aria-label': 'Harbor Lights Assistant',
    title: 'Clear history', placeholder: 'Type your message...', href: 'https://harbor.example/', style: 'color:red', onclick: 'x()', 'data-name': 'Jordan',
  });
  assert.equal(out.class, 'slds-chat-message__text_inbound record-000Ab00000XyZ00');
  assert.equal(out.id, 'msg-000');
  assert.equal(out.role, 'listitem');
  assert.equal(out['aria-label'], 'xxxxxx xxxxxx Assistant');
  assert.equal(out.title, 'Clear history');
  assert.equal(out.placeholder, 'Type your message...');
  assert.equal(out.href, '#');
  assert.equal(out.style, undefined);
  assert.equal(out.onclick, undefined);
  assert.equal(out['data-name'], 'xxxxxx');
  assert.equal(redactAttrs({ name: 'body' }, 'slot').name, 'body', 'a slot keeps its name, or slotted content disappears');
  assert.equal(redactAttrs({ name: 'Jordan' }, 'input').name, 'xxxxxx');
});

test('tree: shadow roots become declarative shadow DOM, hidden elements stay hidden, org components are masked', () => {
  const tree = { tag: 'div', attrs: { class: 'einstein-assistant-container' }, children: [
    { tag: 'c-harbor-banner', attrs: { class: 'c-harbor-banner' }, children: [{ text: 'Welcome to Harbor Lights' }] },
    { tag: 'runtime_copilot_base-message-block', attrs: { role: 'listitem' }, shadow: [{ tag: 'div', attrs: { class: 'slds-chat-message__text_inbound' }, children: [{ text: 'Your rental R-1042 ends at 5 pm' }] }], children: [] },
    { tag: 'span', attrs: {}, hidden: true, children: [{ text: 'Thinking' }] },
  ] };
  const html = renderHtml(redactTree(tree));
  assert.match(html, /<template shadowrootmode="open">/);
  assert.match(html, /<span hidden>/);
  assert.match(html, /c-xxxxxx-xxxxxx/);
  assert.ok(!/Harbor|harbor|1042|rental/.test(html), html);
  assert.match(html, /Thinking/);
});

test('aria snapshots keep roles and UI labels only', () => {
  const out = redactAria('- region "Chat History":\n  - listitem:\n    - img "Harbor Assistant"\n    - paragraph: Your bike at Pier 9 is ready, Jordan.\n- button "Send" [disabled]');
  assert.ok(!/Harbor|Pier|Jordan|bike/.test(out), out);
  assert.match(out, /region "Chat History"/);
  assert.match(out, /button "Send" \[disabled\]/);
});

test('denylist hits are case-insensitive', () => {
  assert.deepEqual(denylistHits('a page about HARBOR lights', ['Harbor Lights', 'nothing']), ['Harbor Lights']);
});
