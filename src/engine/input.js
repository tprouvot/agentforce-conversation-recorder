/**
 * Values a `type-from:` step waits for (a one-time code, typically). A request is answered by whichever comes
 * first: the UI or the terminal (answer()), or the file the step names, which is deleted once read so a code is
 * typed once. Values are masked everywhere they are shown or logged.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import readline from 'node:readline';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class InputBroker extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, { id: string, conversation: string, n: number, label: string|null, file: string|null, until: number, resolve: (v: string|null) => void }>} */
    this.waiting = new Map();
    this.seq = 0;
  }

  /**
   * Waits up to `timeout` ms; resolves with the value, or null when nothing came.
   * @param {{ conversation: string, n: number, label?: string|null, file?: string|null, timeout: number }} req
   */
  request(req) {
    const id = `in${++this.seq}`;
    return new Promise(resolve => {
      const entry = { id, conversation: req.conversation, n: req.n, label: req.label || null, file: req.file || null, until: Date.now() + req.timeout, resolve: null };
      let done = false;
      const finish = (value, via) => {
        if (done) return;
        done = true;
        this.waiting.delete(id);
        this.emit('resolved', { id, via, received: value !== null });
        resolve(value);
      };
      entry.resolve = value => finish(value, 'answer');
      this.waiting.set(id, entry);
      this.emit('request', { id, conversation: entry.conversation, n: entry.n, label: entry.label, file: entry.file, until: entry.until });
      (async () => {
        while (!done && Date.now() < entry.until) {
          if (entry.file && fs.existsSync(entry.file)) {
            const text = fs.readFileSync(entry.file, 'utf8').trim();
            if (text) { fs.rmSync(entry.file, { force: true }); finish(text, 'file'); return; }
          }
          await sleep(1000);
        }
        finish(null, 'timeout');
      })();
    });
  }

  /** Answers a pending request; returns false when it is unknown or already answered. */
  answer(id, value) {
    const entry = this.waiting.get(id);
    const text = String(value || '').trim();
    if (!entry || !text) return false;
    entry.resolve(text);
    return true;
  }

  pending() {
    return [...this.waiting.values()].map(({ id, conversation, n, label, file, until }) => ({ id, conversation, n, label, file, until }));
  }
}

/** Asks pending requests on the terminal, one at a time, echoing • for each character. */
export function promptOnTerminal(broker, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return () => {};
  const queue = [];
  let busy = false;
  const next = () => {
    if (busy) return;
    const req = queue.shift();
    if (!req) return;
    if (!broker.waiting.has(req.id)) { next(); return; }
    busy = true;
    const rl = readline.createInterface({ input, output, terminal: true });
    const question = `\n[${req.conversation}] step ${req.n}: type the ${req.label || 'value'}${req.file ? ` (or write it to ${req.file})` : ''}: `;
    const rlAny = /** @type {any} */ (rl);
    const write = rlAny._writeToOutput && rlAny._writeToOutput.bind(rl);
    rlAny._writeToOutput = s => { if (write) write(s.startsWith(question) || s === '\n' || s === '\r\n' ? s : '•'.repeat(Math.max(0, s.length))); };
    const onResolved = e => { if (e.id === req.id) { rl.close(); } };
    broker.on('resolved', onResolved);
    rl.question(question, answer => broker.answer(req.id, answer));
    rl.on('close', () => { broker.off('resolved', onResolved); busy = false; next(); });
  };
  const onRequest = req => { queue.push(req); next(); };
  broker.on('request', onRequest);
  return () => broker.off('request', onRequest);
}
