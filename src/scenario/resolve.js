/**
 * Turns a raw conversation into a validated, fully resolved one: defaults applied (project config, then command-line
 * flags, then the file), settings checked against schema/scenario.schema.json, the surface and the sign-in method
 * inferred, and the identity computed (two conversations with the same identity never run at the same time).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadSchema, validate } from '../schema.js';
import { CHECKS } from './parse.js';

const SETTINGS_SCHEMA = loadSchema('scenario').properties.settings;
const GREETING = /^\s*(hi|hello|hey|hiya|good (morning|afternoon|evening)|bonjour|salut|hola|hallo|ciao)\b/i;
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, scale: 2, mobile: false },
  mobile: { width: 390, height: 844, scale: 3, mobile: true },
};
const RECORD_KINDS = ['screenshots', 'video', 'gif'];
const SURFACE_ALIASES = {
  lightning: 'lightning', panel: 'lightning', agentforce: 'lightning',
  messaging: 'messaging', widget: 'messaging', miaw: 'messaging', site: 'messaging', embedded: 'messaging', experience: 'messaging',
};

/** CSV cells and flags are strings: give booleans and numbers their type before validating. */
function coerce(settings, where) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || value === null || value === '') continue;
    const type = SETTINGS_SCHEMA.properties[key] && SETTINGS_SCHEMA.properties[key].type;
    if (type === 'boolean' && typeof value === 'string') {
      if (/^(true|yes|y|1|on)$/i.test(value)) out[key] = true;
      else if (/^(false|no|n|0|off)$/i.test(value)) out[key] = false;
      else throw new Error(`${where}: ${key} must be true or false, got "${value}"`);
    } else if (type === 'number' && typeof value === 'string') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${where}: ${key} must be a number, got "${value}"`);
      out[key] = n;
    } else if (type === 'string' && typeof value !== 'string') {
      out[key] = String(value);
    } else if (key === 'surface') {
      out[key] = SURFACE_ALIASES[String(value).toLowerCase()] || String(value).toLowerCase();
    } else {
      out[key] = value;
    }
  }
  if (out.surface) out.surface = SURFACE_ALIASES[String(out.surface).toLowerCase()] || out.surface;
  return out;
}

function resolveFile(value, conversationFile, key) {
  const candidates = [path.resolve(String(value)), path.resolve(path.dirname(conversationFile), String(value))];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error(`${conversationFile}: ${key} file not found: ${value}`);
  return found;
}

function parseViewport(v) {
  const key = String(v || 'desktop').toLowerCase();
  if (VIEWPORTS[key]) return { name: key, ...VIEWPORTS[key] };
  const m = key.match(/^(\d{3,4})x(\d{3,4})$/);
  return { name: key, width: Number(m[1]), height: Number(m[2]), scale: 2, mobile: false };
}

function parseRecord(v, where) {
  if (v === undefined || v === null || v === '' || v === 'all') return { screenshots: true, video: true, gif: true };
  const list = (Array.isArray(v) ? v : String(v).split(/[\s,;+]+/)).map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const out = { screenshots: false, video: false, gif: false };
  for (const item of list) {
    const kind = { screenshot: 'screenshots', png: 'screenshots', mp4: 'video', videos: 'video', gifs: 'gif' }[item] || item;
    if (kind === 'none') continue;
    if (!RECORD_KINDS.includes(kind)) throw new Error(`${where}: record accepts ${RECORD_KINDS.join(', ')}, got "${item}"`);
    out[kind] = true;
  }
  return out;
}

/**
 * @param {{name: string, file: string, settings: object, steps: any[]}} raw
 * @param {object} [defaults] settings that apply when the file leaves them out (config defaults, then flags)
 */
export function resolveConversation(raw, defaults = {}) {
  const where = raw.file;
  const s = coerce({ ...defaults, ...raw.settings }, where);
  const problems = validate(s, SETTINGS_SCHEMA).map(p => p.replace(/^\(root\): /, ''));
  if (problems.length) throw new Error(`${where}: ${problems.join('; ')}`);
  const conv = { name: String(s.name || raw.name), file: raw.file, steps: raw.steps };

  conv.surface = s.surface || (s.site ? 'messaging' : (s.app || s.path || s.agent) ? 'lightning' : '');
  if (!conv.surface) throw new Error(`${where}: set surface: lightning or surface: messaging (or give site:)`);

  conv.org = s.org;
  conv.authUrl = s.authUrl ? resolveFile(s.authUrl, where, 'authUrl') : undefined;
  conv.user = s.user ? s.user.trim() : undefined;
  conv.credentials = s.credentials ? resolveFile(s.credentials, where, 'credentials') : undefined;
  conv.app = s.app;
  conv.path = s.path;
  conv.site = s.site;
  conv.loginUrl = s.loginUrl;
  conv.network = s.network;
  conv.agent = s.agent;
  conv.viewport = parseViewport(s.viewport);
  conv.record = parseRecord(s.record, where);
  conv.fresh = s.fresh !== false;
  conv.hideLoginAsBanner = s.hideLoginAsBanner === true;
  conv.replyTimeout = (s.replyTimeout || 180) * 1000;
  conv.settle = (s.settle === undefined ? 5 : s.settle) * 1000;
  conv.inputTimeout = (s.inputTimeout || 600) * 1000;
  conv.typeDelay = s.typeDelay === undefined ? 35 : s.typeDelay;
  const warmup = s.warmup === undefined ? '' : String(s.warmup).trim();
  conv.warmup = /^(false|no|off|0)$/i.test(warmup) ? false : /^(true|yes|on|1)?$/i.test(warmup) ? 'Hi' : warmup;

  if (conv.authUrl && !conv.org) conv.org = 'afrec-' + path.parse(conv.authUrl).name.replace(/[^A-Za-z0-9]/g, '');
  if (conv.surface === 'lightning') {
    if (!conv.org && !(conv.credentials && conv.loginUrl)) throw new Error(`${where}: a Lightning conversation needs org: (a sf alias) or authUrl:`);
    conv.signIn = conv.user && conv.credentials ? 'password' : conv.user ? 'login-as' : 'alias-user';
    if (conv.viewport.mobile) throw new Error(`${where}: the Lightning panel needs a desktop viewport`);
  } else {
    if (!conv.site) throw new Error(`${where}: a messaging conversation needs site: (the page where the chat widget loads)`);
    if (conv.agent) throw new Error(`${where}: agent: is for the Lightning panel; on Messaging the site's deployment decides the agent`);
    conv.signIn = !conv.user ? 'guest' : conv.credentials ? 'password' : 'login-as';
    if (conv.signIn === 'login-as' && !conv.org) throw new Error(`${where}: Login-As to the site needs org: (the admin sf alias), or give credentials:`);
  }
  if (conv.hideLoginAsBanner && !(conv.surface === 'lightning' && conv.signIn === 'login-as')) conv.hideLoginAsBanner = false;

  const exchanges = conv.steps.filter(st => st.type === 'message' || st.type === 'click');
  if (!exchanges.length) throw new Error(`${where}: "${conv.name}" has no message to send`);
  const firstExchange = conv.steps.indexOf(exchanges[0]);
  const early = conv.steps.findIndex(st => CHECKS.includes(st.type));
  if (early >= 0 && early < firstExchange) throw new Error(`${conv.steps[early].where}: "${conv.steps[early].type}:" comes before any message`);
  const first = exchanges[0];
  conv.needsWarmup = conv.surface === 'messaging' && conv.warmup !== false && !(first.type === 'message' && GREETING.test(first.text || ''));

  const host = conv.surface === 'lightning' ? conv.org || conv.loginUrl : new URL(conv.site).host;
  conv.identity = `${conv.surface}|${host}|${conv.signIn === 'guest' ? 'guest:' + conv.name : conv.user || 'alias-user'}`;
  return conv;
}

/** Resolves every raw conversation; returns the conversations and the errors (one per conversation that failed). */
export function resolveAll(raws, defaults = {}) {
  const conversations = [];
  const errors = [];
  for (const r of raws) {
    try { conversations.push(resolveConversation(r, defaults)); } catch (e) { errors.push(e.message); }
  }
  return { conversations, errors };
}

/** Gives each conversation a unique, file-system-safe folder name. */
export function assignFolders(conversations) {
  const used = new Set();
  for (const c of conversations) {
    const base = c.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'conversation';
    let folder = base;
    for (let k = 2; used.has(folder.toLowerCase()); k++) folder = `${base}-${k}`;
    used.add(folder.toLowerCase());
    c.folder = folder;
  }
  return conversations;
}
