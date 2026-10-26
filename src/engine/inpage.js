/**
 * Functions evaluated inside the page (or the widget's frame) with Playwright's evaluate(). Playwright sends their
 * source, so each one is self-contained: no imports, no closures over this module. Every function receives the
 * candidates it needs from the selector pack, so the markup knowledge stays in packs/*.json.
 *
 * Candidate matching in page (see schema/pack.schema.json): tag, tagPattern, class, classPattern, css (el.matches),
 * role (explicit attribute) with name (aria-label, title or text), text, title, label, attr, not, within (a composed
 * ancestor, up to 12 levels, must match).
 */

/**
 * Reads the chat: messages in order (agent / user), visible system events, and whether the agent looks busy.
 * `resolved` says which candidate matched each element (-1: none), for the doctor.
 * @param {{ root: any[], agentText: any[], userText: any[], event: any[], busy: any[] }} spec
 */
export function readChat(spec) {
  const up = n => n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const accName = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim();
  const matchOne = (el, c) => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (c.tag && tag !== c.tag) return false;
    if (c.tagPattern && !new RegExp(c.tagPattern, 'i').test(tag)) return false;
    if (c.class && !(el.classList && el.classList.contains(c.class))) return false;
    if (c.classPattern && !new RegExp(c.classPattern).test(cls)) return false;
    if (c.css) { try { if (!el.matches(c.css)) return false; } catch (e) { return false; } }
    if (c.role && el.getAttribute('role') !== c.role) return false;
    if (c.name && !new RegExp(c.name, 'i').test(accName(el))) return false;
    if (c.title && !new RegExp(c.title, 'i').test(el.getAttribute('title') || '')) return false;
    if (c.label && !new RegExp(c.label, 'i').test(el.getAttribute('aria-label') || '')) return false;
    if (c.text && !new RegExp(c.text, 'i').test(el.innerText || '')) return false;
    if (c.attr) for (const [k, v] of Object.entries(c.attr)) { const a = el.getAttribute(k); if (a === null || (v !== true && !new RegExp(String(v), 'i').test(a))) return false; }
    if (c.not && matchOne(el, c.not)) return false;
    if (c.within) { let n = up(el); let k = 0; for (; n && k < 12; n = up(n), k++) if (matchOne(n, c.within)) break; if (!n || k >= 12) return false; }
    return true;
  };
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const cache = (/** @type {any} */ (window)).__afrec || ((/** @type {any} */ (window)).__afrec = {});
  const key = JSON.stringify(spec);
  if (cache.key !== key) { cache.key = key; cache.root = null; cache.chosen = { agentText: 0, userText: 0 }; }

  let root = cache.root && cache.root.isConnected ? cache.root : null;
  let rootIndex = root ? cache.rootIndex : -1;
  if (!root) {
    for (let i = 0; i < spec.root.length && !root; i++) {
      const find = node => {
        for (const el of node.children) {
          if (matchOne(el, spec.root[i])) return el;
          const hit = find(el) || (el.shadowRoot && find(el.shadowRoot));
          if (hit) return hit;
        }
        return null;
      };
      root = find(document.body) || (matchOne(document.body, spec.root[i]) ? document.body : null);
      if (root) rootIndex = i;
    }
    if (root) { cache.root = root; cache.rootIndex = rootIndex; }
  }
  const start = root || document.body;

  const scan = chosen => {
    const messages = [];
    const events = [];
    const counts = { agentText: 0, userText: 0 };
    let busy = false;
    let busyText = '';
    let busyWhy = '';
    let busyIndex = -1;
    let eventIndex = -1;
    const busyHit = el => {
      for (let i = 0; i < spec.busy.length; i++) {
        if (matchOne(el, spec.busy[i]) && shown(el)) return i;
      }
      return -1;
    };
    const describe = el => {
      const cls = typeof el.className === 'string' ? el.className.trim() : '';
      return `${el.tagName.toLowerCase()}${cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : ''}`;
    };
    const rootBusy = root ? busyHit(root) : -1;
    if (rootBusy >= 0) { busy = true; busyWhy = describe(root); busyIndex = rootBusy; }
    const elements = [];
    const walk = (node, inside) => {
      for (const el of node.children) {
        let item = false;
        if (!inside && matchOne(el, spec.agentText[chosen.agentText])) { messages.push({ role: 'agent', text: (el.innerText || '').trim() }); elements.push(el); counts.agentText++; item = true; }
        else if (!inside && matchOne(el, spec.userText[chosen.userText])) { messages.push({ role: 'user', text: (el.innerText || '').trim() }); elements.push(el); counts.userText++; item = true; }
        else if (!inside) {
          for (let i = 0; i < spec.event.length; i++) {
            if (matchOne(el, spec.event[i]) && shown(el)) {
              const text = (el.innerText || '').trim();
              if (text) events.push(text);
              if (eventIndex < 0 || i < eventIndex) eventIndex = i;
              item = true;
              break;
            }
          }
        }
        if (!busy) {
          const b = busyHit(el);
          if (b >= 0) { busy = true; busyText = (el.innerText || '').trim().slice(0, 80); busyWhy = describe(el); busyIndex = b; }
        }
        walk(el, inside || item);
        if (el.shadowRoot) walk(el.shadowRoot, inside || item);
      }
    };
    walk(start, false);
    return { busy, busyText, busyWhy, messages, events, counts, busyIndex, eventIndex, elements };
  };

  let chosen = { ...cache.chosen };
  let result = scan(chosen);
  // a kind with no match: a later candidate may match (the primary one broke), or the chat simply has none yet
  for (const kind of ['agentText', 'userText']) {
    if (result.counts[kind]) continue;
    for (let i = 0; i < spec[kind].length; i++) {
      if (i === chosen[kind]) continue;
      const trial = scan({ ...chosen, [kind]: i });
      if (trial.counts[kind]) { chosen = { ...chosen, [kind]: i }; result = trial; break; }
    }
  }
  cache.chosen = chosen;
  // the message elements, in order, for scrollChat and userBubbleRect (same matching, no second walk)
  cache.messageEls = result.elements;
  cache.userEls = result.elements.filter((el, i) => result.messages[i].role === 'user');
  return {
    busy: result.busy, busyText: result.busyText, busyWhy: result.busyWhy, messages: result.messages, events: result.events,
    resolved: {
      root: rootIndex,
      agentText: result.counts.agentText ? chosen.agentText : -1,
      userText: result.counts.userText ? chosen.userText : -1,
      busy: result.busyIndex,
      event: result.eventIndex,
    },
  };
}

