/**
 * Redaction of doctor snapshots, so they can become public fixtures: the structure stays (tags, classes, roles,
 * shadow roots, which elements are hidden), the content goes. Text and free-text attributes keep only words from the
 * chat UI's own vocabulary (Send, Clear history, End chat...); every other word becomes x's of the same length,
 * digits become 0, and emails, URLs and Salesforce Ids are replaced. Org names, agent names, people and answers do
 * not survive, while the labels the selector packs rely on do.
 */

const UI_WORDS = `a about agent agentforce agents ago ai an and anything as ask assistant at attach attachment avatar back
  bot busy by cancel chat chats clear click close conversation conversations confirm continue copilot copy describe
  dislike done einstein end ended error feedback file files for from give go got hello help here hi history i in input is
  it joined just leave left like list loading log logged mail make me menu message messages minimize minutes mistakes
  more my new no now of ok on open options or out panel powered question recommendations reply retry salesforce
  seconds select send sent show something start starting status stop submit switch task text thank thanks the thinking
  this to today transferring transferred type typing up view wait was we welcome went window with wrong yes you your
  can what how do does are be will would please there`.split(/\s+/).filter(Boolean);
const ARIA_WORDS = `alert article banner button cell checkbox columnheader combobox complementary contentinfo dialog document
  feed figure form grid gridcell group heading img level link list listbox listitem log main menu menubar menuitem
  navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup search
  searchbox separator slider spinbutton status switch tab table tablist tabpanel text textbox timer toolbar tooltip
  tree treeitem disabled expanded checked selected pressed placeholder url`.split(/\s+/).filter(Boolean);
export const ALLOW = new Set(UI_WORDS);
const ALLOW_ARIA = new Set([...UI_WORDS, ...ARIA_WORDS]);

const KEEP_ATTRS = new Set(['class', 'role', 'type', 'tabindex', 'slot', 'part', 'dir', 'hidden', 'disabled', 'readonly', 'checked',
  'aria-hidden', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'aria-disabled', 'aria-live', 'aria-busy',
  'aria-modal', 'aria-haspopup', 'aria-level', 'aria-orientation', 'aria-atomic', 'aria-relevant', 'autocomplete', 'contenteditable', 'shadowrootmode']);
const TEXT_ATTRS = new Set(['aria-label', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt', 'label', 'value', 'name']);
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'action', 'poster', 'data', 'formaction']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Redacts free text: UI vocabulary stays, everything else is masked; emails and URLs become placeholders. */
export function redactText(text, allow = ALLOW) {
  // split out emails and URLs first (odd parts), so their placeholders are not masked again
  return String(text).split(/([\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/[^\s"'<>]+)/).map((part, i) => {
    if (i % 2) return part.includes('@') && !/^https?:/.test(part) ? 'user@example.invalid' : 'https://example.invalid/';
    return part
      .replace(/\p{L}[\p{L}\p{M}'’-]*/gu, w => (allow.has(w.toLowerCase()) ? w : 'x'.repeat(w.length)))
      .replace(/\d/g, '0');
  }).join('');
}

/**
 * An id or class keeps its shape without its digits (record Ids, generated ids). A custom component of the org's own
 * namespace (c-...) can carry the org's name, so its letters are masked too.
 */
const scrubToken = v => (/^c-/i.test(v) ? 'c-' + String(v).slice(2).replace(/\p{L}/gu, 'x') : String(v)).replace(/\d/g, '0');
const scrubTag = tag => (/^c-/i.test(tag) ? scrubToken(tag) : tag);

/** `tag`: a slot keeps its name, which must match the `slot` attribute of the elements it shows. */
export function redactAttrs(attrs, tag = '') {
  const out = {};
  for (const [name, value] of Object.entries(attrs || {})) {
    if (name === 'style' || name.startsWith('on')) continue;
    if (name === 'name' && tag === 'slot') out.name = value;
    else if (name === 'id') out.id = scrubToken(value);
    else if (name === 'class') out.class = String(value).split(/\s+/).filter(Boolean).map(scrubToken).join(' ');
    else if (KEEP_ATTRS.has(name)) out[name] = value;
    else if (TEXT_ATTRS.has(name)) out[name] = redactText(value);
    else if (URL_ATTRS.has(name)) out[name] = name === 'src' || name === 'href' ? '#' : '';
    else if (name.startsWith('data-') || name.startsWith('aria-')) out[name] = redactText(value);
    else if (/^[a-z][a-z0-9-]*$/.test(name)) out[name] = /^(true|false|\d+|)$/.test(value) ? value : redactText(value);
  }
  return out;
}

/** A serialized tree (inpage.serializeTree) with its text and attributes redacted. */
export function redactTree(node) {
  if (!node) return null;
  if (node.text !== undefined) return { text: redactText(node.text) };
  return {
    tag: scrubTag(node.tag), attrs: redactAttrs(node.attrs, node.tag), hidden: node.hidden || undefined,
    shadow: node.shadow ? node.shadow.map(redactTree).filter(Boolean) : undefined,
    children: (node.children || []).map(redactTree).filter(Boolean),
  };
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** HTML for a (redacted) tree; shadow roots as declarative shadow DOM, undisplayed elements with `hidden`. */
export function renderHtml(node, indent = '') {
  if (!node) return '';
  if (node.text !== undefined) return indent + escapeHtml(node.text.trim()) + '\n';
  const attrs = { ...node.attrs };
  if (node.hidden) attrs.hidden = '';
  const open = `${indent}<${node.tag}${Object.entries(attrs).map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`)).join('')}>`;
  if (VOID.has(node.tag)) return open + '\n';
  let inner = '';
  if (node.shadow && node.shadow.length) inner += `${indent}  <template shadowrootmode="open">\n${node.shadow.map(n => renderHtml(n, indent + '    ')).join('')}${indent}  </template>\n`;
  inner += (node.children || []).map(n => renderHtml(n, indent + '  ')).join('');
  return inner ? `${open}\n${inner}${indent}</${node.tag}>\n` : `${open}</${node.tag}>\n`;
}

/** A Playwright ARIA snapshot (YAML) with its names and texts redacted; role names stay. */
export function redactAria(yaml) {
  return String(yaml).split('\n').map(line => {
    const m = line.match(/^(\s*-\s*)(\/?[\w-]+)(.*)$/);
    if (!m) return redactText(line, ALLOW_ARIA);
    return m[1] + m[2] + redactText(m[3], ALLOW_ARIA);
  }).join('\n');
}

/** Terms from the denylist found in `text` (case-insensitive), for the pre-commit check and fixtures add. */
export function denylistHits(text, terms) {
  const lower = String(text).toLowerCase();
  return terms.filter(t => t && lower.includes(t.toLowerCase()));
}
