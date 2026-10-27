/**
 * A fake org and a fake Experience Cloud site on 127.0.0.1, for the tests that drive Chromium end to end: the
 * frontdoor, the login form (with its error, password-change and verification screens), Login-As, a Lightning page
 * with a live Agentforce panel, and a site with a live Embedded Messaging widget. The markup follows the bundled
 * packs; the "agent" answers in the page, from RULES below.
 */
import http from 'node:http';

export const ADMIN_ID = '005000000000001AAA';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const STYLE = `
body { font: 15px/1.4 system-ui, sans-serif; margin: 0; background: repeating-linear-gradient(45deg, #f4f6f9, #f4f6f9 6px, #e8edf3 6px, #e8edf3 12px); }
#oneHeader { display: flex; gap: 12px; align-items: center; padding: 8px 16px; background: #032d60; color: #fff; }
.slds-panel { position: fixed; top: 60px; right: 16px; width: 380px; height: 560px; background: #fff; border: 1px solid #c9c9c9; display: flex; flex-direction: column; }
.einstein-assistant-container { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.slds-chat-list { flex: 1; overflow-y: auto; padding: 8px; }
.slds-chat-listitem { margin: 6px 0; }
.slds-chat-message__text_inbound { background: #f3f3f3; padding: 6px 10px; border-radius: 8px; }
.slds-chat-message__text_outbound { background: #0176d3; color: #fff; padding: 6px 10px; border-radius: 8px; margin-left: 40px; }
textarea { margin: 8px; height: 48px; }
`;

/** The chat's behaviour, in the page: Enter sends, the agent thinks (busy), then streams its answer in two parts. */
const chatScript = ({ welcome, history = [] }) => `
(() => {
  const RULES = [
    [/price|cost|how much/i, { text: 'A two-hour ride costs $8.', button: 'Reserve', then: 'Your bike is reserved until 5 pm.' }],
    [/human|person/i, { event: 'Assistant left the conversation' }],
    [/broken/i, { text: 'Sorry, something went wrong.' }],
    [/.*/, { text: 'Hello! I can find stations and prices.' }],
  ];
  const list = document.getElementById('history');
  const input = document.getElementById('input');
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const row = (cls, html) => { const r = document.createElement('div'); r.className = 'slds-chat-listitem ' + cls; r.setAttribute('role', 'listitem'); r.innerHTML = html; list.appendChild(r); list.scrollTop = list.scrollHeight; return r; };
  const user = text => row('slds-chat-listitem_outbound', '<div class="slds-chat-message__text slds-chat-message__text_outbound">' + esc(text) + '</div>');
  const agent = text => row('slds-chat-listitem_inbound', '<div class="slds-chat-message__text slds-chat-message__text_inbound">' + esc(text) + '</div>');
  const answer = rule => {
    const busy = row('slds-chat-listitem_inbound', '<div class="has-progress-indicator">Thinking...</div>');
    setTimeout(() => {
      busy.remove();
      if (rule.event) { row('slds-chat-listitem_event', '<div class="cwc-system-message">' + esc(rule.event) + '</div>'); return; }
      const r = agent(rule.text.slice(0, Math.ceil(rule.text.length / 2)));
      setTimeout(() => {
        r.firstChild.textContent = rule.text;
        if (rule.button) { const b = document.createElement('button'); b.type = 'button'; b.textContent = rule.button; b.onclick = () => answer({ text: rule.then }); r.appendChild(b); }
      }, 400);
    }, 1500); // long enough for the doctor's busy watch (every 500 ms) to see it on a slow machine
  };
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = input.value.trim();
    input.value = '';
    if (!text) return;
    user(text);
    answer(RULES.find(([re]) => re.test(text))[1]);
  });
  window.__chat = {
    start() { agent(${JSON.stringify(welcome)}); for (const [u, a] of ${JSON.stringify(history)}) { user(u); agent(a); } },
    clear() { list.innerHTML = ''; agent(${JSON.stringify(welcome)}); },
  };
})();
`;

