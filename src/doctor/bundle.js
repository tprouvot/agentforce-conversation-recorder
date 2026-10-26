/**
 * afrec heal: when the doctor finds elements missing (or on fallback), it writes a repair bundle for a coding agent
 * (Claude Code, Agentforce Vibes, Cursor...). The tool itself never calls an AI: the bundle is everything an agent
 * needs (the redacted snapshot, the accessibility tree, the pack, its schema, a ready fixture and the instructions in
 * README.md), and the fix is checked offline by `afrec fixtures test`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { selectPack, readOverrides } from '../selectors/packs.js';
import { fixtureFromDoctor } from './fixtures.js';
import { denylistHits } from './redact.js';
import { PACKAGE_ROOT, timestamp } from '../config.js';

/** The newest doctor folder of the project (optionally for one surface). */
export function latestDoctorDir(project, surface) {
  const root = path.join(project.stateDir, 'doctor');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter(d => !surface || d.endsWith('-' + surface)).sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
}

/**
 * The doctor report without what identifies the org: no target (alias or site host), no local paths, no
 * prerequisite details; the alias and host are replaced in error messages too.
 */
export function publicReport(r) {
  const secrets = [r.target, r.dir].filter(Boolean);
  const scrub = s => (s ? secrets.reduce((t, x) => t.split(x).join('<target>'), String(s)) : s);
  return {
    surface: r.surface, release: r.release, apiVersion: r.apiVersion, pack: r.pack, status: r.status, busySeen: r.busySeen,
    elements: r.elements, exchanges: (r.exchanges || []).map(x => ({ ...x, error: scrub(x.error) })), error: scrub(r.error),
    healedNow: r.healedNow, expected: r.expected, sentTexts: r.sentTexts, prereqs: (r.prereqs || []).map(p => ({ name: p.name, ok: p.ok, level: p.level })),
  };
}

/** Writes the bundle; returns its folder. */
export function writeHealBundle(project, doctorDir, { denylist = [] } = {}) {
  const report = publicReport(JSON.parse(fs.readFileSync(path.join(doctorDir, 'doctor.json'), 'utf8')));
  const dir = path.join(project.stateDir, 'heal', `${timestamp()}-${report.surface}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = selectPack(report.surface, report.apiVersion);
  const { origin, file, ...pack } = base;
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack, null, 2) + '\n');
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'schema', 'pack.schema.json'), path.join(dir, 'pack.schema.json'));
  for (const f of ['page.html', 'frame.html', 'aria.yml']) if (fs.existsSync(path.join(doctorDir, f))) fs.copyFileSync(path.join(doctorDir, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'doctor.json'), JSON.stringify(report, null, 1));
  const override = readOverrides(project.stateDir)[report.surface];
  if (override) fs.writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify(override, null, 2) + '\n');
  const failing = report.elements.filter(e => e.status === 'missing' || e.status === 'fallback' || e.status === 'healed')
    .map(e => ({ ...e, candidates: (pack.elements[e.name] || { candidates: [] }).candidates }));
  fs.writeFileSync(path.join(dir, 'failing.json'), JSON.stringify(failing, null, 2) + '\n');
  let fixture = false;
  try { fixtureFromDoctor(doctorDir, path.join(dir, 'fixture'), { name: (report.release || 'capture').replace(/\W+/g, '-').toLowerCase(), denylist }); fixture = true; } catch (e) { fs.writeFileSync(path.join(dir, 'fixture-error.txt'), e.message + '\n'); }
  fs.writeFileSync(path.join(dir, 'README.md'), readme(report, failing, { fixture, override: !!override, packFile: path.basename(base.file || `${pack.id}.json`) }));
  const leaks = [];
  const scan = d => fs.readdirSync(d).forEach(f => { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) scan(p); else if (denylistHits(fs.readFileSync(p, 'utf8'), denylist).length) leaks.push(path.relative(dir, p)); });
  scan(dir);
  if (leaks.length) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(`denylisted terms in ${leaks.join(', ')}: no bundle written (the snapshot would leak them)`); }
  return dir;
}

function readme(report, failing, { fixture, override, packFile }) {
  const list = failing.length ? failing.map(e => `- \`${e.name}\`: ${e.status}${e.status === 'fallback' ? ` (only candidate ${e.index + 1} still matches)` : ''}`).join('\n')
    : '- (no element is missing: the canary itself failed; see doctor.json `exchanges` and `error`)';
  return `# Repair bundle: ${report.surface} selector pack${report.release ? `, ${report.release} (API ${report.apiVersion})` : ''}

The Agentforce conversation recorder could not find some chat elements with its selector pack. This folder has
everything needed to fix the pack without access to the org. Nothing here contains org data: the snapshot is
redacted (structure, classes, roles and UI labels only).

## What failed

${list}
${report.error ? `\nThe doctor stopped with: \`${report.error}\`\n` : ''}
## Files

- \`pack.json\`: the selector pack to fix (a copy of \`packs/${packFile}\`).
- \`pack.schema.json\`: its schema. Packs are data, never code.
- \`failing.json\`: the failing elements with the candidates that no longer match.
- \`page.html\`${report.surface === 'messaging' ? ', `frame.html`' : ''}: the redacted DOM of the chat; shadow roots are \`<template shadowrootmode="open">\`.
- \`aria.yml\`: the redacted accessibility tree.
${override ? '- `overrides.json`: candidates the structural fallback found at run time: strong hints.\n' : ''}${fixture ? '- `fixture/`: the snapshot as an offline fixture, used to verify the fix.\n' : ''}- \`doctor.json\`: the full doctor report.

## Task

Update \`pack.json\` so that every failing element is found again in the snapshot.

1. Add new candidates **first** in the element's \`candidates\` list and keep the old ones after them: orgs still on
   the previous release use them. If the old candidates now match the wrong thing, copy the pack to
   \`${report.surface}@v${Math.floor(report.apiVersion || 0) || 'NN'}.json\` with \`"id": "${report.surface}@v${Math.floor(report.apiVersion || 0) || 'NN'}"\` and
   \`"minApiVersion": ${Math.floor(report.apiVersion || 0) || 'NN'}\` instead, and fix it there.
2. Prefer, in this order: \`role\` + \`name\` (ARIA), then SLDS classes (\`slds-...\`), then component tags. Avoid
   generated ids, positions, and state classes (\`slds-is-*\`, \`slds-has-*\`).
3. In-page elements (\`root\`, \`agentText\`, \`userText\`, \`event\`, \`busy\`, \`row\`, \`panelBox\`) are matched element
   by element: \`tag\`, \`tagPattern\`, \`class\`, \`classPattern\`, \`css\` (tested with \`element.matches\`, so no
   descendant combinators across shadow roots), \`role\`, \`name\`, \`attr\`, \`not\`, \`within\` (an ancestor that
   must match, for "a text block inside an outbound message").
4. Bump \`version\` (\`YYYY.MM.N\`).
5. Verify, from this folder:

   \`\`\`sh
   afrec selectors check pack.json
   ${fixture ? 'afrec fixtures test fixture --pack pack.json' : '# no fixture could be made: re-run afrec doctor once the chat opens'}
   \`\`\`

6. Publish: copy \`pack.json\` over \`packs/${packFile}\` in the agentforce-conversation-recorder repository, add
   \`fixture/\` as \`fixtures/${report.surface}/${(report.release || 'capture').replace(/\W+/g, '-').toLowerCase()}/\`, run \`npm test\`, and open a pull
   request. Users get the fix with \`afrec selectors update\`, without a new release of the tool.
`;
}
