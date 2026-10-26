/**
 * Sending a message and waiting for the agent's answer. These only use a surface's read(), input() and heal(), so
 * they work on every chat surface, and the tests drive them with scripted chat states.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Waits until the chat stops changing (or `timeout` passes). */
export async function waitStable(surface, timeout) {
  const end = Date.now() + timeout;
  let last = null;
  let since = Date.now();
  while (Date.now() < end) {
    const chat = await surface.read();
    const sig = JSON.stringify(chat.messages) + chat.busy;
    if (sig !== last) { last = sig; since = Date.now(); } else if (!chat.busy && Date.now() - since > 2500) return;
    await sleep(700);
  }
}

/** Types like a person (or pastes when typeDelay is 0) and sends with Enter; Shift+Enter between lines. */
export async function sendText(surface, text, typeDelay) {
  const input = await surface.input();
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.click();
  if (!typeDelay) {
    await input.fill(text);
  } else {
    const delay = Math.max(8, Math.min(typeDelay, Math.floor(4500 / Math.max(text.length, 1))));
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await input.pressSequentially(lines[i], { delay });
      if (i < lines.length - 1) await input.press('Shift+Enter');
    }
  }
  await input.press('Enter');
}

/**
 * The index of the user's new bubble in `chat`: the first user message showing the sent text that was not there
 * before. A panel that re-renders without its earlier history still finds it. Without a text (a click), any new user
 * message counts.
 */
export function findEcho(chat, before, sentText) {
  const key = norm(sentText).slice(0, 60);
  const isMine = m => m.role === 'user' && (!key || norm(m.text).includes(key));
  const mineBefore = before.messages.filter(isMine).length;
  let seen = 0;
  for (let i = 0; i < chat.messages.length; i++) if (isMine(chat.messages[i]) && ++seen > mineBefore) return i;
  const lastMine = chat.messages.map(isMine).lastIndexOf(true);
  if (key && lastMine >= 0 && chat.messages.length < before.messages.length) return lastMine;
  return -1;
}

/**
 * Waits for the agent's answer to what was just sent: new agent messages after the user's bubble, no busy indicator,
 * and no change for `settle` ms. `optional` (a click) returns null when nothing starts within 15 s. When the bubble
 * never shows, the surface's structural fallback gets one chance to find the chat again (`heal`).
 * @param {any} surface
 * @param {any} before the chat as read just before sending
 * @param {{ timeout: number, settle: number, optional?: boolean, sentText?: string }} options
 */
export async function awaitReply(surface, before, { timeout, settle, optional = false, sentText = '' }) {
  const agentBefore = before.messages.filter(m => m.role === 'agent').length;
  const eventsBefore = before.events.length;
  const started = Date.now();
  let first = 0;
  let lastChange = Date.now();
  let last = null;
  let echoed = false;
  let healTried = false;
  let handoffSince = 0;
  let vanishedSince = 0;
  let busyWhy = '';
  let healed = null;
  while (Date.now() - started < timeout) {
    await sleep(700);
    const chat = await surface.read();
    busyWhy = chat.busy ? chat.busyWhy : busyWhy;
    // the answer is what the agent says after the user's new bubble (a late reply to the previous message stays out)
    const echo = findEcho(chat, before, sentText);
    if (echo >= 0) echoed = true;
    const fresh = (echo >= 0 ? chat.messages.slice(echo + 1).filter(m => m.role === 'agent') : chat.messages.filter(m => m.role === 'agent').slice(agentBefore))
      .map(m => m.text).filter(Boolean);
    if (!fresh.length && last) {
      // the answer arrived, then the chat showed its bubble empty (a re-render): keep the text that was seen
      vanishedSince = vanishedSince || Date.now();
      if (Date.now() - vanishedSince >= Math.max(settle, 8000)) return { text: last, parts: [last], first, last: lastChange, vanished: true, healed };
      continue;
    }
    vanishedSince = 0;
    if (!fresh.length) {
      if (!optional && !echoed && sentText && !healTried && surface.heal && Date.now() - started > 8000) {
        healTried = true;
        healed = await surface.heal(sentText);
        if (healed) { before = { ...before, messages: [], events: before.events }; continue; }
      }
      if (!optional && !echoed && Date.now() - started > 20000) throw new Error('the message never appeared in the chat (not sent, or the chat markup changed: run afrec doctor)');
      if (optional && !chat.busy && Date.now() - started > 15000) return null;
      const handoff = chat.events.slice(eventsBefore).find(e => /\bleft\b|transferr|ended/i.test(e)) || (/transferr/i.test(chat.busyText) ? chat.busyText : '');
      if (handoff && !handoffSince) handoffSince = Date.now();
      // handed to a person (or the session ended): that is the end of this conversation, recorded as such
      if (handoff && Date.now() - handoffSince > 10000) return { text: `(handed off: ${handoff.replace(/\s+/g, ' ')})`, parts: [], first: handoffSince, last: Date.now(), handoff, healed };
      continue;
    }
    if (!first) first = Date.now();
    const text = fresh.join('\n\n');
    if (text !== last || chat.busy) { last = text; lastChange = Date.now(); continue; }
    if (Date.now() - lastChange >= settle) return { text, parts: fresh, first, last: lastChange, healed };
  }
  if (last) return { text: last, parts: [last], first, last: lastChange, healed, warning: `the agent still looked busy after ${Math.round(timeout / 1000)} s (${busyWhy || 'its answer kept changing'})` };
  throw new Error(`no reply within ${Math.round(timeout / 1000)} s`);
}
