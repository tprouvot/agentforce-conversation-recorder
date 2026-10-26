/**
 * The deterministic review of a run, in place of reading every transcript by hand:
 *
 *   assertions   expect (the answer matches), expect-not (it does not), max-seconds (it came fast enough),
 *                expect-button (a quick reply or card button is visible in the chat)
 *   capture      a reply screenshot that is nearly blank or does not show its question, an MP4 much longer than its
 *                cut list, a GIF above the size limit
 *
 * A failed check flags the conversation; the run goes on.
 */
import fs from 'node:fs';

/**
 * Checks one assertion step against the exchange it follows. expect-button needs the live surface.
 * @returns {Promise<{ kind: string, pattern: string, ok: boolean, detail?: string }>}
 */
export async function runCheck(step, exchange, surface) {
  const reply = exchange && exchange.reply ? exchange.reply : '';
  switch (step.type) {
    case 'expect':
      return { kind: 'expect', pattern: step.display, ok: !!reply && new RegExp(step.pattern, step.flags).test(reply) };
    case 'expect-not': {
      const m = reply.match(new RegExp(step.pattern, step.flags));
      return { kind: 'expect-not', pattern: step.display, ok: !m, detail: m ? `found "${m[0]}"` : undefined };
    }
    case 'max-seconds': {
      const s = exchange ? exchange.seconds : null;
      return { kind: 'max-seconds', pattern: String(step.seconds), ok: s !== null && s <= step.seconds, detail: s === null ? 'no answer' : `answered in ${s} s` };
    }
    case 'expect-button':
      return { kind: 'expect-button', pattern: step.label, ok: !!surface && await surface.hasButton(step.label) };
    default:
      throw new Error(`not a check: ${step.type}`);
  }
}

/** How a failed check reads in the report. */
export function describeFailure(check) {
  switch (check.kind) {
    case 'expect': return `the reply does not match ${check.pattern}`;
    case 'expect-not': return `the reply matches ${check.pattern}${check.detail ? ` (${check.detail})` : ''}, which it should not`;
    case 'max-seconds': return `the answer took longer than ${check.pattern} s (${check.detail})`;
    case 'expect-button': return `no button or link "${check.pattern}" in the chat`;
    default: return `${check.kind} ${check.pattern} failed`;
  }
}

/** Width and height of a PNG, from its IHDR chunk. */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** A screenshot that compresses to almost nothing shows (almost) nothing. */
export function looksBlank(file, minBytesPerMegapixel) {
  const buffer = fs.readFileSync(file);
  const size = pngSize(buffer);
  if (!size) return false;
  const megapixels = (size.width * size.height) / 1e6;
  return megapixels > 0.05 && buffer.length / megapixels < minBytesPerMegapixel;
}

/** Whether most of `rect` (the question's bubble) lies inside `box` (the crop). */
export function mostlyInside(rect, box) {
  if (!rect || !box) return true; // nothing to compare: do not flag
  const top = Math.max(rect.y, box.y);
  const bottom = Math.min(rect.y + rect.height, box.y + box.height);
  return rect.height <= 0 || (bottom - top) / Math.min(rect.height, box.height) >= 0.5;
}

/** An MP4 longer than its cut list (plus slack) kept parts that should have been cut. */
export function videoTooLong(durationSeconds, segments, slackSeconds) {
  if (durationSeconds === null) return false;
  const expected = segments.reduce((sum, [a, b]) => sum + (b - a), 0) / 1000;
  return segments.length > 0 && durationSeconds > expected + slackSeconds;
}
