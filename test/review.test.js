import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { runCheck, describeFailure, pngSize, looksBlank, mostlyInside, videoTooLong } from '../src/engine/checks.js';
import { wordDiff, compareRuns } from '../src/engine/baseline.js';
import { InputBroker } from '../src/engine/input.js';

const exchange = { n: 2, reply: 'A two-hour ride costs $8. Sorry, no tandem bikes.', seconds: 12 };

test('checks: expect, expect-not, max-seconds, expect-button', async () => {
  assert.equal((await runCheck({ type: 'expect', pattern: '\\$\\d', flags: 'i', display: '/\\$\\d/' }, exchange)).ok, true);
  const not = await runCheck({ type: 'expect-not', pattern: 'sorry', flags: 'i', display: 'sorry' }, exchange);
  assert.equal(not.ok, false);
  assert.match(describeFailure(not), /matches sorry \(found "Sorry"\)/);
  assert.equal((await runCheck({ type: 'max-seconds', seconds: 10 }, exchange)).ok, false);
  assert.equal((await runCheck({ type: 'max-seconds', seconds: 15 }, exchange)).ok, true);
  const surface = { hasButton: async label => label === 'Reserve' };
  assert.equal((await runCheck({ type: 'expect-button', label: 'Reserve' }, exchange, surface)).ok, true);
  assert.equal((await runCheck({ type: 'expect-button', label: 'Cancel' }, exchange, surface)).ok, false);
});

/** A minimal RGB PNG of `width` x `height`, filled by `pixel(x, y)`. */
function png(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = pixel(x, y); const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('capture: blank screenshots, a question outside the crop, a video that was not cut', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-png-'));
  const blank = path.join(dir, 'blank.png');
  const busy = path.join(dir, 'busy.png');
  fs.writeFileSync(blank, png(800, 1600, () => [255, 255, 255]));
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 255; };
  fs.writeFileSync(busy, png(800, 1600, () => [noise(), noise(), noise()]));
  assert.deepEqual(pngSize(fs.readFileSync(blank)), { width: 800, height: 1600 });
  assert.equal(looksBlank(blank, 7000), true);
  assert.equal(looksBlank(busy, 7000), false);
  assert.equal(mostlyInside({ x: 10, y: 20, width: 100, height: 40 }, { x: 0, y: 0, width: 400, height: 600 }), true);
  assert.equal(mostlyInside({ x: 10, y: 590, width: 100, height: 40 }, { x: 0, y: 0, width: 400, height: 600 }), false);
  assert.equal(videoTooLong(30, [[0, 5000], [8000, 12000]], 3), true);
  assert.equal(videoTooLong(10, [[0, 5000], [8000, 12000]], 3), false);
});

test('baseline: word diff and run comparison', () => {
  const { ops, similarity } = wordDiff('Station A has 4 bikes and Station B has 2.', 'Station A has 5 bikes and Station B has 2.');
  assert.ok(similarity > 0.8 && similarity < 1, String(similarity));
  assert.deepEqual(ops.filter(o => o.op !== '=').map(o => `${o.op}${o.text}`), ['-4', '+5']);
  const baseline = { startedAt: '2026-10-01T10:00:00Z', results: [
    { name: 'Guest', status: 'recorded', flags: [], exchanges: [{ n: 1, reply: 'Hello! How can I help?', seconds: 3 }, { n: 2, reply: 'Rides cost $4 per hour.', seconds: 8 }] },
    { name: 'Gone', status: 'recorded', flags: [], exchanges: [] },
  ] };
  const current = [
    { name: 'Guest', status: 'flagged', flags: ['2: the answer took longer than 10 s'], exchanges: [{ n: 1, reply: 'Hello! How can I help?', seconds: 3 }, { n: 2, reply: 'I could not find prices right now.', seconds: 14 }] },
    { name: 'New', status: 'recorded', flags: [], exchanges: [] },
  ];
  const cmp = compareRuns(current, baseline);
  const guest = cmp.conversations.find(c => c.name === 'Guest');
  assert.equal(guest.status, 'changed');
  assert.equal(guest.exchanges[0].status, 'same');
  assert.equal(guest.exchanges[1].status, 'changed');
  assert.deepEqual(guest.flagsAdded, ['2: the answer took longer than 10 s']);
  assert.deepEqual(cmp.conversations.map(c => `${c.name}:${c.status}`).sort(), ['Gone:missing', 'Guest:changed', 'New:new']);
});

test('input: answered live, or by the file drop, or not at all', async () => {
  const broker = new InputBroker();
  const asked = [];
  broker.on('request', r => asked.push(r));
  const live = broker.request({ conversation: 'Rider', n: 3, label: 'one-time code', timeout: 5000 });
  assert.equal(broker.answer(asked[0].id, ' 123456 '), true);
  assert.equal(await live, '123456');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-in-')), 'code.txt');
  const dropped = broker.request({ conversation: 'Rider', n: 4, file, timeout: 5000 });
  fs.writeFileSync(file, '654321\n');
  assert.equal(await dropped, '654321');
  assert.equal(fs.existsSync(file), false, 'the file is deleted once read');
  assert.equal(await broker.request({ conversation: 'Rider', n: 5, timeout: 1200 }), null);
  assert.equal(broker.answer('nope', 'x'), false);
});
