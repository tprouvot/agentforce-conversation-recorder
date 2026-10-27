/**
 * `afrec new`: what an agent can do, read from its planner (against the fake sf of helpers/fake-sf.js, POSIX only),
 * the settings and the text of the new scenario, and the command's files, refusals and JSON.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentTopics } from '../src/engine/salesforce.js';
import { draftSurface, draftSettings, draftFile, draftScenario } from '../src/scenario/draft.js';
import { parseMarkdown } from '../src/scenario/parse.js';
import { resolveConversation } from '../src/scenario/resolve.js';
import { installFakeSf, fakeSfSupported } from './helpers/fake-sf.js';

const skip = !fakeSfSupported && 'the fake sf CLI needs a POSIX shell';
const BIN = fileURLToPath(new URL('../bin/afrec.js', import.meta.url));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-draft-')));
const fresh = name => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
const afrec = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, AFREC_HOME: path.join(tmp, 'home') }, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const FLEET = { DeveloperName: 'Fleet_Assistant', MasterLabel: 'Fleet Assistant', Type: 'InternalCopilot' };
const RIDERS = { DeveloperName: 'Rider_Help', MasterLabel: 'Rider Help', Type: 'ExternalCopilot' };
const STATIONS = '179000000000001AAA';
const REPAIRS = '179000000000002AAA';

/** An org whose Fleet Assistant (version 3) has two topics of its own, a standard one, and an action outside topics. */
const fleetOrg = ({ agents = [FLEET], linked = true } = {}) => [
  { match: "FROM BotVersion WHERE Status = 'Active' AND BotDefinition.DeveloperName = 'Fleet_Assistant'", result: { records: [{ Id: '0X9000000000003AAA', VersionNumber: 3 }] } },
  { match: "FROM BotVersion WHERE Status = 'Active' AND BotDefinition", result: { records: [] } },
  { match: 'FROM BotVersion', result: { records: agents.map(b => ({ BotDefinition: b })) } },
  { match: 'FROM GenAiPlannerDefinition', result: { records: [
    { Id: '16j000000000002AAA', DeveloperName: 'Fleet_Assistant_v2', LinkedBotVersionId: '0X9000000000002AAA' },
    { Id: '16j000000000003AAA', DeveloperName: 'Fleet_Assistant_v3', LinkedBotVersionId: linked ? '0X9000000000003AAA' : null },
  ] } },
  { match: "FROM GenAiPlannerFunctionDef WHERE PlannerId = '16j000000000003AAA'", result: { records: [
    { Plugin: STATIONS }, { Plugin: REPAIRS }, { Plugin: 'EmployeeCopilot__AnswerQuestionsWithKnowledge' }, { Plugin: '172000000000009AAA' },
  ] } },
  { match: 'FROM GenAiPluginDefinition ', result: { records: [
    { Id: STATIONS, DeveloperName: 'station_levels_16j000000000003', NamespacePrefix: null, MasterLabel: 'Station Levels', Description: 'Bikes and free docks\nat each station', Scope: 'Only stations of the city. --> not others' },
    { Id: REPAIRS, DeveloperName: 'Repairs', NamespacePrefix: null, MasterLabel: 'Repairs', Description: 'Maintenance tasks for damaged bikes', Scope: null },
  ] } },
  { match: 'FROM GenAiPluginFunctionDef', result: { records: [
    { PluginId: STATIONS, Function: '172000000000001AAA' },
    { PluginId: REPAIRS, Function: '172000000000002AAA' },
    { PluginId: REPAIRS, Function: 'EmployeeCopilot__IdentifyRecordByName' },
  ] } },
  { match: 'FROM GenAiFunctionDefinition', result: { records: [
    { Id: '172000000000001AAA', DeveloperName: 'get_station_levels_179000000000001', NamespacePrefix: null, MasterLabel: 'Get Station Levels', Description: 'Bikes per station', IsConfirmationRequired: false },
    { Id: '172000000000002AAA', DeveloperName: 'Create_Repair_Task', NamespacePrefix: null, MasterLabel: 'Create Repair Task', Description: null, IsConfirmationRequired: true },
    { Id: '172000000000009AAA', DeveloperName: 'Draft_Email', NamespacePrefix: null, MasterLabel: 'Draft Email', Description: 'Drafts an email', IsConfirmationRequired: false },
    { Id: '172000000000005AAA', DeveloperName: 'IdentifyRecordByName', NamespacePrefix: 'EmployeeCopilot', MasterLabel: 'Identify Record by Name', Description: null, IsConfirmationRequired: false },
  ] } },
  { match: 'FROM GenAiPluginInstructionDef', result: { records: [
    { GenAiPluginDefinitionId: STATIONS, Description: 'Always name the station.' },
    { GenAiPluginDefinitionId: STATIONS, Description: ' Round battery levels. ' },
  ] } },
  { match: "FROM User .*fleet\\.manager", result: { records: [{ Id: '0051', Username: 'fleet.manager@acme.example', Name: 'Fleet Manager', ContactId: null }] } },
  { match: "FROM User .*rider\\.demo", result: { records: [{ Id: '0052', Username: 'rider.demo@acme.example', Name: 'Jordan Lee', ContactId: '0031' }] } },
  { match: 'FROM NetworkMember', result: { records: [{ NetworkId: '0DB000000000001AAA', Network: { Name: 'Riders', Status: 'Live' } }] } },
];

