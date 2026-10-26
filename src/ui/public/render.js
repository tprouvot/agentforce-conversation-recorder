/*
 * Renders a run (its report.json) in the browser: the overview of its conversations, and one conversation with its
 * video, screenshots, exchanges, checks and baseline diff. Used by the UI and inlined into every run's report.html.
 * Text from the org (answers, names) is only ever set as text, never as HTML.
 */
(function () {
  const SURFACES = { lightning: 'Lightning panel', messaging: 'Embedded Messaging' };

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  const minutes = ms => { const s = Math.round((ms || 0) / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };
  const media = (base, r, file) => `${base}${encodeURIComponent(r.folder)}/${encodeURIComponent(file)}`;
  const statusPill = status => h('span', { class: `pill ${status}` }, status === 'flagged' ? 'flagged' : status === 'failed' ? 'failed' : 'recorded');

  function lightbox(src) {
    const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Screenshot', onclick: () => box.remove() }, h('img', { src, alt: '' }));
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', esc); } });
    document.body.append(box);
  }

  function checkChip(c) {
    const fail = { expect: `no match for ${c.pattern}`, 'expect-not': `matches ${c.pattern}`, 'max-seconds': `slower than ${c.pattern} s`, 'expect-button': `no "${c.pattern}" button` }[c.kind] || c.pattern;
    return h('span', { class: `pill ${c.ok ? 'ok' : 'bad'}`, title: c.detail || '' }, c.ok ? `✓ ${c.kind} ${c.pattern}` : `✗ ${fail}`);
  }

  function diffView(ops) {
    return h('div', { class: 'diff' }, ops.map(o => (o.op === '=' ? o.text : h(o.op === '+' ? 'ins' : 'del', {}, o.text))));
  }

  function overview(report, opts) {
    const results = report.results || [];
    const count = s => results.filter(r => r.status === s).length;
    const cmp = report.comparison ? new Map(report.comparison.conversations.map(c => [c.name, c])) : null;
    const healed = results.filter(r => r.selectors && r.selectors.healed && r.selectors.healed.length);
    return h('div', {},
      h('div', { class: 'row spread' },
        h('div', {}, h('h1', {}, opts.title || 'Agentforce recordings'), h('div', { class: 'muted' }, new Date(report.startedAt).toLocaleString(), ` · ${minutes(report.durationMs)} · up to ${report.parallel} at a time`)),
        opts.actions || null),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, results.length), 'conversations'),
        h('div', { class: 'stat' }, h('b', {}, count('recorded')), 'recorded'),
        h('div', { class: 'stat' }, h('b', {}, count('flagged')), 'flagged'),
        h('div', { class: 'stat' }, h('b', {}, count('failed')), 'failed'),
        report.comparison ? h('div', { class: 'stat' }, h('b', {}, report.comparison.conversations.filter(c => c.status !== 'same').length), 'changed since baseline') : null),
      healed.length ? h('div', { class: 'banner warn' }, `Running on healed locators (${[...new Set(healed.flatMap(r => r.selectors.healed))].join(', ')}): the chat markup changed since the selector pack. Run afrec doctor, then afrec selectors promote.`) : null,
      h('div', { class: 'grid' }, results.map(r => {
        const thumb = r.outputs.includes('conversation.gif') ? media(opts.mediaBase, r, 'conversation.gif')
          : (r.exchanges.find(e => e.screenshot) ? media(opts.mediaBase, r, r.exchanges.find(e => e.screenshot).screenshot) : null);
        const c = cmp && cmp.get(r.name);
        return h('button', { class: 'card conv', onclick: () => opts.open(r) },
          h('div', { class: 'thumb' }, thumb ? h('img', { src: thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'muted' }, r.status === 'failed' ? 'failed before recording' : 'no preview')),
          h('div', { class: 'body' },
            h('div', { class: 'row spread' }, h('h3', {}, r.name), statusPill(r.status)),
            h('div', { class: 'muted' }, `${SURFACES[r.surface] || r.surface} · ${r.exchanges.length} exchange(s) · ${minutes(r.durationMs)}`),
            h('div', { class: 'muted' }, r.who || ''),
            c && c.status !== 'same' ? h('div', {}, h('span', { class: `pill ${c.status}` }, `baseline: ${c.status}`)) : null,
            r.flags.length ? h('div', { class: 'muted' }, `${r.flags.length} flag(s)`) : null));
      })));
  }

  function conversation(report, r, opts) {
    const cmp = report.comparison && report.comparison.conversations.find(c => c.name === r.name);
    const diffs = new Map(cmp ? cmp.exchanges.map(e => [e.n, e]) : []);
    const has = f => r.outputs.includes(f);
    const shots = r.exchanges.filter(e => e.screenshot);
    return h('div', {},
      h('div', { class: 'row spread' },
        h('div', {}, h('button', { class: 'btn', onclick: opts.back }, '← All conversations'), ' ',
          h('h1', { class: 'inline-title' }, r.name), ' ', statusPill(r.status)),
        h('div', { class: 'row' },
          has('conversation.mp4') ? h('a', { class: 'btn', href: media(opts.mediaBase, r, 'conversation.mp4'), download: '' }, 'MP4') : null,
          has('conversation.gif') ? h('a', { class: 'btn', href: media(opts.mediaBase, r, 'conversation.gif'), download: '' }, 'GIF') : null,
          h('a', { class: 'btn', href: media(opts.mediaBase, r, 'transcript.md') }, 'Transcript'))),
      h('div', { class: 'muted meta' }, `${SURFACES[r.surface] || r.surface} · ${r.who || 'not signed in'}${r.agent ? ` · agent ${r.agent}` : ''}`,
        r.selectors ? ` · selectors ${r.selectors.pack} ${r.selectors.version}${r.selectors.release ? ` (${r.selectors.release})` : ''}` : ''),
      r.error ? h('div', { class: 'banner bad' }, `Failed: ${r.error}`) : null,
      r.selectors && r.selectors.healed.length ? h('div', { class: 'banner warn' }, `Running on healed locators: ${r.selectors.healed.join(', ')}`) : null,
      h('div', { class: 'detail' },
        h('div', { class: 'media' },
          has('conversation.mp4') ? h('video', { src: media(opts.mediaBase, r, 'conversation.mp4'), controls: true, preload: 'metadata' })
            : has('conversation.gif') ? h('img', { class: 'gif', src: media(opts.mediaBase, r, 'conversation.gif'), alt: 'Conversation GIF' })
              : r.status === 'failed' ? h('img', { class: 'gif', src: media(opts.mediaBase, r, 'error.png'), alt: 'Last screen' }) : null,
          shots.length ? h('div', { class: 'shots' }, shots.map(e => h('img', { src: media(opts.mediaBase, r, e.screenshot), alt: `Reply ${e.n}`, loading: 'lazy', onclick: ev => lightbox(/** @type {HTMLImageElement} */ (ev.target).src) }))) : null,
          r.flags.length ? h('div', {}, h('h2', {}, 'Flags'), h('ul', { class: 'list' }, r.flags.map(f => h('li', {}, f)))) : null,
          r.warnings.length ? h('div', {}, h('h2', {}, 'Warnings'), h('ul', { class: 'list' }, r.warnings.map(w => h('li', { class: 'muted' }, w)))) : null),
        h('div', { class: 'card pad' },
          r.warmup ? h('div', { class: 'muted note' }, `Warm-up "${r.warmup.text}" opened the conversation.`) : null,
          r.exchanges.length ? r.exchanges.map(e => {
            const d = diffs.get(e.n);
            return h('div', { class: 'exchange' },
              h('div', { class: 'who' }, e.type === 'click' ? `${e.n}. Clicked` : `${e.n}. You`),
              h('div', { class: 'bubble user' }, e.type === 'click' ? `“${e.label}”` : e.text),
              h('div', { class: 'who' }, `Agent${e.seconds != null ? ` · ${e.seconds} s` : ''}${d && d.secondsBefore != null && d.secondsBefore !== e.seconds ? ` (baseline ${d.secondsBefore} s)` : ''}`),
              h('div', { class: 'bubble agent' }, e.reply || '(no reply)'),
              e.checks.length ? h('div', { class: 'checks' }, e.checks.map(checkChip)) : null,
              d && d.status === 'changed' ? h('details', {}, h('summary', { class: 'muted' }, `Changed since the baseline (${Math.round(d.similarity * 100)}% alike)`), diffView(d.diff)) : null);
          }) : h('div', { class: 'muted' }, 'No exchange was recorded.'))));
  }

  /**
   * Renders `report` into `container`. opts: { mediaBase, title, actions, useHash (default true: the open
   * conversation is kept in the URL hash, as in report.html), open (a conversation folder to show first) }
   */
  function renderRun(container, report, opts = {}) {
    const o = { mediaBase: '', useHash: true, ...opts };
    const remember = folder => { if (o.useHash) history.replaceState(null, '', folder ? '#' + encodeURIComponent(folder) : '#'); };
    const show = r => {
      container.replaceChildren(r ? conversation(report, r, { ...o, back: () => { remember(null); show(null); } }) : overview(report, { ...o, open: x => { remember(x.folder); show(x); } }));
      window.scrollTo(0, 0);
    };
    const initial = o.open || (o.useHash ? decodeURIComponent((location.hash || '').slice(1)) : '');
    show((report.results || []).find(r => r.folder === initial) || null);
  }

  window.AfrecRender = { renderRun, h, minutes, SURFACES, checkChip, diffView };
})();
