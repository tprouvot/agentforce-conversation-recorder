/** The video cut and the GIF, through the real ffmpeg (ffmpeg-static) on a generated test clip. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpegBinary, makeMp4, makeGif, probeDuration } from '../src/engine/media.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'afrec-media-'));
const clip = path.join(tmp, 'clip.mp4');
const gifSize = file => { const b = fs.readFileSync(file); return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }; };

before(() => {
  // four seconds of a moving test pattern, 320x240, the stand-in for a recorded conversation
  execFileSync(ffmpegBinary(), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4', '-pix_fmt', 'yuv420p', clip]);
});

test('the duration of a media file, or null for anything else', async () => {
  assert.ok(Math.abs(await probeDuration(clip) - 4) < 0.1);
  const text = path.join(tmp, 'notes.txt');
  fs.writeFileSync(text, 'not a video');
  assert.equal(await probeDuration(text), null);
});

test('the MP4 keeps only its segments, in order; without segments, the whole recording', async () => {
  const cut = path.join(tmp, 'cut.mp4');
  await makeMp4(clip, cut, [[0, 1000], [2500, 3000]]);
  assert.ok(Math.abs(await probeDuration(cut) - 1.5) < 0.2, String(await probeDuration(cut)));
  const whole = path.join(tmp, 'whole.mp4');
  await makeMp4(clip, whole, []);
  assert.ok(Math.abs(await probeDuration(whole) - 4) < 0.2);
});

test('the GIF: cropped to the chat (even sizes, inside the frame), no crop when the box is too small, capped in width', async () => {
  const cropped = path.join(tmp, 'cropped.gif');
  await makeGif(clip, cropped, { x: 10.6, y: 20.2, width: 151, height: 400 }, { width: 320, height: 240 });
  assert.deepEqual(gifSize(cropped), { width: 150, height: 220 }, 'the height is clipped to the frame, both are even');
  const whole = path.join(tmp, 'whole.gif');
  await makeGif(clip, whole, { x: 0, y: 0, width: 40, height: 40 }, { width: 320, height: 240 });
  assert.deepEqual(gifSize(whole), { width: 320, height: 240 });
  const small = path.join(tmp, 'small.gif');
  await makeGif(clip, small, null, null, { maxWidth: 160 });
  assert.deepEqual(gifSize(small), { width: 160, height: 120 });
});

test('an ffmpeg failure is an error with ffmpeg\'s own last words; FFMPEG_PATH replaces the bundled binary', async () => {
  await assert.rejects(makeMp4(path.join(tmp, 'missing.webm'), path.join(tmp, 'x.mp4'), []), /^Error: ffmpeg: .*missing\.webm/);
  const saved = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(tmp, 'no-such-ffmpeg');
  try {
    assert.equal(ffmpegBinary(), path.join(tmp, 'no-such-ffmpeg'));
    await assert.rejects(makeMp4(clip, path.join(tmp, 'y.mp4'), []), /^Error: ffmpeg: /);
    assert.equal(await probeDuration(clip), null);
  } finally { if (saved === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = saved; }
});