let fake;
before(() => { if (!skip) fake = installFakeSf(); });
after(() => { if (fake) fake.restore(); });

test('what an agent can do: topics of its active version with instructions and actions, standard ones by name', { skip }, async () => {
  fake.setRules(fleetOrg());
  const t = await agentTopics('acme', 'Fleet_Assistant');
  assert.equal(t.version, 3);
  assert.equal(t.planner, 'Fleet_Assistant_v3', 'the planner linked to the active version, not an older one');
  assert.deepEqual(t.topics.map(x => [x.name, x.label]), [
    ['EmployeeCopilot__AnswerQuestionsWithKnowledge', 'Answer Questions With Knowledge'], ['Repairs', 'Repairs'], ['station_levels', 'Station Levels'],
  ], 'sorted by label; a local name loses its planner suffix; a standard topic the org does not describe keeps its name');
  const stations = t.topics.find(x => x.label === 'Station Levels');
  assert.equal(stations.description, 'Bikes and free docks at each station', 'on one line');
  assert.deepEqual(stations.instructions, ['Always name the station.', 'Round battery levels.']);
  assert.deepEqual(stations.actions, [{ name: 'get_station_levels', label: 'Get Station Levels', description: 'Bikes per station', confirm: false }]);
  assert.deepEqual(t.topics.find(x => x.label === 'Repairs').actions, [
    { name: 'Create_Repair_Task', label: 'Create Repair Task', description: null, confirm: true },
    { name: 'IdentifyRecordByName', label: 'Identify Record by Name', description: null, confirm: false },
  ], 'a namespaced standard action found by its name');
  assert.deepEqual(t.actions.map(a => a.label), ['Draft Email'], 'an action attached to the planner, outside topics');
  const pluginQuery = fake.calls().map(c => c[c.indexOf('--query') + 1]).find(q => / FROM GenAiPluginDefinition /.test(q));
  assert.match(pluginQuery, /WHERE Id IN \('179000000000001AAA', '179000000000002AAA'\) OR DeveloperName IN \('AnswerQuestionsWithKnowledge'\)$/);
});

test('what an agent can do: the planner by name when none is linked; no active version is an error', { skip }, async () => {
  fake.setRules(fleetOrg({ linked: false }));
  assert.equal((await agentTopics('acme', 'Fleet_Assistant')).planner, 'Fleet_Assistant_v3');
  await assert.rejects(agentTopics('acme', 'Rider_Help'), /Rider_Help has no active version in acme/);
});

