/**
 * `afrec new`: a scenario file to start from. With an org, its settings are checked there (the agent, the user and,
 * on Messaging, the user's site) and the file lists, in a comment, what the agent can do: the topics and actions of
 * its active version. The messages are left to the author (a person or a coding agent): the tool never invents them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { activeAgents, findAgent, agentTopics, findUser, findNetwork } from '../engine/salesforce.js';
import { toMarkdown } from './parse.js';
import { resolveConversation, SURFACE_ALIASES } from './resolve.js';

const ORDER = ['surface', 'org', 'agent', 'user', 'network', 'site', 'app', 'path'];
const KIND = { InternalCopilot: 'employee agent' };
const kind = agent => KIND[agent.type] || 'service agent';
/** A path for messages: relative to the current folder when inside it. */
export const shownPath = file => { const rel = path.relative(process.cwd(), file); return rel && !rel.startsWith('..') ? rel : file; };
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : text);

/** The surface the settings ask for, or the one the agent lives on; null when nothing tells. */
export function draftSurface(settings, agent = null) {
  if (settings.surface) return SURFACE_ALIASES[String(settings.surface).toLowerCase()] || String(settings.surface);
  if (settings.site) return 'messaging';
  if (settings.app || settings.path) return 'lightning';
  if (agent) return agent.type === 'InternalCopilot' ? 'lightning' : 'messaging';
  return null;
}

/**
 * What the org says: { agents, agent, topics, user, warnings }. `agent` is the one named by `settings.agent`, or the
 * only active agent of the surface; `topics` is what it can do (agentTopics); `user` the signed-in user, checked.
 * @param {Record<string, any>} settings the command-line flags over the project's defaults
 */
export async function draftFacts(settings) {
  const facts = { agents: [], agent: null, topics: null, user: null, warnings: [] };
  const org = settings.org;
  if (!org) return facts;
  const [agents, user] = await Promise.all([activeAgents(org), settings.user && !settings.credentials ? findUser(org, settings.user) : null]);
  facts.agents = agents;
  const surface = draftSurface(settings);
  if (settings.agent) facts.agent = await findAgent(org, settings.agent);
  else {
    const fits = agents.filter(a => !surface || (surface === 'lightning') === (a.type === 'InternalCopilot'));
    const what = surface === 'lightning' ? 'employee agent' : surface === 'messaging' ? 'service agent' : 'agent';
    if (fits.length === 1) facts.agent = fits[0];
    else if (fits.length) throw new Error(`${org} has ${fits.length} active ${what}s (${fits.map(a => `${a.label}${surface ? '' : `, ${kind(a)}`}`).join('; ')}): pass --agent <label>`);
    else facts.warnings.push(`${org} has no active ${what}`);
  }
  if (facts.agent) {
    try { facts.topics = await agentTopics(org, facts.agent.developerName); } catch (e) { facts.warnings.push(`could not read what ${facts.agent.label} can do: ${e.message}`); }
  }
  if (user) {
    facts.user = { username: user.Username, name: user.Name, community: !!user.ContactId };
    if (draftSurface(settings, facts.agent) === 'messaging') facts.user.site = (await findNetwork(org, user, settings.network)).name;
  }
  return facts;
}

/**
 * The front matter to write: the flags (the project's defaults stay inherited), the surface always, and on Lightning
 * the agent found. On Messaging the site's deployment decides the agent, so `agent:` is left out.
 */
export function draftSettings(flags, facts, defaults = {}) {
  const surface = draftSurface({ ...defaults, ...flags }, facts.agent);
  const s = { ...flags, surface };
  if (surface === 'messaging') delete s.agent;
  else if (facts.agent) s.agent = facts.agent.label;
  if (!surface) delete s.surface;
  return Object.fromEntries([...ORDER.filter(k => s[k] !== undefined), ...Object.keys(s).filter(k => !ORDER.includes(k))].map(k => [k, s[k]]));
}

/** The file to write: `name` as a path when it ends with .md, else <scenarios>/<name>.md; by default the agent's name. */
export function draftFile(project, name, agent = null) {
  if (name && /\.md$/i.test(name)) return path.resolve(name);
  const base = (name || (agent ? agent.label : 'conversation')).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'conversation';
  return path.join(project.scenariosDir, `${base}.md`);
}

