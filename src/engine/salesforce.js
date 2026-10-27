/**
 * Thin wrappers around the sf CLI: org details, single-use frontdoor URLs, SOQL and sfdx auth URL logins. The tool
 * signs in only through these documented `--json` commands, never by scripting the login page (except the
 * development-only password login). Frontdoor URLs carry a session: callers never print them.
 */
import { execFile } from 'node:child_process';

/** @returns {Promise<any>} the `result` of `sf <args> --json` */
export function sf(args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SF_DISABLE_TELEMETRY: 'true', SF_AUTOUPDATE_DISABLE: 'true', SF_SKIP_NEW_VERSION_CHECK: 'true' };
    const windows = process.platform === 'win32'; // sf is sf.cmd there, which needs a shell
    const quoted = windows ? [...args, '--json'].map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : [...args, '--json'];
    execFile('sf', quoted, { encoding: 'utf8', timeout, maxBuffer: 50 * 1024 * 1024, env, shell: windows }, (err, stdout) => {
      const text = stdout || '';
      const start = text.indexOf('{');
      let json = null;
      if (start >= 0) {
        try { json = JSON.parse(text.slice(start)); } catch { json = null; }
      }
      if (json && json.status === 0) return resolve(json.result);
      const reason = (json && (json.message || json.name)) || (err && /** @type {any} */ (err).code === 'ENOENT' ? 'the sf CLI is not installed (npm install --global @salesforce/cli)' : err && err.message) || 'failed';
      const lines = String(reason).trim().split('\n');
      reject(new Error(`sf ${args.slice(0, 2).join(' ')} failed: ${/ERROR at Row/.test(reason) ? lines[lines.length - 1] : lines[0]}`)); // a SOQL error ends with its reason
    });
  });
}

const orgs = new Map();

/** { alias, id, instanceUrl, username, apiVersion } of an authorized org, cached per process. */
export function orgInfo(alias) {
  if (!orgs.has(alias)) {
    const pending = sf(['org', 'display', '--target-org', alias]).then(r => ({
      alias, id: r.id, instanceUrl: String(r.instanceUrl).replace(/\/$/, ''), username: r.username, apiVersion: Number(r.apiVersion) || null,
    }));
    pending.catch(() => orgs.delete(alias));
    orgs.set(alias, pending);
  }
  return orgs.get(alias);
}

/** A single-use URL that signs the browser in as the alias's user. */
export async function frontdoorUrl(alias, targetPath) {
  const args = ['org', 'open', '--url-only', '--target-org', alias];
  if (targetPath) args.push('--path', targetPath);
  return (await sf(args)).url;
}

export async function query(alias, soql, { tooling = false } = {}) {
  return (await sf(['data', 'query', '--target-org', alias, '--query', soql, ...(tooling ? ['--use-tooling-api'] : [])])).records || [];
}

/** Authorizes the org of an sfdx auth URL file under an alias (the same username simply refreshes its auth). */
export async function loginSfdxUrl(file, alias) {
  await sf(['org', 'login', 'sfdx-url', '--sfdx-url-file', file, '--alias', alias], { timeout: 300000 });
}

/**
 * The orgs the sf CLI knows: [{ alias, username, connected, sandbox }] (no secrets). Without `check`, connection
 * status is skipped: checking every org can take a minute.
 */
export async function listOrgs({ check = false } = {}) {
  const r = await sf(['org', 'list', ...(check ? [] : ['--skip-connection-status'])], { timeout: 120000 });
  const all = [...(r.nonScratchOrgs || []), ...(r.scratchOrgs || []), ...(r.sandboxes || []), ...(r.devHubs || []), ...(r.other || [])];
  const seen = new Map();
  for (const o of all) {
    if (seen.has(o.username)) continue;
    seen.set(o.username, { alias: o.alias || null, username: o.username, connected: check ? o.connectedStatus === 'Connected' || o.status === 'Active' : null, sandbox: !!o.isSandbox, scratch: !!o.isScratch });
  }
  return [...seen.values()];
}