test('draft settings: the surface from the flags or the agent; agent: only on Lightning; the usual order', () => {
  assert.equal(draftSurface({ surface: 'widget' }), 'messaging');
  assert.equal(draftSurface({ site: 'https://x.example.com/' }), 'messaging');
  assert.equal(draftSurface({ path: '/lightning/r/Account/001/view' }), 'lightning');
  assert.equal(draftSurface({}, { type: 'InternalCopilot' }), 'lightning');
  assert.equal(draftSurface({}, { type: 'ExternalCopilot' }), 'messaging');
  assert.equal(draftSurface({}), null);
  const fleet = { facts: { agent: { label: 'Fleet Assistant', type: 'InternalCopilot' } } };
  assert.deepEqual(Object.entries(draftSettings({ user: 'fleet.manager', org: 'acme' }, fleet.facts)), [['surface', 'lightning'], ['org', 'acme'], ['agent', 'Fleet Assistant'], ['user', 'fleet.manager']]);
  assert.deepEqual(draftSettings({ agent: 'Rider Help', site: 'https://x.example.com/' }, { agent: { label: 'Rider Help', type: 'ExternalCopilot' } }), { surface: 'messaging', site: 'https://x.example.com/' });
  assert.deepEqual(draftSettings({}, fleet.facts, { org: 'acme' }), { surface: 'lightning', agent: 'Fleet Assistant' }, 'the org of the defaults stays inherited');
  const project = { scenariosDir: '/p/scenarios' };
  assert.equal(draftFile(project, null, { label: 'Fleet Assistant' }), '/p/scenarios/fleet-assistant.md');
  assert.equal(draftFile(project, 'Morning round'), '/p/scenarios/morning-round.md');
  assert.equal(draftFile(project), '/p/scenarios/conversation.md');
  assert.equal(draftFile(project, 'elsewhere/x.md'), path.resolve('elsewhere/x.md'));
});

