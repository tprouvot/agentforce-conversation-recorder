/**
 * Pack candidates as Playwright locators, and a record of which candidate matched each element. The record is what
 * `afrec doctor` reports: the first candidate matching is healthy, a later one means the primary locator broke (still
 * working, but a release changed something), none means the element is missing.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cssEscape = s => String(s).replace(/([^A-Za-z0-9_-])/g, '\\$1');
const re = s => new RegExp(s, 'i');

/**
 * One candidate as a locator in `scope` (a Page, a FrameLocator or a Locator); null when the candidate only works in
 * page (tagPattern, classPattern, attr, not).
 * @param {any} scope
 * @param {any} c
 */
export function toLocator(scope, c) {
  if (c.tagPattern || c.classPattern || c.attr || c.not) return null;
  let loc = null;
  if (c.role) loc = scope.getByRole(c.role, c.name ? { name: re(c.name) } : {});
  else if (c.css) loc = scope.locator(c.css);
  else if (c.tag) loc = scope.locator(c.tag);
  else if (c.class) loc = scope.locator('.' + cssEscape(c.class));
  else if (c.title) loc = scope.getByTitle(re(c.title));
  else if (c.label) loc = scope.getByLabel(re(c.label));
  else if (c.text) return scope.getByText(re(c.text));
  if (!loc) return null;
  return c.text ? loc.filter({ hasText: re(c.text) }) : loc;
}

/** Remembers, per element, which candidate matched first (index into the pack's list), for the doctor. */
export class Tracker {
  constructor() { this.seen = {}; }
  hit(name, index, candidate) { const s = this.seen[name]; if (!s || s.index < 0 || s.index > index) this.seen[name] = { index, candidate }; }
  miss(name) { if (!this.seen[name]) this.seen[name] = { index: -1, candidate: null }; }
  merge(resolved) { for (const [name, r] of Object.entries(resolved || {})) if (r && r.index >= 0) this.hit(name, r.index, r.candidate); }
}

/**
 * The first visible element matching the element's candidates, in order (`last`: the most recent match of a
 * candidate first, as for cards). Waits up to `timeout` ms. Returns { locator, index } or null.
 * @param {any[]} scopes
 * @param {any[]} candidates
 * @param {{ timeout?: number, last?: boolean, tracker?: Tracker, name?: string }} [options]
 */
export async function findVisible(scopes, candidates, { timeout = 0, last = false, tracker, name } = {}) {
  const end = Date.now() + timeout;
  do {
    for (let index = 0; index < candidates.length; index++) {
      for (const scope of scopes) {
        const loc = toLocator(scope, candidates[index]);
        if (!loc) continue;
        const count = await loc.count().catch(() => 0);
        for (let k = 0; k < count; k++) {
          const item = loc.nth(last ? count - 1 - k : k);
          if (await item.isVisible().catch(() => false)) {
            if (tracker && name) tracker.hit(name, index, candidates[index]);
            return { locator: item, index };
          }
        }
      }
    }
    if (Date.now() >= end) break;
    await sleep(700);
  } while (Date.now() < end);
  if (tracker && name && timeout > 0) tracker.miss(name); // a single poll (timeout 0) is not a miss yet
  return null;
}

/**
 * The first element matching the candidates that exists (visible or not): a scope such as the panel, whose host is
 * often a `display: contents` custom element that Playwright never calls visible. Returns { locator, index } or null.
 * @param {any[]} scopes
 * @param {any[]} candidates
 * @param {{ tracker?: Tracker, name?: string }} [options]
 */
export async function findExisting(scopes, candidates, { tracker, name } = {}) {
  for (let index = 0; index < candidates.length; index++) {
    for (const scope of scopes) {
      const loc = toLocator(scope, candidates[index]);
      if (loc && await loc.count().catch(() => 0)) {
        if (tracker && name) tracker.hit(name, index, candidates[index]);
        return { locator: loc.first(), index };
      }
    }
  }
  return null;
}

/** `label` is matched as a case-insensitive substring, or as a regex when written /like this/. */
export function labelCandidates(label) {
  const literal = label.match(/^\/(.+)\/([a-z]*)$/);
  const pattern = literal ? literal[1] : label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // icon buttons sometimes carry another role (the reply's Like/Dislike/Copy are radios), hence title and aria-label too
  return [...['button', 'link', 'menuitem', 'option', 'radio', 'tab', 'checkbox'].map(role => ({ role, name: pattern })),
    { title: pattern }, { label: pattern }, ...(literal ? [] : [{ text: `^${pattern}$` }]), { text: pattern }];
}