function signedIn(conv, facts) {
  const who = facts.user ? `${facts.user.name} (${facts.user.username})` : conv.user;
  switch (conv.signIn) {
    case 'alias-user': return `the sf CLI user of ${conv.org}. Add user: <username> to log in as someone else (Login-As).`;
    case 'guest': return `nobody: a guest visitor. For a signed-in member of the site, add user: <username>${conv.org ? '' : ' and org: <admin alias>'} (Login-As).`;
    case 'password': return `${who}, with the password from ${path.basename(conv.credentials)} (development only).`;
    default: return `${who}${facts.user && facts.user.site ? ` on ${facts.user.site}` : ''}, by Login-As from ${conv.org}.`;
  }
}

function capabilities(conv, facts, date) {
  if (!facts.topics) {
    if (!conv.org) return ['Run afrec new again with --org <alias> to list here what the agent can do.'];
    return facts.agent ? [`What ${facts.agent.label} can do could not be read from ${conv.org} (afrec new prints why).`] : [];
  }
  const { version, topics, actions } = facts.topics;
  const lines = [`${facts.agent.label} (version ${version}, read from ${conv.org} on ${date}) can do this:`];
  if (conv.surface === 'messaging') lines.push(`(On Messaging the site's deployment picks the agent: this is the right list only if ${facts.agent.label} is the one deployed there.)`);
  const act = a => `  Action "${a.label}"${a.confirm ? ' (asks to confirm: answer it, or click: its button)' : ''}${a.description ? `: ${clip(a.description, 200)}` : ''}`;
  for (const t of topics) {
    lines.push('', `Topic "${t.label}"${t.description ? `: ${clip(t.description, 300)}` : ''}`);
    if (t.scope) lines.push(`  Scope: ${clip(t.scope, 300)}`);
    lines.push(...t.actions.map(act));
  }
  if (actions.length) lines.push('', 'Outside any topic:', ...actions.map(act));
  if (!topics.length && !actions.length) lines.push('', 'no topic or action found in its planner.');
  return lines;
}

/**
 * The text of the new scenario: the front matter, a title, and a comment with how to write the steps, who signs in,
 * and what the agent can do. It has no step yet: until a message is written, a run stops with "has no message".
 * Throws when the settings are not valid (the same check as a run).
 * @param {{ file: string, settings: Record<string, any>, facts: any, defaults?: Record<string, any>, date?: string }} options
 */
export function draftScenario({ file, settings, facts, defaults = {}, date = new Date().toISOString().slice(0, 10) }) {
  const conv = resolveConversation({ name: path.parse(file).name, file, settings, steps: [{ type: 'message', text: 'Hi', where: file }] }, defaults);
  const rel = shownPath(file);
  const comment = [
    'Write the conversation below: one numbered item per message, and under it the checks on its answer. For example:',
    '',
    '1. What can you help me with?',
    '   - expect-not: sorry|went wrong',
    '2. <a question for one of the topics below>',
    '   - expect: <words its answer must contain, a regex: price|cost>',
    '3. click: /confirm|yes/',
    '',
    'Steps: a message, click: <label or /regex/>, wait: <seconds>, type-from: prompt one-time code.',
    'Checks: expect: <regex>, expect-not: <regex>, expect-button: <label>, max-seconds: <seconds>.',
    'Every message spends agent credits and can run real actions. Check the plan first:',
    `  afrec run --dry-run ${rel}`,
    'Reference: docs/SCENARIOS.md in the afrec repository.',
    '',
    `Signed in: ${signedIn(conv, facts)}`,
    '',
    ...capabilities(conv, facts, date),
  ].map(l => l.replace(/-->/g, '-- >'));
  return `${toMarkdown({ settings, title: facts.agent ? facts.agent.label : conv.name }).trimEnd()}\n\n<!--\n${comment.join('\n').trimEnd()}\n-->\n`;
}

/** Writes the new scenario file; refuses to overwrite one unless `force`. Returns its text. */
export function writeDraft(options, { force = false } = {}) {
  if (fs.existsSync(options.file) && !force) throw new Error(`${shownPath(options.file)} already exists (use --force to overwrite)`);
  const text = draftScenario(options);
  fs.mkdirSync(path.dirname(options.file), { recursive: true });
  fs.writeFileSync(options.file, text);
  return text;
}
