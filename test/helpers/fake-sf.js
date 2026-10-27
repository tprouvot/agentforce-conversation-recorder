/**
 * A fake sf CLI for the tests: an executable `sf` in a temporary folder put first on PATH. It answers `--json` like
 * the real one, from rules the test sets (the first rule whose regex matches the arguments wins), and logs every call.
 * POSIX only: on Windows src/engine/salesforce.js runs sf.cmd through a shell, which this script does not mimic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const fakeSfSupported = process.platform !== 'win32';

const SCRIPT = `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AFREC_FAKE_SF_LOG, JSON.stringify(args) + '\\n');
const rules = JSON.parse(fs.readFileSync(process.env.AFREC_FAKE_SF_RULES, 'utf8'));
const line = args.join(' ');
const rule = rules.find(r => new RegExp(r.match).test(line));
if (!rule) { process.stdout.write(JSON.stringify({ status: 1, name: 'NoRule', message: 'fake sf: no rule for ' + line })); process.exit(1); }
if (rule.raw !== undefined) { process.stdout.write(rule.raw); process.exit(rule.exit || 0); }
if (rule.error) { process.stdout.write(JSON.stringify({ status: 1, name: 'Error', message: rule.error })); process.exit(1); }
process.stdout.write(JSON.stringify({ status: 0, result: rule.result }));
`;

/**
 * Installs the fake for this test process. `rules`: [{ match: regex source, result } | { match, error } | { match, raw, exit }].
 * @param {any[]} rules
 */
export function installFakeSf(rules = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-sf-'));
  const log = path.join(dir, 'calls.jsonl');
  const rulesFile = path.join(dir, 'rules.json');
  fs.writeFileSync(path.join(dir, 'sf.mjs'), SCRIPT);
  fs.writeFileSync(path.join(dir, 'sf'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'sf.mjs')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(log, '');
  const saved = { PATH: process.env.PATH, AFREC_FAKE_SF_LOG: process.env.AFREC_FAKE_SF_LOG, AFREC_FAKE_SF_RULES: process.env.AFREC_FAKE_SF_RULES };
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  process.env.AFREC_FAKE_SF_LOG = log;
  process.env.AFREC_FAKE_SF_RULES = rulesFile;
  const fake = {
    dir,
    /** Replaces the rules (later calls see the new ones). */
    setRules(next) { fs.writeFileSync(rulesFile, JSON.stringify(next)); },
    /** The arguments of every call so far, oldest first. */
    calls() { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); },
    restore() {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  fake.setRules(rules);
  return fake;
}

/** The rules of a connected org whose instance is `instanceUrl` (the fake org of fake-org.js, usually). */
export function orgRules(alias, instanceUrl, { apiVersion = '66.0', agents = [{ DeveloperName: 'Fleet_Assistant', MasterLabel: 'Fleet Assistant', Type: 'InternalCopilot' }], users = [] } = {}) {
  const a = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    { match: `^org display --target-org ${a} --json$`, result: { id: '00D000000000001AAA', instanceUrl: instanceUrl + '/', username: `admin@${alias}.example`, apiVersion } },
    { match: `^org open --url-only --target-org ${a}\\b`, result: { url: `${instanceUrl}/secur/frontdoor.jsp?sid=SESSION-${alias}` } },
    { match: `^data query --target-org ${a} --query .*FROM BotVersion`, result: { records: agents.map(b => ({ BotDefinition: b })) } },
    ...users.map(u => ({ match: `^data query --target-org ${a} --query .*FROM User .*${u.Username.split('@')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, result: { records: [u] } })),
    { match: `^data query --target-org ${a} --query .*FROM NetworkMember`, result: { records: [{ NetworkId: '0DB000000000001AAA', Network: { Name: 'Riders', Status: 'Live' } }] } },
    { match: `^data query --target-org ${a} --query .*FROM EmbeddedServiceConfig`, result: { records: [{ DeveloperName: 'Riders_Chat', IsEnabled: true }] } },
  ];
}