/**
 * Scrolls the chat so the user's message number `userIndex` (its whole row) is at the top, or to the bottom.
 * @param {{ spec: { root: any[], userText: any[], agentText: any[], row: any[] }, bottom?: boolean, userIndex?: number }} arg
 */
export function scrollChat(arg) {
  const { spec } = arg;
  const up = n => n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const matchOne = (el, c) => {
    if (!el || !el.tagName || !c) return false;
    const tag = el.tagName.toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
    if (c.tag && tag !== c.tag) return false;
    if (c.tagPattern && !new RegExp(c.tagPattern, 'i').test(tag)) return false;
    if (c.class && !(el.classList && el.classList.contains(c.class))) return false;
    if (c.classPattern && !new RegExp(c.classPattern).test(cls)) return false;
    if (c.css) { try { if (!el.matches(c.css)) return false; } catch (e) { return false; } }
    if (c.role && el.getAttribute('role') !== c.role) return false;
    if (c.not && matchOne(el, c.not)) return false;
    if (c.within) { let n = up(el); let k = 0; for (; n && k < 12; n = up(n), k++) if (matchOne(n, c.within)) break; if (!n || k >= 12) return false; }
    return true;
  };
  // the message elements of the last readChat (the caller reads the chat just before scrolling)
  const cache = (/** @type {any} */ (window)).__afrec || {};
  const anchor = arg.bottom ? (cache.messageEls || [])[0] : (cache.userEls || [])[arg.userIndex];
  if (!anchor || !anchor.isConnected) return false;
  let scroller = null;
  for (let n = up(anchor); n && n !== document.body && n !== document.documentElement; n = up(n)) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 4) { scroller = n; break; }
  }
  if (!scroller) return false;
  if (arg.bottom) { scroller.scrollTop = scroller.scrollHeight; return true; }
  let row = anchor; // the whole chat row (avatar, name) rather than the text alone
  for (let n = anchor; n && n !== scroller; n = up(n)) if (spec.row.some(c => matchOne(n, c))) row = n;
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
  return true;
}