test('draft text: the settings, who signs in, the topics in a comment, and no step until one is written', () => {
  const file = path.join(tmp, 'fleet-assistant.md');
  const facts = {
    agent: { label: 'Fleet Assistant', type: 'InternalCopilot' },
    user: { username: 'fleet.manager@acme.example', name: 'Fleet Manager', community: false },
    topics: {
      version: 3, planner: 'Fleet_Assistant_v3', actions: [{ label: 'Draft Email', description: null, confirm: false }],
      topics: [{ label: 'Repairs', description: 'Tasks --> for damaged bikes', scope: 'x'.repeat(400), instructions: [], actions: [{ label: 'Create Repair Task', description: 'Opens a task', confirm: true }] }],
    },
  };
  const text = draftScenario({ file, settings: { surface: 'lightning', org: 'acme', agent: 'Fleet Assistant', user: 'fleet.manager' }, facts, date: '2026-10-27' });
  assert.match(text, /^---\nsurface: lightning\norg: acme\nagent: Fleet Assistant\nuser: fleet\.manager\n---\n# Fleet Assistant\n\n<!--\n/);
  assert.ok(text.includes(`\n  afrec run --dry-run ${file}\n`), 'a file outside the current folder by its full path');
  assert.match(text, /\nSigned in: Fleet Manager \(fleet\.manager@acme\.example\), by Login-As from acme\.\n/);
  assert.match(text, /\nFleet Assistant \(version 3, read from acme on 2026-10-27\) can do this:\n\nTopic "Repairs": Tasks -- > for damaged bikes\n {2}Scope: x{299}…\n {2}Action "Create Repair Task" \(asks to confirm: answer it, or click: its button\): Opens a task\n\nOutside any topic:\n {2}Action "Draft Email"\n-->\n$/);
  assert.equal(text.match(/-->/g).length, 1, 'a description cannot close the comment');
  const [raw] = parseMarkdown(text, file);
  assert.deepEqual(raw.steps, [], 'the example in the comment is not a step');
  assert.throws(() => resolveConversation(raw), /has no message to send/);
  const written = parseMarkdown(text + '\n1. Which bikes need a repair?\n   - expect: repair\n', file)[0];
  assert.deepEqual(resolveConversation(written).steps.map(s => s.type), ['message', 'expect']);
  const guest = draftScenario({ file, settings: { surface: 'messaging', site: 'https://x.example.com/' }, facts: { agent: null, topics: null, user: null } });
  assert.match(guest, /Signed in: nobody: a guest visitor\. For a signed-in member of the site, add user: <username> and org: <admin alias> \(Login-As\)\./);
  assert.match(guest, /Run afrec new again with --org <alias> to list here what the agent can do\.\n-->\n$/);
  assert.throws(() => draftScenario({ file, settings: { surface: 'lightning' }, facts: {} }), /a Lightning conversation needs org:/);
});

test('afrec new: writes the file, never over one; --json writes nothing; several agents or no site is an error', { skip }, () => {
  const cwd = fresh('new');
  fs.writeFileSync(path.join(cwd, 'afrec.config.json'), JSON.stringify({ defaults: { org: 'acme' } }));
  fake.setRules(fleetOrg());
  const r = afrec(cwd, 'new', '--user', 'fleet.manager');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'wrote scenarios/fleet-assistant.md, with what Fleet Assistant can do: 3 topic(s), 4 action(s)\nnext: write the messages in it, then afrec run --dry-run scenarios/fleet-assistant.md\n');
  const text = fs.readFileSync(path.join(cwd, 'scenarios', 'fleet-assistant.md'), 'utf8');
  assert.match(text, /^---\nsurface: lightning\nagent: Fleet Assistant\nuser: fleet\.manager\n---\n/);
  assert.match(text, /Topic "Station Levels": Bikes and free docks at each station\n {2}Scope: Only stations of the city\. -- > not others\n {2}Action "Get Station Levels": Bikes per station\n/);
  const plan = afrec(cwd, 'run', '--dry-run');
  assert.equal(plan.code, 2);
  assert.match(plan.err, /fleet-assistant\.md: "fleet-assistant" has no message to send/);
  assert.match(afrec(cwd, 'new', '--user', 'fleet.manager').err, /^error: scenarios\/fleet-assistant\.md already exists \(use --force to overwrite\)\n$/);
  assert.equal(afrec(cwd, 'new', '--force').code, 0);

  const json = afrec(cwd, 'new', 'rider-extends', '--surface', 'messaging', '--user', 'rider.demo', '--agent', 'Fleet Assistant', '--json');
  assert.equal(json.code, 0, json.err);
  const facts = JSON.parse(json.out);
  assert.equal(facts.file, path.join(cwd, 'scenarios', 'rider-extends.md'));
  assert.deepEqual(facts.settings, { surface: 'messaging', user: 'rider.demo' });
  assert.deepEqual(facts.user, { username: 'rider.demo@acme.example', name: 'Jordan Lee', community: true, site: 'Riders' });
  assert.deepEqual(facts.topics.topics.find(t => t.label === 'Station Levels').instructions, ['Always name the station.', 'Round battery levels.']);
  assert.ok(!fs.existsSync(facts.file), '--json writes nothing');

  const site = afrec(cwd, 'new', '--surface', 'messaging', '--agent', 'Fleet Assistant');
  assert.equal(site.code, 2);
  assert.equal(site.err, 'error: a Messaging scenario needs --site <url>: the page where the chat widget loads (Fleet Assistant is an employee agent: --surface lightning?)\n');
  fake.setRules(fleetOrg({ agents: [FLEET, { ...FLEET, DeveloperName: 'Depot_Helper', MasterLabel: 'Depot Helper' }, RIDERS] }));
  const several = afrec(cwd, 'new', '--surface', 'lightning');
  assert.match(several.err, /error: acme has 2 active employee agents \(Fleet Assistant; Depot Helper\): pass --agent <label>/);
  assert.match(afrec(fresh('new-none'), 'new').err, /give --org <alias> \(the org of the agent\), or --site <url> for a guest on a website/);
});