function lightningPage({ uid, banner, history }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Home | Salesforce</title><style>${STYLE}</style></head>
<body>
<div id="oneHeader">
  ${banner ? '<div class="system-message">Logged in as Jordan Lee (rider). Log out as Jordan Lee</div>' : ''}
  <button type="button" id="launcher" aria-label="Agentforce">Agentforce</button>
</div>
<main><h1>Home</h1><p>Open the Agentforce panel from the header.</p></main>
<div id="panel" role="dialog" aria-label="Agentforce" hidden>
  <section class="slds-panel">
    <header><h2>Agentforce</h2><button type="button" id="clear" aria-label="Clear history">Clear history</button></header>
    <runtime_copilot_base-assistant-panel>
      <div class="einstein-assistant-container">
        <div class="slds-chat-list" role="list" id="history"></div>
        <textarea id="input" class="chat-box" aria-label="Chat message input"></textarea>
      </div>
    </runtime_copilot_base-assistant-panel>
  </section>
</div>
<script>window.$A = { get: k => (k === '$SObjectType.CurrentUser.Id' ? ${JSON.stringify(uid)} : null) };</script>
<script>${chatScript({ welcome: 'Hi, I am Agentforce. How can I help?', history })}</script>
<script>
  document.getElementById('launcher').onclick = () => { const p = document.getElementById('panel'); if (p.hidden) { p.hidden = false; window.__chat.start(); } };
  // like Lightning, the confirmation is a modal appended to the end of the page
  document.getElementById('clear').onclick = () => {
    const m = document.createElement('div');
    m.setAttribute('role', 'alertdialog');
    m.innerHTML = '<p>Clear the conversation?</p><button type="button">Cancel</button><button type="button">Clear</button>';
    m.lastChild.onclick = () => { m.remove(); window.__chat.clear(); };
    m.children[1].onclick = () => m.remove();
    document.body.appendChild(m);
  };
</script>
</body></html>`;
}

const loginPage = error => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login | Salesforce</title></head>
<body>
<form method="post" action="/login">
  ${error ? `<div id="error">${esc(error)}</div>` : ''}
  <input id="username" name="un" type="email">
  <input id="password" name="pw" type="password">
  <button id="Login" type="submit">Log In</button>
</form>
</body></html>`;

const sitePage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Riders</title><style>${STYLE}</style></head>
<body><h1>Riders</h1><p>Find a bike near you.</p>
<iframe id="embeddedMessagingFrame" name="embeddedMessagingFrame" title="Chat window" src="/s/frame.html" style="position:fixed;right:16px;bottom:16px;width:400px;height:600px;border:0"></iframe>
</body></html>`;

const siteFrame = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>${STYLE} body { background: #fff; } .slds-panel { position: static; width: auto; height: 590px; }</style></head>
<body>
<button type="button" class="chat-fab-container" aria-label="Chat with an agent">Chat</button>
<div id="chat" class="slds-panel" hidden>
  <header><span>Assistant</span><button type="button" class="header-menu-button" aria-label="Open the chat menu">...</button></header>
  <div class="einstein-assistant-container">
    <div class="slds-chat-list" role="list" id="history" aria-label="Chat History"></div>
    <textarea id="input" class="chat-box" aria-label="Type your message" placeholder="Type your message..."></textarea>
  </div>
</div>
<script>${chatScript({ welcome: 'Hi, I am the bike assistant.' })}</script>
<script>
  const launcher = document.querySelector('.chat-fab-container');
  launcher.onclick = () => { launcher.hidden = true; document.getElementById('chat').hidden = false; setTimeout(() => window.__chat.start(), 300); };
</script>
</body></html>`;

const siteLogin = error => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Login</title></head>
<body>
<form method="post" action="/s/login">
  ${error ? `<div role="alert">${esc(error)}</div>` : ''}
  <input type="email" name="username" placeholder="Email">
  <input type="password" name="password" placeholder="Password">
  <button type="submit">Log in</button>
</form>
</body></html>`;

const readForm = req => new Promise(resolve => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
});

const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p.length === 2));

function listen(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, cookies: cookies(req) });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
    try { await handler(req, url, send); } catch (e) { send(500, String(e && e.message)); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`,
    requests,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }),
  })));
}

