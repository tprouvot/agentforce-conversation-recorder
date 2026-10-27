/** The sf CLI wrappers, against the fake sf of helpers/fake-sf.js (POSIX only). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sf, orgInfo, frontdoorUrl, query, loginSfdxUrl, listOrgs, soqlString, findUser, findNetwork, activeAgents, findAgent } from '../src/engine/salesforce.js';
import { installFakeSf, fakeSfSupported } from './helpers/fake-sf.js';

const skip = !fakeSfSupported && 'the fake sf CLI needs a POSIX shell';
let fake;
before(() => { if (!skip) fake = installFakeSf(); });
after(() => { if (fake) fake.restore(); });
const lastQuery = () => { const c = fake.calls().at(-1); return c[c.indexOf('--query') + 1]; };

test('SOQL strings: quotes and backslashes escaped', () => {
  assert.equal(soqlString("O'Brien"), "'O\\'Brien'");
  assert.equal(soqlString('a\\b'), "'a\\\\b'");
});

test('sf: the result on success; on failure the CLI\'s message, or why it did not run', { skip }, async () => {
  fake.setRules([
    { match: '^org list', result: { ok: 1 } },
    { match: '^org display --target-org broken', error: 'No authorization information found for broken.\nRun sf org login web' },
    { match: '^org display --target-org noisy', raw: 'Warning: a new version of sf is available\n{"status":0,"result":{"fine":true}}' },
    { match: '^org display --target-org garbage', raw: 'not json at all', exit: 1 },
    { match: '^data query', error: "\nSELECT Id FROM Nothing\n               ^\nERROR at Row:1:Column:16\nsObject type 'Nothing' is not supported." },
  ]);
  assert.deepEqual(await sf(['org', 'list']), { ok: 1 });
  assert.deepEqual(fake.calls().at(-1), ['org', 'list', '--json']);
  await assert.rejects(sf(['org', 'display', '--target-org', 'broken']), /^Error: sf org display failed: No authorization information found for broken\.$/);
  assert.deepEqual(await sf(['org', 'display', '--target-org', 'noisy']), { fine: true }, 'text before the JSON is skipped');
  await assert.rejects(sf(['org', 'display', '--target-org', 'garbage']), /sf org display failed: Command failed/);
  await assert.rejects(sf(['data', 'query', '--query', 'SELECT Id FROM Nothing']), /^Error: sf data query failed: sObject type 'Nothing' is not supported\.$/, 'a SOQL error ends with its reason');
  const path = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    await assert.rejects(sf(['org', 'list']), /the sf CLI is not installed \(npm install --global @salesforce\/cli\)/);
  } finally { process.env.PATH = path; }
});

test('org info: the instance without its trailing slash, cached per alias, a failure not cached', { skip }, async () => {
  fake.setRules([{ match: '^org display --target-org cached', result: { id: '00D1', instanceUrl: 'https://acme.my.salesforce.com/', username: 'admin@acme.example', apiVersion: '66.0' } }]);
  const info = await orgInfo('cached');
  assert.deepEqual(info, { alias: 'cached', id: '00D1', instanceUrl: 'https://acme.my.salesforce.com', username: 'admin@acme.example', apiVersion: 66 });
  const before = fake.calls().length;
  await Promise.all([orgInfo('cached'), orgInfo('cached')]);
  assert.equal(fake.calls().length, before, 'asked once per process');
  await assert.rejects(orgInfo('later'), /no rule/);
  fake.setRules([{ match: '^org display --target-org later', result: { id: '00D2', instanceUrl: 'https://later.my.salesforce.com', username: 'u', apiVersion: 'x' } }]);
  assert.equal((await orgInfo('later')).apiVersion, null, 'retried after the failure; an odd version is null');
});

test('frontdoor URLs, queries (data or tooling), and sfdx-url logins pass the right arguments', { skip }, async () => {
  fake.setRules([
    { match: '^org open', result: { url: 'https://acme.my.salesforce.com/secur/frontdoor.jsp?sid=X' } },
    { match: '^data query', result: { records: [{ Id: 1 }] } },
    { match: '^org login sfdx-url', result: {} },
  ]);
  assert.equal(await frontdoorUrl('acme', '/lightning/setup/Home'), 'https://acme.my.salesforce.com/secur/frontdoor.jsp?sid=X');
  assert.deepEqual(fake.calls().at(-1), ['org', 'open', '--url-only', '--target-org', 'acme', '--path', '/lightning/setup/Home', '--json']);
  await frontdoorUrl('acme');
  assert.ok(!fake.calls().at(-1).includes('--path'));
  assert.deepEqual(await query('acme', 'SELECT Id FROM EmbeddedServiceConfig', { tooling: true }), [{ Id: 1 }]);
  assert.ok(fake.calls().at(-1).includes('--use-tooling-api'));
  await loginSfdxUrl('/secrets/acme.txt', 'acme-ci');
  assert.deepEqual(fake.calls().at(-1), ['org', 'login', 'sfdx-url', '--sfdx-url-file', '/secrets/acme.txt', '--alias', 'acme-ci', '--json']);
});

test('users: by full username, full name, or the part before the @; none or several is an error', { skip }, async () => {
  const jordan = { Id: '0051', Username: 'jordan@acme.example', Name: 'Jordan Lee', ContactId: null };
  fake.setRules([
    { match: "Username LIKE 'many@%'", result: { records: [jordan, { ...jordan, Username: 'many@other.example' }] } },
    { match: "Username LIKE 'ghost@%'", result: { records: [] } },
    { match: 'FROM User', result: { records: [jordan] } },
  ]);
  assert.equal((await findUser('acme', 'jordan@acme.example')).Id, '0051');
  assert.match(lastQuery(), /WHERE IsActive = true AND Username = 'jordan@acme\.example'$/);
  await findUser('acme', "Jordan O'Lee");
  assert.match(lastQuery(), /AND Name = 'Jordan O\\'Lee'$/);
  await assert.rejects(findUser('acme', 'ghost'), /no active user "ghost" in acme/);
  await assert.rejects(findUser('acme', 'many'), /"many" matches 2 users in acme \(jordan@acme\.example, many@other\.example\): give the full username/);
});

// In a SOQL string, \_ and \% are LIKE's literal _ and %, and \\ is a backslash. findUser escapes the wildcards, then
// soqlString escapes that backslash again: 'fleet\\_manager@%' looks for a backslash, so fleet_manager@... never matches.
test('users: an underscore or a percent sign in the part before the @ is matched literally', { skip, todo: 'findUser double-escapes: the LIKE gets \\\\_ instead of \\_' }, async () => {
  fake.setRules([{ match: 'FROM User', result: { records: [{ Id: '0054', Username: 'fleet_manager@acme.example', Name: 'Fleet Manager' }] } }]);
  await findUser('acme', 'fleet_manager');
  assert.match(lastQuery(), /AND Username LIKE 'fleet\\_manager@%'$/);
  await findUser('acme', '100%rider');
  assert.match(lastQuery(), /AND Username LIKE '100\\%rider@%'$/);
});

test('the site of a community user: by Id (15 or 18 characters) or name; none, or several without network:, is an error', { skip }, async () => {
  const rider = { Id: '0052', Username: 'rider@acme.example' };
  const sites = [{ NetworkId: '0DB000000000001AAA', Network: { Name: 'Riders', Status: 'Live' } }, { NetworkId: '0DB000000000002AAA', Network: { Name: 'Partners', Status: 'Live' } }];
  fake.setRules([{ match: "MemberId = '0052'", result: { records: sites } }, { match: 'NetworkMember', result: { records: [] } }]);
  assert.deepEqual(await findNetwork('acme', rider, '0DB000000000002'), { id: '0DB000000000002AAA', name: 'Partners' });
  assert.deepEqual(await findNetwork('acme', rider, 'riders'), { id: '0DB000000000001AAA', name: 'Riders' });
  await assert.rejects(findNetwork('acme', rider), /rider@acme\.example belongs to several sites \(Riders, Partners\): set network: to one of them/);
  await assert.rejects(findNetwork('acme', rider, 'Fleet'), /is not a member of a site named "Fleet" \(member of: Riders, Partners\)/);
  await assert.rejects(findNetwork('acme', { Id: '0053', Username: 'staff@acme.example' }), /staff@acme\.example is not a member of any Experience Cloud site/);
});

test('active agents: one per agent across its versions; found by label or API name, case-insensitive', { skip }, async () => {
  const fleet = { DeveloperName: 'Fleet_Assistant', MasterLabel: 'Fleet Assistant', Type: 'InternalCopilot' };
  fake.setRules([{ match: 'FROM BotVersion', result: { records: [{ BotDefinition: fleet }, { BotDefinition: fleet }, { BotDefinition: { DeveloperName: 'Rider_Help', MasterLabel: 'Rider Help' } }] } }]);
  assert.deepEqual(await activeAgents('acme'), [
    { developerName: 'Fleet_Assistant', label: 'Fleet Assistant', type: 'InternalCopilot' },
    { developerName: 'Rider_Help', label: 'Rider Help', type: null },
  ]);
  assert.equal((await findAgent('acme', 'fleet assistant')).developerName, 'Fleet_Assistant');
  assert.equal((await findAgent('acme', 'RIDER_HELP')).label, 'Rider Help');
  await assert.rejects(findAgent('acme', 'Sales Coach'), /no active agent "Sales Coach" in acme \(active: Fleet Assistant, Rider Help\)/);
});

test('the orgs the sf CLI knows: each username once, connection status only when checked', { skip }, async () => {
  const list = {
    nonScratchOrgs: [{ alias: 'prod', username: 'admin@acme.example', connectedStatus: 'Connected' }, { username: 'old@acme.example', connectedStatus: 'Expired' }],
    sandboxes: [{ alias: 'uat', username: 'admin@acme.example.uat', isSandbox: true, connectedStatus: 'Connected' }],
    scratchOrgs: [{ alias: 'scratch', username: 'test-x@example.com', isScratch: true, status: 'Active' }],
    devHubs: [{ alias: 'prod', username: 'admin@acme.example', connectedStatus: 'Connected' }],
  };
  fake.setRules([{ match: '^org list', result: list }]);
  const quick = await listOrgs();
  assert.ok(fake.calls().at(-1).includes('--skip-connection-status'));
  assert.deepEqual(quick.map(o => [o.alias, o.connected]), [['prod', null], [null, null], ['scratch', null], ['uat', null]]);
  const checked = await listOrgs({ check: true });
  assert.ok(!fake.calls().at(-1).includes('--skip-connection-status'));
  assert.deepEqual(checked.map(o => [o.username, o.connected, o.sandbox, o.scratch]), [
    ['admin@acme.example', true, false, false], ['old@acme.example', false, false, false], ['test-x@example.com', true, false, true], ['admin@acme.example.uat', true, true, false],
  ]);
});
