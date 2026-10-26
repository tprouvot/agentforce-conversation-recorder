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
      reject(new Error(`sf ${args.slice(0, 2).join(' ')} failed: ${String(reason).split('\n')[0]}`));
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
