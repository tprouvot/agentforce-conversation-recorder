/**
 * Compares a run with a baseline run (`afrec baseline set <run>`): per conversation (by name) and per exchange (by
 * number), what changed in the answer (a word diff and a similarity score), its timing, and its flags. It catches an
 * agent that started answering differently, or a release that changed the chat, at a glance.
 */
import fs from 'node:fs';
import path from 'node:path';

const tokens = text => String(text || '').match(/\s+|[^\s]+/g) || [];
const SAME = 0.9;

/** Word diff of two texts: [{ op: '=' | '-' | '+', text }], and their similarity (0 to 1). */
export function wordDiff(a, b) {
  const x = tokens(a).slice(0, 1500);
  const y = tokens(b).slice(0, 1500);
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  const push = (op, text) => { const last = ops[ops.length - 1]; if (last && last.op === op) last.text += text; else ops.push({ op, text }); };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push('=', x[i]); i++; j++; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('-', x[i++]); else push('+', y[j++]);
  }
  while (i < n) push('-', x[i++]);
  while (j < m) push('+', y[j++]);
  const words = t => t.filter(s => s.trim()).length;
  const common = ops.filter(o => o.op === '=').reduce((s, o) => s + words(tokens(o.text)), 0);
  const total = words(x) + words(y);
  return { ops, similarity: total ? (2 * common) / total : 1 };
}

/** Reads a run's report.json (a run folder or the file itself). */
export function readRun(runPath) {
  const file = fs.statSync(runPath).isDirectory() ? path.join(runPath, 'report.json') : runPath;
  if (!fs.existsSync(file)) throw new Error(`no report.json in ${runPath}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {any[]} results the current run's conversation results
 * @param {any} baseline the baseline's report.json
 */
export function compareRuns(results, baseline) {
  const before = new Map((baseline.results || []).map(r => [r.name, r]));
  const conversations = results.map(r => {
    const b = before.get(r.name);
    before.delete(r.name);
    if (!b) return { name: r.name, status: 'new', exchanges: [] };
    const old = new Map(b.exchanges.map(e => [e.n, e]));
    const exchanges = r.exchanges.map(e => {
      const o = old.get(e.n);
      if (!o) return { n: e.n, status: 'new' };
      const { ops, similarity } = wordDiff(o.reply, e.reply);
      return {
        n: e.n, status: similarity >= SAME ? 'same' : 'changed', similarity: Math.round(similarity * 100) / 100,
        diff: similarity >= 0.999 ? [] : ops, secondsBefore: o.seconds, secondsAfter: e.seconds,
      };
    });
    const flagsAdded = r.flags.filter(f => !b.flags.includes(f));
    const flagsResolved = b.flags.filter(f => !r.flags.includes(f));
    const changed = exchanges.some(x => x.status !== 'same') || flagsAdded.length || r.status !== b.status || r.exchanges.length !== b.exchanges.length;
    return { name: r.name, status: changed ? 'changed' : 'same', statusBefore: b.status, exchanges, flagsAdded, flagsResolved };
  });
  for (const name of before.keys()) conversations.push({ name, status: 'missing', exchanges: [] });
  return { baseline: baseline.startedAt, conversations };
}

/** A few lines for the terminal. */
export function summarizeComparison(cmp) {
  const count = s => cmp.conversations.filter(c => c.status === s).length;
  const lines = [`compared with the baseline of ${new Date(cmp.baseline).toLocaleString()}: ${count('same')} same, ${count('changed')} changed, ${count('new')} new, ${count('missing')} missing`];
  for (const c of cmp.conversations.filter(x => x.status === 'changed')) {
    const parts = c.exchanges.filter(e => e.status === 'changed').map(e => `#${e.n} ${Math.round(e.similarity * 100)}% alike`);
    if (c.flagsAdded.length) parts.push(`${c.flagsAdded.length} new flag(s)`);
    lines.push(`  ${c.name}: ${parts.join(', ') || `status ${c.statusBefore} -> now different`}`);
  }
  return lines.join('\n');
}
