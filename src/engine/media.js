/**
 * Turns the raw WebM of a conversation into an MP4 that keeps typing and replies at real speed but cuts the
 * agent's thinking to about 1.5 s, and a GIF of that MP4 cropped to the chat. The cut points come from the
 * timeline the player writes (milliseconds since the video started). ffmpeg comes from ffmpeg-static, or FFMPEG_PATH.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function ffmpegBinary() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bin = /** @type {string | null} */ (/** @type {unknown} */ (require('ffmpeg-static')));
  if (!bin) throw new Error('no ffmpeg-static binary for this platform: set FFMPEG_PATH');
  return bin;
}

/** @returns {Promise<void>} */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBinary(), ['-y', '-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error('ffmpeg: ' + String(stderr || err.message).trim().split('\n').slice(-2).join(' ')));
      else resolve(undefined);
    });
  });
}

/** The duration of a media file in seconds (from ffmpeg's banner), or null. */
export function probeDuration(file) {
  return new Promise(resolve => {
    execFile(ffmpegBinary(), ['-hide_banner', '-i', file], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const m = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
    });
  });
}

/** The [start, end] ranges (ms) worth watching, merged and sorted. */
export function keepSegments(events, endMs) {
  const at = (kind, step = null) => { const e = events.find(x => x.kind === kind && x.step === step); return e ? e.t : null; };
  const out = [];
  const add = (a, b) => {
    if (a == null || b == null) return;
    a = Math.max(0, a);
    b = Math.min(endMs, b);
    if (b - a >= 80) out.push([a, b]);
  };
  const ready = at('ready');
  if (ready != null) add(ready - 1500, ready + 300); // the chat, open and ready
  const steps = [...new Set(events.filter(e => e.step != null).map(e => e.step))];
  for (const step of steps) {
    const start = at('start', step);
    if (start == null) continue;
    const waitEnd = at('waitEnd', step);
    if (waitEnd != null) { add(start, Math.min(start + 1000, waitEnd)); continue; } // wait: kept as a one-second beat
    const sent = at('sent', step);
    const first = at('first', step);
    const last = at('last', step);
    const scroll = at('scroll', step);
    const read = at('read', step);
    const bubble = (sent != null ? sent : start) + 600;
    add(start, bubble); // typing (or the click) and the message appearing
    if (first != null) {
      if (first - bubble > 1500) { add(bubble, bubble + 750); add(first - 750, first); } else add(bubble, first); // thinking
      add(first, (last != null ? last : first) + 800); // the reply arriving
    }
    if (scroll != null) add(scroll - 100, read != null ? read : scroll + 1500); // the reply from its question, to read
  }
  const end = at('end');
  if (end != null) add(end - 1200, end);
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    if (prev && seg[0] <= prev[1] + 40) prev[1] = Math.max(prev[1], seg[1]);
    else merged.push([...seg]);
  }
  return merged;
}

export async function makeMp4(webm, mp4, segments) {
  const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p';
  if (!segments.length) {
    await ffmpeg(['-i', webm, '-vf', `fps=25,${even}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', mp4]);
    return;
  }
  const n = segments.length;
  const graph = [`[0:v]split=${n}${segments.map((_, i) => `[s${i}]`).join('')}`]
    .concat(segments.map(([a, b], i) => `[s${i}]trim=start=${(a / 1000).toFixed(3)}:end=${(b / 1000).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`))
    .concat(`${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0,fps=25,${even}[out]`)
    .join(';');
  await ffmpeg(['-i', webm, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', mp4]);
}

/** `crop` is in CSS pixels of the viewport, which is also the video's frame size. */
export async function makeGif(mp4, gif, crop, frame, { fps = 10, maxWidth = 480 } = {}) {
  let cropFilter = '';
  if (crop) {
    const x = Math.max(0, Math.floor(crop.x));
    const y = Math.max(0, Math.floor(crop.y));
    const w = Math.floor(Math.min(crop.width, frame.width - x) / 2) * 2;
    const h = Math.floor(Math.min(crop.height, frame.height - y) / 2) * 2;
    if (w >= 50 && h >= 50) cropFilter = `crop=${w}:${h}:${x}:${y},`;
  }
  const graph = `[0:v]${cropFilter}fps=${fps},scale='min(${maxWidth},iw)':-2:flags=lanczos,split[a][b];`
    + '[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle';
  await ffmpeg(['-i', mp4, '-filter_complex', graph, '-loop', '0', gif]);
}
