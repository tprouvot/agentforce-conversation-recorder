/*
 * The afrec UI: edit scenarios (form or Markdown), run them with live progress, answer type-from prompts, browse
 * recordings, run the doctor. Everything goes through the local server's /api; text from the org is set as text.
 */
(function () {
  const { h, renderRun, checkChip } = window.AfrecRender;
  const token = /** @type {HTMLMetaElement} */ (document.querySelector('meta[name="afrec-token"]')).content;
  const main = document.getElementById('view');
  // each navigation renders into its own container: a view that finishes late writes into a detached one
  let view = main;
  const modal = document.getElementById('modal');
  const status = document.getElementById('status');

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'X-Afrec-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function toast(message, kind = 'warn') {
    const el = h('div', { class: `toast banner ${kind}`, role: 'status' }, message);
    document.body.append(el);
    setTimeout(() => el.remove(), 6000);
  }

  const guard = fn => async (...args) => { try { return await fn(...args); } catch (e) { toast(e.message, 'bad'); return undefined; } };

  // ---- live events (runs and doctor checks) ----

  const live = { kind: null, status: null, convs: new Map(), log: [], done: null, listeners: new Set() };
  const notify = () => live.listeners.forEach(fn => fn());
  function onEvent(e) {
    if (e.type === 'hello') { if (!e.active) return; live.kind = e.active.kind; live.status = e.active.status; return; }
    if (e.type === 'run-start') { live.kind = 'run'; live.status = 'running'; live.done = null; live.log = []; live.convs = new Map(e.conversations.map(c => [c.name, { ...c, status: 'queued', last: '', exchanges: 0 }])); }
    if (e.type === 'conversation-start') { const c = live.convs.get(e.conversation); if (c) c.status = 'running'; }
    if (e.type === 'conversation-end') { const c = live.convs.get(e.conversation); if (c) c.status = e.status; }
    if (e.type === 'exchange') { const c = live.convs.get(e.conversation); if (c) c.exchanges++; }
    if (e.type === 'log') {
      if (!live.kind) { live.kind = 'doctor'; live.status = 'running'; }
      const c = live.convs.get(e.conversation); if (c) c.last = e.message;
      live.log.push(`${e.conversation ? `[${e.conversation}] ` : ''}${e.message}`);
    }
    if (e.type === 'warning') live.log.push(`warning: ${e.message}`);
    if (e.type === 'heal') live.log.push(`[${e.conversation}] healed ${e.elements.join(', ')} (saved to .afrec/overrides.json)`);
    if (e.type === 'input-request' && !e.replay) askInput(e);
    if (e.type === 'input-resolved') closeInput(e.id);
    if (e.type === 'done') { live.status = e.error ? 'failed' : 'done'; live.done = e; if (e.error) live.log.push(`error: ${e.error}`); if (!e.replay) toast(e.kind === 'run' ? (e.error ? 'The run failed' : 'The run is finished') : 'The doctor is finished', e.error ? 'bad' : 'warn'); }
    if (live.log.length > 3000) live.log.splice(0, live.log.length - 3000);
    status.textContent = live.status === 'running' ? `${live.kind} running…` : '';
    notify();
  }
  const events = new EventSource('/api/events');
  events.onmessage = m => onEvent(JSON.parse(m.data));

  /** Live progress: a card per conversation, the log, a cancel button. */
  function liveBlock() {
    const box = h('div', {});
    const draw = () => {
      if (!live.kind) { box.replaceChildren(); return; }
      const pre = h('pre', { class: 'log' }, live.log.slice(-400).join('\n'));
      box.replaceChildren(
        h('div', { class: 'row spread gap' }, h('h2', {}, live.kind === 'run' ? 'Run' : 'Doctor', ' ', h('span', { class: `pill ${live.status === 'running' ? 'running' : live.status === 'failed' ? 'failed' : 'recorded'}` }, live.status || '')),
          h('div', { class: 'row' },
            live.status === 'running' && live.kind === 'run' ? h('button', { class: 'btn', onclick: guard(() => api('POST', '/api/cancel')) }, 'Cancel') : null,
            live.done && live.done.kind === 'run' && live.done.id ? h('a', { class: 'btn primary', href: `#/runs/${encodeURIComponent(live.done.id)}` }, 'Open the recordings') : null)),
        live.convs.size ? h('div', { class: 'live' }, [...live.convs.values()].map(c => h('div', { class: 'card' },
          h('div', { class: 'row spread' }, h('strong', {}, c.name), h('span', { class: `pill ${c.status}` }, c.status)),
          h('div', { class: 'muted' }, `${c.surface} · ${c.exchanges} exchange(s)`),
          h('div', { class: 'last', title: c.last }, c.last || '…')))) : null,
        pre);
      pre.scrollTop = pre.scrollHeight;
    };
    live.listeners.add(draw);
    draw();
    return box;
  }

  // ---- type-from prompts ----

  const openInputs = new Map();
  function askInput(req) {
    if (openInputs.has(req.id)) return;
    const input = h('input', { type: 'password', autocomplete: 'one-time-code', 'aria-label': req.label || 'value' });
    const left = h('span', { class: 'muted' });
    const tick = setInterval(() => { const s = Math.max(0, Math.round((req.until - Date.now()) / 1000)); left.textContent = `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s left`; }, 1000);
    const submit = guard(async ev => {
      ev.preventDefault();
      if (!input.value.trim()) return;
      await api('POST', '/api/input', { id: req.id, value: input.value });
      closeInput(req.id);
    });
    const box = h('div', { class: 'backdrop' }, h('form', { class: 'card dialog', onsubmit: submit, role: 'dialog', 'aria-label': 'Input needed' },
      h('h2', {}, `${req.conversation}: step ${req.n}`),
      h('div', {}, `Type the ${req.label || 'value'}. The chat shows it, as it would for a person; the logs, the transcript and the report mask it.`),
      req.file ? h('div', { class: 'muted' }, `Writing it to ${req.file} works too.`) : null,
      input,
      h('div', { class: 'row spread' }, left, h('button', { class: 'btn primary', type: 'submit' }, 'Type it'))));
    openInputs.set(req.id, { box, tick });
    modal.append(box);
    input.focus();
  }
  function closeInput(id) {
    const o = openInputs.get(id);
    if (!o) return;
    clearInterval(o.tick);
    o.box.remove();
    openInputs.delete(id);
  }

  // ---- shared data ----

  let schema = null;
  let orgs = null;
  const loadSchema = async () => schema || (schema = await api('GET', '/api/schema'));
  /** The sf CLI's orgs, loaded once in the background: views never wait for them. */
  const loadOrgs = () => orgs || (orgs = api('GET', '/api/orgs').catch(() => []));
  const orgList = id => {
    const list = h('datalist', { id });
    loadOrgs().then(all => list.replaceChildren(...all.filter(o => o.alias).map(o => h('option', { value: o.alias }, o.connected === false ? 'not connected' : ''))));
    return list;
  };

  // ---- Scenarios ----

  const STEP_TYPES = [
    ['message', 'Message'], ['type-from', 'Type from prompt'], ['click', 'Click'], ['wait', 'Wait (s)'],
    ['expect', 'Expect'], ['expect-not', 'Expect not'], ['expect-button', 'Expect button'], ['max-seconds', 'Max seconds'],
  ];
  const CHECK_TYPES = ['expect', 'expect-not', 'expect-button', 'max-seconds'];
  const stepKind = s => (s.type === 'message' && s.prompt ? 'type-from' : s.type);
  const stepValue = s => (s.type === 'message' ? (s.prompt ? s.label || '' : s.text || '') : s.label !== undefined ? s.label : s.seconds !== undefined ? String(s.seconds) : s.display || s.pattern || '');
  function makeStep(kind, value) {
    switch (kind) {
      case 'message': return { type: 'message', text: value };
      case 'type-from': return { type: 'message', prompt: true, fromFile: null, label: value || null, text: null };
      case 'click': case 'expect-button': return { type: kind, label: value };
      case 'wait': case 'max-seconds': return { type: kind, seconds: Number(value) || 0 };
      default: return { type: kind, display: value, pattern: value };
    }
  }

  async function scenarios(selected) {
    const root = view;
    await loadSchema();
    const files = await api('GET', '/api/scenarios');
    const list = h('div', { class: 'card files' },
      h('div', { class: 'row spread pad' }, h('strong', {}, 'Scenario files'), h('button', { class: 'btn', onclick: guard(newScenario) }, 'New')),
      files.length ? files.map(f => h('button', { class: `file${f.file === selected ? ' on' : ''}`, onclick: () => { location.hash = `#/scenarios/${encodeURIComponent(f.file)}`; } },
        h('div', {}, f.file, f.errors.length ? h('span', { class: 'pill bad', title: f.errors.join('\n') }, '!') : null),
        h('div', { class: 'names' }, f.conversations.map(c => `${c.name} (${c.surface})`).join(', ')))) : h('div', { class: 'empty' }, 'No scenario yet.'));
    const editor = h('div', {});
    root.replaceChildren(h('div', { class: 'split' }, list, editor));
    if (selected) await openEditor(editor, selected);
    else editor.replaceChildren(h('div', { class: 'card empty' }, 'Pick a scenario file, or create one. Scenarios are Markdown (.md, one conversation) or CSV (.csv, several).'));
  }

  async function newScenario() {
    const name = prompt('File name (in the scenarios folder), e.g. my-demo.md');
    if (!name) return;
    const file = /\.(md|csv)$/i.test(name) ? name : name + '.md';
    const text = '---\nsurface: messaging\nsite: https://example.my.site.com/portal/\n---\n1. Hi\n2. What can you help me with?\n';
    await api('PUT', '/api/scenario', { file, text });
    location.hash = `#/scenarios/${encodeURIComponent(file)}`;
  }

  async function openEditor(container, file) {
    const data = await api('GET', `/api/scenario?file=${encodeURIComponent(file)}`);
    let text = data.text;
    let mode = /\.md$/i.test(file) && data.parsed && data.parsed.conversations && data.parsed.conversations.length === 1 ? 'form' : 'markdown';
    const problems = h('div', { class: 'problems' });
    const body = h('div', {});
    const showResult = r => {
      problems.replaceChildren(
        ...(r.errors || []).map(e => h('div', { class: 'err' }, e)),
        ...(r.warnings || []).map(w => h('div', { class: 'muted' }, `warning: ${w}`)),
        r.plan && r.plan.length ? h('pre', {}, r.plan.join('\n')) : null);
    };
    let timer = null;
    const validate = () => { clearTimeout(timer); timer = setTimeout(guard(async () => showResult(await api('POST', '/api/scenario/validate', { file, text }))), 400); };
    const draw = async () => {
      if (mode === 'markdown') {
        const area = h('textarea', { class: 'code', spellcheck: 'false', 'aria-label': 'Scenario source' });
        area.value = text;
        area.addEventListener('input', () => { text = area.value; validate(); });
        body.replaceChildren(area);
      } else {
        const r = await api('POST', '/api/scenario/validate', { file, text });
        const conv = r.conversations[0] || { settings: {}, steps: [] };
        body.replaceChildren(formEditor(conv, async next => {
          const out = await api('POST', '/api/scenario/render', { settings: next.settings, steps: next.steps, title: next.title });
          text = out.text;
          validate();
        }, titleOf(text)));
      }
      validate();
    };
    container.replaceChildren(h('div', { class: 'card pad' },
      h('div', { class: 'row spread' }, h('h1', {}, file), h('div', { class: 'row' },
        /\.md$/i.test(file) ? h('button', { class: 'btn', onclick: () => { mode = mode === 'form' ? 'markdown' : 'form'; draw(); } }, 'Form / Markdown') : null,
        h('button', { class: 'btn', onclick: guard(async () => { showResult(await api('PUT', '/api/scenario', { file, text })); toast('Saved', 'warn'); }) }, 'Save'),
        h('a', { class: 'btn primary', href: `#/run/${encodeURIComponent(file)}` }, 'Record…'),
        h('button', { class: 'btn', onclick: guard(async () => { if (confirm(`Delete ${file}?`)) { await api('DELETE', `/api/scenario?file=${encodeURIComponent(file)}`); location.hash = '#/scenarios'; } }) }, 'Delete'))),
      body, problems));
    await draw();
  }

  const titleOf = text => { const m = String(text).replace(/^---[\s\S]*?---\s*/, '').match(/^#\s+(.+)$/m); return m ? m[1].trim() : ''; };

  /** The form: settings grouped as in the schema (development-only ones folded), then the steps. */
  function formEditor(conv, onChange, title) {
    const settings = { ...conv.settings };
    let steps = conv.steps.map(s => ({ ...s }));
    const props = schema.properties.settings.properties;
    const emit = () => onChange({ settings, steps, title: titleInput.value });
    const titleInput = h('input', { value: title || '', placeholder: 'A heading for the file (optional)', 'aria-label': 'Title' });
    titleInput.addEventListener('change', emit);
    const field = (key, p) => {
      const id = `f-${key}`;
      let input;
      if (p.enum) input = h('select', { id }, h('option', { value: '' }, '(default)'), p.enum.map(v => h('option', { value: v, selected: settings[key] === v }, v)));
      else if (p.type === 'boolean') input = h('select', { id }, ['', 'true', 'false'].map(v => h('option', { value: v, selected: String(settings[key] ?? '') === v }, v || '(default)')));
      else input = h('input', { id, type: p.type === 'number' ? 'number' : 'text', value: settings[key] ?? '', list: key === 'org' ? 'org-list' : null, placeholder: key === 'site' ? 'https://…' : '' });
      input.addEventListener('change', () => {
        const v = /** @type {HTMLInputElement} */ (input).value;
        if (v === '') delete settings[key];
        else settings[key] = p.type === 'boolean' ? v === 'true' : p.type === 'number' ? Number(v) : v;
        emit();
      });
      return h('div', { class: 'field' }, h('label', { for: id }, key), input, h('div', { class: 'help' }, p.description || ''));
    };
    const groups = {};
    for (const [key, p] of Object.entries(props)) { const g = p['x-advanced'] ? 'Development only' : p['x-group'] || 'Other'; (groups[g] = groups[g] || []).push([key, p]); }
    const stepsBox = h('div', { class: 'steps' });
    const drawSteps = () => {
      stepsBox.replaceChildren(...steps.map((s, i) => {
        const kind = stepKind(s);
        const type = h('select', { 'aria-label': 'Step type' }, STEP_TYPES.map(([v, label]) => h('option', { value: v, selected: v === kind }, label)));
        const value = kind === 'message' ? h('textarea', { rows: 1, 'aria-label': 'Message' }) : h('input', { 'aria-label': 'Value', placeholder: kind === 'type-from' ? 'what to ask for, e.g. one-time code' : '' });
        /** @type {HTMLInputElement} */ (value).value = stepValue(s);
        const update = () => { steps[i] = makeStep(/** @type {HTMLSelectElement} */ (type).value, /** @type {HTMLInputElement} */ (value).value); emit(); };
        type.addEventListener('change', () => { update(); drawSteps(); });
        value.addEventListener('change', update);
        const move = d => () => { const j = i + d; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; emit(); drawSteps(); };
        return h('div', { class: `step${CHECK_TYPES.includes(kind) ? ' check' : ''}` }, type, value,
          h('div', { class: 'tools' }, h('button', { class: 'btn', title: 'Up', onclick: move(-1) }, '↑'), h('button', { class: 'btn', title: 'Down', onclick: move(1) }, '↓'),
            h('button', { class: 'btn', title: 'Remove', onclick: () => { steps.splice(i, 1); emit(); drawSteps(); } }, '✕')));
      }));
    };
    drawSteps();
    const add = (kind, value) => () => { steps.push(makeStep(kind, value)); emit(); drawSteps(); };
    return h('div', {},
      orgList('org-list'),
      h('div', { class: 'field' }, h('label', {}, 'Title'), titleInput),
      Object.entries(groups).map(([g, entries]) => {
        const box = h('fieldset', {}, h('legend', {}, g), h('div', { class: 'fields' }, entries.map(([k, p]) => field(k, p))));
        return g === 'Development only' ? h('details', {}, h('summary', { class: 'muted' }, 'Development only: password logins, auth URLs'), box) : box;
      }),
      h('h2', {}, 'Steps'),
      stepsBox,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn', onclick: add('message', '') }, '+ Message'),
        h('button', { class: 'btn', onclick: add('expect', '') }, '+ Expect'),
        h('button', { class: 'btn', onclick: add('click', '') }, '+ Click'),
        h('button', { class: 'btn', onclick: add('type-from', 'one-time code') }, '+ Type from prompt'),
        h('button', { class: 'btn', onclick: add('max-seconds', '30') }, '+ Max seconds')));
  }

  // ---- Run ----

  async function run(preselected) {
    const root = view;
    const files = await api('GET', '/api/scenarios');
    const chosen = new Set(preselected ? [preselected] : files.filter(f => !f.errors.length).map(f => f.file));
    const parallel = h('input', { type: 'number', min: 1, max: 10, value: 3, 'aria-label': 'Parallel' });
    const headed = h('input', { type: 'checkbox', 'aria-label': 'Show the browsers' });
    const org = h('input', { list: 'run-orgs', placeholder: 'only for conversations without org:', 'aria-label': 'Default org' });
    const result = h('div', { class: 'problems' });
    const body = () => ({ files: [...chosen], parallel: Number(/** @type {HTMLInputElement} */ (parallel).value) || 3, headed: /** @type {HTMLInputElement} */ (headed).checked, defaults: /** @type {HTMLInputElement} */ (org).value ? { org: /** @type {HTMLInputElement} */ (org).value } : {} });
    const showPlan = r => result.replaceChildren(...(r.errors || []).map(e => h('div', { class: 'err' }, e)), ...(r.warnings || []).map(w => h('div', { class: 'muted' }, `warning: ${w}`)), r.plan && r.plan.length ? h('pre', {}, r.plan.join('\n')) : null);
    root.replaceChildren(
      h('div', { class: 'card pad' },
        h('h1', {}, 'Record'),
        h('div', { class: 'muted' }, 'Every message spends agent credits and can run real actions (records created, emails sent). Leave out flows you do not want triggered.'),
        h('div', { class: 'check-list gap' }, files.map(f => {
          const box = h('input', { type: 'checkbox', checked: chosen.has(f.file), disabled: !!f.errors.length });
          box.addEventListener('change', () => { if (/** @type {HTMLInputElement} */ (box).checked) chosen.add(f.file); else chosen.delete(f.file); });
          return h('label', {}, box, h('span', {}, f.file, ' ', h('span', { class: 'muted' }, f.conversations.map(c => c.name).join(', ')), f.errors.length ? h('span', { class: 'err' }, ` ${f.errors[0]}`) : null));
        })),
        h('div', { class: 'fields gap' },
          h('div', { class: 'field' }, h('label', {}, 'Conversations at once'), parallel),
          h('div', { class: 'field' }, h('label', {}, 'Default org'), org, orgList('run-orgs')),
          h('div', { class: 'field' }, h('label', {}, h('span', {}, 'Show the browsers ')), headed)),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: guard(async () => showPlan(await api('POST', '/api/plan', body()))) }, 'Dry run'),
          h('button', { class: 'btn primary', onclick: guard(async () => { const r = await api('POST', '/api/runs', body()); showPlan(r); }) }, 'Record')),
        result),
      liveBlock());
  }

  // ---- Recordings ----

  async function runs(id) {
    const root = view;
    if (id) {
      const { report, baseline } = await api('GET', `/api/run?id=${encodeURIComponent(id)}`);
      const box = h('div', {});
      const actions = h('div', { class: 'row' },
        h('a', { class: 'btn', href: '#/runs' }, 'All runs'),
        baseline === id ? h('span', { class: 'pill same' }, 'baseline') : h('button', { class: 'btn', onclick: guard(async () => { await api('POST', '/api/baseline', { id }); toast('Later runs are compared with this one', 'warn'); runs(id); }) }, 'Set as baseline'),
        h('a', { class: 'btn', href: `/runs/${encodeURIComponent(id)}/report.html`, target: '_blank', rel: 'noopener' }, 'report.html'));
      root.replaceChildren(box);
      renderRun(box, report, { mediaBase: `/runs/${encodeURIComponent(id)}/`, useHash: false, title: `Run ${id}`, actions });
      return;
    }
    const list = await api('GET', '/api/runs');
    root.replaceChildren(h('div', { class: 'card pad' },
      h('h1', {}, 'Recordings'),
      list.length ? h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ['Run', 'Conversations', 'Recorded', 'Flagged', 'Failed', 'Time', ''].map(t => h('th', {}, t)))),
        h('tbody', {}, list.map(r => h('tr', {},
          h('td', {}, h('a', { href: `#/runs/${encodeURIComponent(r.id)}` }, r.startedAt ? new Date(r.startedAt).toLocaleString() : r.id), r.baseline ? ' ' : null, r.baseline ? h('span', { class: 'pill same' }, 'baseline') : null),
          h('td', { class: 'muted' }, (r.names || []).join(', ')),
          h('td', {}, r.recorded ?? ''), h('td', {}, r.flagged ?? ''), h('td', {}, r.failed ?? ''),
          h('td', { class: 'muted' }, r.durationMs ? window.AfrecRender.minutes(r.durationMs) : ''),
          h('td', {}, h('a', { class: 'btn', href: `#/runs/${encodeURIComponent(r.id)}` }, 'Open')))))) : h('div', { class: 'empty' }, 'No recording yet: go to Run.')));
  }

  // ---- Doctor ----

  async function doctor() {
    const root = view;
    const state = await api('GET', '/api/state');
    const reports = await api('GET', '/api/doctor');
    const input = (label, attrs = {}) => { const el = h('input', attrs); return [el, h('div', { class: 'field' }, h('label', {}, label), el)]; };
    const [lOrg, lOrgF] = input('Org (sf alias)', { list: 'doc-orgs', value: (state.project.config.defaults || {}).org || '' });
    const [lUser, lUserF] = input('User (optional, Login-As)', {});
    const [lAgent, lAgentF] = input('Agent (optional)', {});
    const [mSite, mSiteF] = input('Site URL (page with the widget)', { placeholder: 'https://…', value: (state.project.config.defaults || {}).site || '' });
    const [mOrg, mOrgF] = input('Org (optional: release, Login-As)', { list: 'doc-orgs' });
    const canary = h('textarea', { rows: 2, 'aria-label': 'Canary messages' });
    /** @type {HTMLTextAreaElement} */ (canary).value = (state.project.config.doctor.canary || []).join('\n');
    const headed = h('input', { type: 'checkbox' });
    const val = el => /** @type {HTMLInputElement} */ (el).value.trim();
    const start = guard(async () => {
      const targets = [];
      if (val(lOrg)) targets.push({ surface: 'lightning', org: val(lOrg), ...(val(lUser) ? { user: val(lUser) } : {}), ...(val(lAgent) ? { agent: val(lAgent) } : {}) });
      if (val(mSite)) targets.push({ surface: 'messaging', site: val(mSite), ...(val(mOrg) ? { org: val(mOrg) } : {}) });
      await api('POST', '/api/doctor', { targets, canary: val(canary).split('\n').map(s => s.trim()).filter(Boolean), headed: /** @type {HTMLInputElement} */ (headed).checked });
    });
    const packs = state.packs;
    root.replaceChildren(
      h('div', { class: 'card pad' },
        h('h1', {}, 'Doctor'),
        h('div', { class: 'muted' }, 'Checks the chat against an org: prerequisites (read-only), a canary conversation, and every locator of the selector pack. Run it before a demo, and on a preview sandbox weeks before each Salesforce release.'),
        orgList('doc-orgs'),
        h('div', { class: 'fields gap' },
          h('fieldset', {}, h('legend', {}, 'Lightning panel'), lOrgF, lUserF, lAgentF),
          h('fieldset', {}, h('legend', {}, 'Embedded Messaging'), mSiteF, mOrgF),
          h('fieldset', {}, h('legend', {}, 'Canary'), h('div', { class: 'field' }, h('label', {}, 'Messages, one per line'), canary), h('label', {}, headed, ' Show the browser'))),
        h('button', { class: 'btn primary', onclick: start }, 'Run the doctor')),
      liveBlock(),
      h('h2', {}, 'Selector packs'),
      h('div', { class: 'card pad' },
        h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Pack', 'Version', 'From API', 'Origin', 'Verified'].map(t => h('th', {}, t)))),
          h('tbody', {}, packs.packs.map(p => h('tr', {}, h('td', {}, p.id), h('td', {}, p.version), h('td', {}, p.minApiVersion), h('td', {}, p.origin), h('td', { class: 'muted' }, p.verified.map(v => v.release || v.apiVersion).join(', ') || '-'))))),
        Object.entries(packs.overrides).map(([surface, o]) => h('div', { class: 'banner warn' }, `Healed ${surface} locators: ${Object.keys(o.elements).join(', ')}. `,
          o.confirmedAt ? h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/selectors/promote', { surface }); toast(`Promoted to ${r.version}: ${r.written.join(', ')}`, 'warn'); doctor(); }) }, 'Promote into the pack') : 'Run the doctor again to confirm them.')),
        h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: guard(async () => { const r = await api('POST', '/api/selectors/update'); toast(r.map(x => `${x.id}: ${x.action}`).join('; '), 'warn'); doctor(); }) }, 'Download newer packs'))),
      h('h2', {}, 'Checks'),
      reports.length ? h('div', { class: 'grid' }, reports.map(r => h('div', { class: 'card pad' },
        h('div', { class: 'row spread' }, h('strong', {}, `${r.surface} · ${r.target}`), h('span', { class: `pill ${r.status}` }, r.status)),
        h('div', { class: 'muted' }, `${new Date(r.startedAt).toLocaleString()}${r.release ? ` · ${r.release}` : ''}${r.pack ? ` · pack ${r.pack.version}` : ''}`),
        h('ul', { class: 'list gap' },
          r.prereqs.filter(p => !p.ok).map(p => h('li', {}, h('span', { class: `pill ${p.level === 'warn' ? 'flagged' : 'bad'}` }, p.name), ' ', p.detail)),
          r.exchanges.map(x => h('li', {}, x.ok ? '✓ ' : '✗ ', `"${x.text}" `, h('span', { class: 'muted' }, x.ok ? `${x.seconds} s` : x.error || 'no answer'))),
          h('li', {}, r.elements.filter(e => e.status !== 'unused').map(e => h('span', { class: `pill ${e.status === 'ok' ? 'ok' : e.status === 'missing' ? 'bad' : e.status}`, title: e.candidate ? JSON.stringify(e.candidate) : '' }, `${e.name}: ${e.status}`)).reduce((a, b) => a.concat(b, ' '), []))),
        r.error ? h('div', { class: 'err' }, r.error) : null,
        r.status !== 'healthy' ? h('button', { class: 'btn gap', onclick: guard(async () => { const x = await api('POST', '/api/heal', { id: r.id }); toast(`Repair bundle: ${x.dir} (give its README.md to your coding agent)`, 'warn'); }) }, 'Write a repair bundle') : null))) : h('div', { class: 'card empty' }, 'No doctor check yet.'));
  }

  // ---- router ----

  function route() {
    const [, name = 'scenarios', arg] = (location.hash || '#/scenarios').match(/^#\/([^/]*)\/?(.*)$/) || [];
    document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('data-route') === name));
    live.listeners.clear();
    view = h('div', {});
    main.replaceChildren(view);
    const views = { scenarios, run, runs, doctor };
    guard(views[name] || scenarios)(arg ? decodeURIComponent(arg) : undefined);
  }
  window.addEventListener('hashchange', route);
  route();
  void checkChip;
})();