export const soqlString = v => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The active user matching a full username, the part before the @, or a full name. */
export async function findUser(alias, key) {
  const where = key.includes('@') ? `Username = ${soqlString(key)}`
    : /\s/.test(key) ? `Name = ${soqlString(key)}`
      : `Username LIKE ${soqlString(key.replace(/[%_]/g, '\\$&') + '@%')}`;
  const rows = await query(alias, `SELECT Id, Username, Name, ContactId FROM User WHERE IsActive = true AND ${where}`);
  if (!rows.length) throw new Error(`no active user "${key}" in ${alias}`);
  if (rows.length > 1) throw new Error(`"${key}" matches ${rows.length} users in ${alias} (${rows.map(r => r.Username).join(', ')}): give the full username`);
  return rows[0];
}

/** The Experience Cloud site (Network) a community user belongs to; `wanted` is a site name or Id. */
export async function findNetwork(alias, user, wanted) {
  const rows = await query(alias, `SELECT NetworkId, Network.Name, Network.Status FROM NetworkMember WHERE MemberId = ${soqlString(user.Id)}`);
  if (!rows.length) throw new Error(`${user.Username} is not a member of any Experience Cloud site`);
  const picked = wanted
    ? rows.filter(r => r.NetworkId.slice(0, 15) === String(wanted).slice(0, 15) || r.Network.Name.toLowerCase() === String(wanted).toLowerCase())
    : rows;
  if (picked.length === 1) return { id: picked[0].NetworkId, name: picked[0].Network.Name };
  const names = rows.map(r => r.Network.Name).join(', ');
  throw new Error(wanted ? `${user.Username} is not a member of a site named "${wanted}" (member of: ${names})`
    : `${user.Username} belongs to several sites (${names}): set network: to one of them`);
}

/** Agents with an active version: [{ developerName, label, type }] (type InternalCopilot: employee agent). */
export async function activeAgents(alias) {
  const rows = await query(alias, "SELECT BotDefinition.DeveloperName, BotDefinition.MasterLabel, BotDefinition.Type FROM BotVersion WHERE Status = 'Active'");
  const seen = new Map();
  for (const r of rows) {
    const b = r.BotDefinition || {};
    if (!seen.has(b.DeveloperName)) seen.set(b.DeveloperName, { developerName: b.DeveloperName, label: b.MasterLabel, type: b.Type || null });
  }
  return [...seen.values()];
}

/** The active agent named `name` (label or API name), or an error listing the active ones. */
export async function findAgent(alias, name) {
  const agents = await activeAgents(alias);
  const key = String(name).toLowerCase();
  const hit = agents.find(a => String(a.label).toLowerCase() === key || String(a.developerName).toLowerCase() === key);
  if (!hit) throw new Error(`no active agent "${name}" in ${alias} (active: ${agents.map(a => a.label).join(', ') || 'none'})`);
  return hit;
}

const RECORD_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const LOCAL_SUFFIX = /_(?:16j|179)[a-zA-Z0-9]{12}$/; // a topic or action local to one planner ends with its parent's Id
const oneLine = text => (text ? String(text).replace(/\s+/g, ' ').trim() : null);

/**
 * GenAiPlannerFunctionDef.Plugin and GenAiPluginFunctionDef.Function hold a record Id (a topic or action of this
 * agent) or a developer name (a standard one, `ns__Name` when namespaced). Returns the records found, by value.
 */
async function definitions(alias, object, fields, values, prefix) {
  const ids = [...new Set(values.filter(v => RECORD_ID.test(v) && v.startsWith(prefix)))];
  const names = [...new Set(values.filter(v => !RECORD_ID.test(v)))];
  const where = [];
  if (ids.length) where.push(`Id IN (${ids.map(soqlString).join(', ')})`);
  if (names.length) where.push(`DeveloperName IN (${names.map(n => soqlString(n.split('__').pop())).join(', ')})`);
  const found = new Map();
  if (!where.length) return found;
  const rows = await query(alias, `SELECT Id, DeveloperName, NamespacePrefix, MasterLabel, Description, ${fields} FROM ${object} WHERE ${where.join(' OR ')}`);
  for (const v of values) {
    const hit = RECORD_ID.test(v) ? rows.find(r => r.Id.slice(0, 15) === v.slice(0, 15))
      : rows.find(r => (r.NamespacePrefix ? `${r.NamespacePrefix}__${r.DeveloperName}` : r.DeveloperName) === v);
    if (hit) found.set(v, hit);
  }
  return found;
}

