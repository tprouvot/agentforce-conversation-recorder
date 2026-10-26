/**
 * report.html: one self-contained page per run (styles, script and data inlined; videos, GIFs and screenshots
 * referenced relative to the run folder), so a run folder can be zipped or shared as is. It renders with the same
 * code as the UI (src/ui/public/render.js).
 */
import fs from 'node:fs';
import { PACKAGE_ROOT } from '../config.js';
import path from 'node:path';

const asset = name => fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'ui', 'public', name), 'utf8');
// JSON inside <script>: every "<" escaped (no </script>, no <!--), and the line separators JavaScript rejects
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export function renderReportHtml(report) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Agentforce recordings ${new Date(report.startedAt).toISOString().slice(0, 16).replace('T', ' ')}</title>
<style>${asset('style.css')}</style>
</head>
<body>
<main class="wrap" id="app"></main>
<script>${asset('render.js')}</script>
<script>
const report = ${safeJson(report)};
AfrecRender.renderRun(document.getElementById('app'), report, { mediaBase: '' });
</script>
</body>
</html>
`;
}