/**
 * The box to crop (CSS pixels of the viewport): the nearest panelBox candidate from the reader's root upward,
 * looking into each ancestor's shadow root too.
 * @param {{ panelBox: any[] }} spec
 */
export function panelBox(spec) {
  const up = n => n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const matchOne = (el, c) => {
    if (!el || !el.tagName) return false;
    if (c.class && !(el.classList && el.classList.contains(c.class))) return false;
    if (c.role && el.getAttribute('role') !== c.role) return false;
    if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
    if (c.css) { try { if (!el.matches(c.css)) return false; } catch (e) { return false; } }
    return true;
  };
  const cache = (/** @type {any} */ (window)).__afrec || {};
  const root = cache.root && cache.root.isConnected ? cache.root : null;
  if (!root) return null;
  const box = el => { const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  for (const c of spec.panelBox) {
    for (let n = root; n; n = up(n)) {
      if (n.shadowRoot) {
        for (const child of n.shadowRoot.querySelectorAll('*')) if (matchOne(child, c) && box(child)) return box(child);
      }
      if (matchOne(n, c) && box(n)) return box(n);
    }
  }
  return box(root);
}

/**
 * Structural fallback: finds the user's bubble by the text just sent, works out from its ancestry which marker says
 * "sent by the user" (outbound, outgoing, user, sent, self, mine, right...), and mirrors it for the agent's messages.
 * Returns healed candidates for userText and agentText, or null when the chat does not show the text.
 * @param {{ sentText: string }} arg
 */
export function healChat(arg) {
  const up = n => n.assignedSlot || n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const target = norm(arg.sentText);
  if (!target) return null;
  const all = [];
  const walk = node => { for (const el of node.children) { all.push(el); walk(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document.body);
  const hits = all.filter(el => !/^(textarea|input|script|style|template|option)$/i.test(el.tagName) && shown(el) && norm(el.innerText) === target);
  if (!hits.length) return null;
  let bubble = hits[hits.length - 1];
  for (let n = up(bubble); n && n !== document.body && n.tagName && norm(n.innerText) === target; n = up(n)) bubble = n;

  const MIRRORS = [
    ['outbound', 'inbound'], ['outgoing', 'incoming'], ['sent', 'received'], ['self', 'other'], ['mine', 'theirs'],
    ['end-user', 'agent'], ['enduser', 'agent'], ['customer', 'agent'], ['user', 'agent'], ['right', 'left'], ['out', 'in'],
  ];
  const STATE = /^(slds-is-|slds-has-|is-|has-|first-|last-|active|focus|selected|hover)/;
  const classesOf = el => (typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : []).filter(c => !STATE.test(c));
  const directional = c => MIRRORS.find(([mine]) => new RegExp(`(^|[-_])${mine}($|[-_])`, 'i').test(c) || (mine.length > 4 && c.toLowerCase().includes(mine)));
  const signature = el => {
    const tag = el.tagName.toLowerCase();
    const cls = classesOf(el);
    const dir = cls.find(directional);
    if (dir) return { cand: { class: dir }, dir };
    return { cand: cls.length ? { tag, class: cls.sort((a, b) => b.length - a.length)[0] } : { tag }, dir: null };
  };

  const own = signature(bubble);
  let userText = null;
  let marker = own.dir;
  if (own.dir) userText = own.cand;
  else {
    for (let n = up(bubble), k = 0; n && k < 10; n = up(n), k++) {
      const dir = classesOf(n).find(directional);
      if (dir) { userText = { ...own.cand, within: { class: dir } }; marker = dir; break; }
    }
  }
  if (!userText) return { userText: [own.cand], agentText: null, evidence: { bubble: own.cand, marker: null } };

  const [mine, theirs] = directional(marker);
  const mirroredPattern = marker.replace(new RegExp(mine, 'i'), theirs);
  const existing = all.flatMap(classesOf).find(c => c.toLowerCase() === mirroredPattern.toLowerCase());
  const agentMarker = existing ? { class: existing } : { classPattern: `(^|\\s)${mirroredPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)` };
  const agentText = userText.within ? { ...own.cand, within: agentMarker } : agentMarker;
  return { userText: [userText], agentText: [agentText], evidence: { bubble: own.cand, marker, mirrored: mirroredPattern, mirroredSeen: !!existing } };
}

/**
 * The box (viewport CSS pixels of this frame) of the user's message number `userIndex`, for the capture check.
 * @param {{ spec: { userText: any[] }, userIndex: number }} arg
 */
export function userBubbleRect(arg) {
  const cache = (/** @type {any} */ (window)).__afrec || {};
  const el = (cache.userEls || [])[arg.userIndex];
  if (!el || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/**
 * Hides elements matching the candidates (the Login-As banner), now and whenever the page changes. Used as an init
 * script, so it runs in every page of the recording.
 * @param {{ css: string, text?: string }[]} candidates
 */
export function hideMatching(candidates) {
  const hide = () => {
    for (const c of candidates) {
      for (const el of document.querySelectorAll(c.css)) {
        if (!c.text || new RegExp(c.text, 'i').test(el.textContent || '')) (/** @type {HTMLElement} */ (el)).style.setProperty('display', 'none', 'important');
      }
    }
  };
  new MutationObserver(hide).observe(document.documentElement || document, { childList: true, subtree: true });
}

/**
 * The subtree of the first element matching `rootCandidates` (or the body) as a JSON tree, shadow roots included,
 * for the doctor's snapshot. Elements that are not displayed are marked hidden. Text is NOT redacted here: the caller
 * redacts the tree before anything is written to disk.
 * @param {{ rootCandidates: any[], maxNodes?: number }} arg
 */
export function serializeTree(arg) {
  const matchOne = (el, c) => {
    if (!el || !el.tagName) return false;
    if (c.class && !(el.classList && el.classList.contains(c.class))) return false;
    if (c.role && el.getAttribute('role') !== c.role) return false;
    if (c.name && !new RegExp(c.name, 'i').test(el.getAttribute('aria-label') || el.getAttribute('title') || '')) return false;
    if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
    if (c.css) { try { if (!el.matches(c.css)) return false; } catch (e) { return false; } }
    return true;
  };
  const find = (node, c) => {
    for (const el of node.children) {
      if (matchOne(el, c)) return el;
      const hit = find(el, c) || (el.shadowRoot && find(el.shadowRoot, c));
      if (hit) return hit;
    }
    return null;
  };
  let root = null;
  for (const c of arg.rootCandidates || []) { root = find(document.body, c); if (root) break; }
  root = root || document.body;
  const max = arg.maxNodes || 20000;
  let count = 0;
  const DROP = /^(script|style|link|meta|noscript|template|base)$/i;
  const node = el => {
    if (++count > max) return null;
    const tag = el.tagName.toLowerCase();
    if (DROP.test(tag)) return null;
    const cs = getComputedStyle(el);
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const out = { tag, attrs, children: [] };
    if (cs.display === 'none' || cs.visibility === 'hidden') out.hidden = true;
    if (el.shadowRoot) out.shadow = [...el.shadowRoot.childNodes].map(child).filter(Boolean);
    if (tag === 'svg') return out; // icons: the element is enough
    out.children = [...el.childNodes].map(child).filter(Boolean);
    return out;
  };
  const child = n => (n.nodeType === 1 ? node(n) : n.nodeType === 3 ? (n.textContent.trim() ? { text: n.textContent } : null) : null);
  return { tree: node(root), truncated: count > max, url: location.origin };
}