const label = (value, row) => (row ? row.MasterLabel : value.split('__').pop().replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
const action = (value, row) => ({ name: row ? row.DeveloperName.replace(LOCAL_SUFFIX, '') : value, label: label(value, row), description: oneLine(row && row.Description), confirm: !!(row && row.IsConfirmationRequired) });

/**
 * What an active agent can do, from its active version's planner: { version, planner, topics, actions }, each topic
 * { name, label, description, scope, instructions, actions }, each action { name, label, description, confirm }.
 * `actions` are the ones outside any topic. A standard topic or action the org does not describe keeps its name.
 */
export async function agentTopics(alias, developerName) {
  const [version] = await query(alias, `SELECT Id, VersionNumber FROM BotVersion WHERE Status = 'Active' AND BotDefinition.DeveloperName = ${soqlString(developerName)} ORDER BY VersionNumber DESC LIMIT 1`);
  if (!version) throw new Error(`${developerName} has no active version in ${alias}`);
  const planners = await query(alias, 'SELECT Id, DeveloperName, LinkedBotVersionId FROM GenAiPlannerDefinition'); // LinkedBotVersionId cannot be filtered on
  const planner = planners.find(p => p.LinkedBotVersionId && p.LinkedBotVersionId.slice(0, 15) === version.Id.slice(0, 15))
    || planners.find(p => p.DeveloperName === `${developerName}_v${version.VersionNumber}`) || planners.find(p => p.DeveloperName === developerName);
  if (!planner) throw new Error(`no planner for version ${version.VersionNumber} of ${developerName} in ${alias}`);
  const attached = (await query(alias, `SELECT Plugin FROM GenAiPlannerFunctionDef WHERE PlannerId = ${soqlString(planner.Id)}`)).map(r => r.Plugin).filter(Boolean);
  const [plugins, loose] = await Promise.all([
    definitions(alias, 'GenAiPluginDefinition', 'Scope', attached, '179'),
    definitions(alias, 'GenAiFunctionDefinition', 'IsConfirmationRequired', attached.filter(v => !(RECORD_ID.test(v) && v.startsWith('179'))), '172'),
  ]);
  const topicIds = [...plugins.values()].map(r => r.Id);
  const [links, instructions] = topicIds.length ? await Promise.all([
    query(alias, `SELECT PluginId, Function FROM GenAiPluginFunctionDef WHERE PluginId IN (${topicIds.map(soqlString).join(', ')})`),
    query(alias, `SELECT GenAiPluginDefinitionId, Description FROM GenAiPluginInstructionDef WHERE GenAiPluginDefinitionId IN (${topicIds.map(soqlString).join(', ')}) ORDER BY SortOrder`),
  ]) : [[], []];
  const functions = await definitions(alias, 'GenAiFunctionDefinition', 'IsConfirmationRequired', links.map(l => l.Function).filter(Boolean), '172');
  const topics = attached.filter(v => plugins.has(v) || !loose.has(v)).map(v => {
    const row = plugins.get(v);
    return {
      name: row ? row.DeveloperName.replace(LOCAL_SUFFIX, '') : v,
      label: label(v, row),
      description: oneLine(row && row.Description),
      scope: oneLine(row && row.Scope),
      instructions: row ? instructions.filter(i => i.GenAiPluginDefinitionId === row.Id).map(i => String(i.Description || '').trim()).filter(Boolean) : [],
      actions: row ? links.filter(l => l.PluginId === row.Id && l.Function).map(l => action(l.Function, functions.get(l.Function))) : [],
    };
  });
  topics.sort((a, b) => a.label.localeCompare(b.label));
  const actions = attached.filter(v => loose.has(v)).map(v => action(v, loose.get(v)));
  return { version: version.VersionNumber, planner: planner.DeveloperName, topics, actions };
}
