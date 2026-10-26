/** Writes each conversation's transcript.md, and the run's report.md, report.json and report.html. */
import fs from 'node:fs';
import path from 'node:path';
import { renderReportHtml } from './report-html.js';
import { describeFailure } from './checks.js';

export const SURFACES = { lightning: 'Lightning Agentforce panel', messaging: 'Embedded Messaging' };
const STATUS = { recorded: 'recorded', flagged: 'recorded, flagged', failed: 'FAILED' };
const quote = text => String(text || '').split('\n').map(l => (l.trim() ? '> ' + l : '>')).join('\n');
const stamp = iso => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
export const minutes = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };

export function writeTranscript(conv, result, dir) {
  const lines = [
    `# ${conv.name}`, '',
    `- Surface: ${SURFACES[conv.surface]}${conv.surface === 'messaging' ? ` on ${conv.site}` : ''}${result.agent ? `, agent ${result.agent}` : ''}`,
    `- Signed in: ${result.who || '(not signed in)'}`,
    `- Recorded: ${stamp(result.startedAt)}`,
    `- Script: ${path.relative(process.cwd(), conv.file) || conv.file}`,
  ];
  if (result.selectors) lines.push(`- Selectors: ${result.selectors.pack} ${result.selectors.version}${result.selectors.release ? ` for ${result.selectors.release}` : ''}`);
  if (result.selectors && result.selectors.healed.length) lines.push(`- **Running on healed locators: ${result.selectors.healed.join(', ')}** (run \`afrec doctor\`, then \`afrec selectors promote\`)`);
  lines.push('');
  if (result.warmup) lines.push(`_Warm-up: "${result.warmup.text}" was sent first, because the first message only opens the conversation. The agent answered:_`, '', quote(result.warmup.reply), '');
  for (const ex of result.exchanges) {
    if (ex.type === 'click') lines.push(`## ${ex.n}. Clicked "${ex.label}"`, '');
    else lines.push(`## ${ex.n}. You`, '', ex.text, '');
    lines.push(`**Agent**${ex.seconds != null ? ` (answered in ${ex.seconds} s)` : ''}:`, '', ex.reply ? quote(ex.reply) : '_no reply_', '');
    for (const check of ex.checks) lines.push(check.ok ? `- ${check.kind} \`${check.pattern}\`: ok` : `- **${check.kind} \`${check.pattern}\`: ${describeFailure(check)} (flagged)**`);
    if (ex.checks.length) lines.push('');
    if (ex.screenshot) lines.push(`![Reply ${ex.n}](${ex.screenshot})`, '');
  }
  if (result.flags.length) lines.push('## Flags', '', ...result.flags.map(f => `- ${f}`), '');
  if (result.warnings.length) lines.push('## Warnings', '', ...result.warnings.map(w => `- ${w}`), '');
  if (result.error) lines.push('## Failed', '', result.error, '', '![Last screen](error.png)', '');
  fs.writeFileSync(path.join(dir, 'transcript.md'), lines.join('\n'));
}

/**
 * @param {any[]} results
 * @param {{ startedAt: string, durationMs: number, out: string, parallel: number, version?: string, comparison?: any }} run
 */
export function writeRunReport(results, run) {
  const link = (r, file) => `[${file.replace(/^conversation\./, '').replace('transcript.md', 'transcript')}](${encodeURI(r.folder + '/' + file)})`;
  const lines = [
    `# Agentforce recordings, ${stamp(run.startedAt)}`, '',
    `${results.length} conversation(s), ${results.filter(r => r.status !== 'failed').length} recorded, `
      + `${results.filter(r => r.status === 'flagged').length} flagged, ${results.filter(r => r.status === 'failed').length} failed, in ${minutes(run.durationMs)}. `
      + 'Open report.html for the videos, screenshots and checks.', '',
    '| Conversation | Surface | Signed in | Result | Exchanges | Time | Files |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(r => `| ${r.name} | ${SURFACES[r.surface]} | ${r.who || '-'} | ${STATUS[r.status]} | ${r.exchanges.length} | ${minutes(r.durationMs)} | `
      + `${r.outputs.filter(f => !f.endsWith('.webm')).map(f => link(r, f)).join(' · ')} |`),
    '',
  ];
  const healed = results.filter(r => r.selectors && r.selectors.healed.length);
  if (healed.length) lines.push('## Running on healed locators', '', ...healed.map(r => `- ${r.name}: ${r.selectors.healed.join(', ')}`), '', 'Run `afrec doctor` to confirm them, then `afrec selectors promote`.', '');
  const flagged = results.filter(r => r.flags.length);
  if (flagged.length) lines.push('## Flags', '', ...flagged.flatMap(r => r.flags.map(f => `- ${r.name}, exchange ${f}`)), '');
  const warned = results.filter(r => r.warnings.length);
  if (warned.length) lines.push('## Warnings', '', ...warned.flatMap(r => r.warnings.map(w => `- ${r.name}: ${w}`)), '');
  const failed = results.filter(r => r.status === 'failed');
  if (failed.length) lines.push('## Failures', '', ...failed.map(r => `- ${r.name}: ${r.error} (last screen: ${r.folder}/error.png)`), '');
  if (run.comparison) {
    const changed = run.comparison.conversations.filter(c => c.status !== 'same');
    lines.push('## Compared with the baseline', '', changed.length ? changed.map(c => `- ${c.name}: ${c.status}`).join('\n') : 'Nothing changed.', '');
  }
  fs.writeFileSync(path.join(run.out, 'report.md'), lines.join('\n'));
  const json = { ...run, results };
  fs.writeFileSync(path.join(run.out, 'report.json'), JSON.stringify(json, null, 1));
  fs.writeFileSync(path.join(run.out, 'report.html'), renderReportHtml(json));
}
