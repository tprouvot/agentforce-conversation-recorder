/** Recorded runs on disk, written by the real report writer, for the commands and routes that read them back. */
import fs from 'node:fs';
import path from 'node:path';
import { writeRunReport } from '../../src/engine/report.js';

/** A conversation result as the player returns it. */
export function result(name, replies, extra = {}) {
  return {
    name, folder: name, file: `scenarios/${name}.md`, surface: 'messaging', signIn: 'guest', who: 'guest visitor', agent: null, status: 'recorded',
    exchanges: replies.map((reply, i) => ({ n: i + 1, type: 'message', text: `Question ${i + 1}`, reply, seconds: 3, screenshot: null, checks: [] })),
    flags: [], warnings: [], outputs: ['transcript.md'], error: null, startedAt: '2026-10-20T10:00:00.000Z', selectors: null, durationMs: 30000, ...extra,
  };
}

/** Writes <recordingsDir>/<id>/report.* for `results`; returns the run folder. */
export function makeRun(recordingsDir, id, results, startedAt = '2026-10-20T10:00:00.000Z') {
  const out = path.join(recordingsDir, id);
  fs.mkdirSync(out, { recursive: true });
  writeRunReport(results, { startedAt, durationMs: 61000, out, parallel: 3, version: '0.1.0', comparison: null });
  return out;
}