/**
 * The org. `options` (mutable): users { username: password }, history [[user, agent]] already in the chat,
 * banner (the Login-As banner), refuseLoginAs, siteUrl (where a community Login-As lands).
 * @param {{ users?: Record<string, string>, history?: string[][], banner?: boolean, refuseLoginAs?: boolean, siteUrl?: string }} [options]
 */
export async function startFakeOrg(options = {}) {
  const org = await listen(async (req, url, send) => {
    const jar = cookies(req);
    if (url.pathname === '/secur/frontdoor.jsp') {
      return send(302, '', { Location: '/lightning/page/home', 'Set-Cookie': [`sid=${url.searchParams.get('sid')}; Path=/`, `uid=${ADMIN_ID}; Path=/`] });
    }
    if ((url.pathname === '/' || url.pathname === '/login') && req.method === 'GET') return send(200, loginPage(''));
    if (url.pathname === '/login' && req.method === 'POST') {
      const { un, pw } = await readForm(req);
      if (un.startsWith('change.me')) return send(302, '', { Location: '/_ui/system/security/ChangePassword?retURL=%2F' });
      if (un.startsWith('verify.me')) return send(302, '', { Location: '/_ui/identity/verification/method/EmailVerificationFinishUi' });
      if (!options.users || options.users[un] !== pw) return send(200, loginPage('Please check your username and password.'));
      return send(302, '', { Location: '/lightning/page/home', 'Set-Cookie': ['sid=PASSWORD; Path=/', `uid=005000000000002AAA; Path=/`] });
    }
    if (url.pathname.startsWith('/_ui/')) return send(200, '<!doctype html><title>Verify</title><p>Check your email.</p><input id="emc">');
    if (url.pathname === '/servlet/servlet.su') {
      if (options.refuseLoginAs) return send(200, '<!doctype html><h1>Insufficient Privileges</h1><p>You do not have the level of access necessary to perform the operation you requested.</p>');
      if (url.searchParams.get('sunetworkid')) return send(302, '', { Location: `${options.siteUrl}/s/?su=${url.searchParams.get('sunetworkuserid')}` });
      return send(302, '', { Location: decodeURIComponent(url.searchParams.get('targetURL')), 'Set-Cookie': `uid=${url.searchParams.get('suorgadminid')}; Path=/` });
    }
    if (url.pathname.startsWith('/lightning/')) {
      if (!jar.sid) return send(302, '', { Location: '/' }); // not signed in: the recording context must carry the session
      return send(200, lightningPage({ uid: jar.uid || ADMIN_ID, banner: options.banner, history: options.history || [] }));
    }
    return send(404, 'not found');
  });
  return { ...org, options };
}

/**
 * The Experience Cloud site with its widget, at <url>/s/. `options.users`: { email: password } for its login page.
 * @param {{ users?: Record<string, string> }} [options]
 */
export async function startFakeSite(options = {}) {
  const site = await listen(async (req, url, send) => {
    if (url.pathname === '/s/' || url.pathname === '/s') return send(200, sitePage());
    if (url.pathname === '/s/frame.html') return send(200, siteFrame());
    if (url.pathname === '/s/login' && req.method === 'GET') return send(200, siteLogin(''));
    if (url.pathname === '/s/login' && req.method === 'POST') {
      const { username, password } = await readForm(req);
      if (!options.users || options.users[username] !== password) return send(200, siteLogin('Your login attempt has failed.'));
      return send(302, '', { Location: '/s/', 'Set-Cookie': 'member=1; Path=/' });
    }
    return send(404, 'not found');
  });
  return { ...site, options };
}
