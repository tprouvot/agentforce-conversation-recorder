/**
 * Reads scenario files into raw conversations: { name, file, settings, steps }.
 *
 * Markdown (.md): one conversation per file. YAML front matter holds the settings; every top-level list item
 * (`1.` or `-`) is one step, indented lines continue it (a multi-line message), anything else is a note.
 * CSV (.csv): one row per step. A `conversation` column groups rows (a blank cell continues the conversation
 * above); setting columns apply to their whole conversation, so a blank cell inherits the value given earlier.
 * `expect`, `expect not`, `expect button` and `max seconds` columns check the reply to that row's message.
 *
 * A step is a message, or a directive: `click:`, `wait:`, `type-from:`, or one of the checks `expect:`,
 * `expect-not:`, `expect-button:`, `max-seconds:`. A message that really starts with a directive word is written with
 * a leading backslash.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadSchema } from '../schema.js';

const SETTINGS_SCHEMA = loadSchema('scenario').properties.settings;
export const SETTING_KEYS = Object.keys(SETTINGS_SCHEMA.properties);
const KEY_BY_LOWER = Object.fromEntries(SETTING_KEYS.map(k => [k.toLowerCase(), k]));
const DIRECTIVES = ['click', 'wait', 'type-from', 'expect-not', 'expect-button', 'max-seconds', 'expect'];
export const CHECKS = ['expect', 'expect-not', 'expect-button', 'max-seconds'];
const DIRECTIVE_WORD = DIRECTIVES.map(d => d.replace('-', '[-_ ]?')).join('|');
const DIRECTIVE_START = new RegExp(`^(${DIRECTIVE_WORD})\\s*:\\s*([\\s\\S]*)$`, 'i');
const DIRECTIVE_LINE = new RegExp(`^\\s*(?:(?:\\d+[.)]|[-*+])\\s+)?((?:${DIRECTIVE_WORD})\\s*:.*)$`, 'i');
const CSV_STEP_COLUMNS = { conversation: 'conversation', message: 'message', expect: 'expect', expectnot: 'expect-not', expectbutton: 'expect-button', maxseconds: 'max-seconds' };

const squash = raw => String(raw).toLowerCase().replace(/[\s_-]/g, '');
const canonicalKey = raw => KEY_BY_LOWER[squash(raw)];
const directiveName = word => DIRECTIVES.find(d => squash(d) === squash(word));

/** `value` as a case-insensitive regex, or a literal one when written /like this/flags. */
export function parsePattern(value, where) {
  const literal = value.match(/^\/([\s\S]+)\/([dgimsuy]*)$/);
  try {
    const re = literal ? new RegExp(literal[1], literal[2]) : new RegExp(value, 'i');
    return { pattern: re.source, flags: re.flags.replace('g', ''), display: value };
  } catch (e) {
    if (literal) throw new Error(`${where}: invalid regular expression ${value}: ${e.message}`);
    const re = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return { pattern: re.source, flags: re.flags, display: value };
  }
}

const unquote = v => v.replace(/^["“'](.*)["”']$/, '$1');

/** One step from its text: a message, or a directive. */
export function parseStep(raw, where) {
  const text = raw.trim();
  if (text.startsWith('\\')) return { type: 'message', text: text.slice(1), where };
  const m = text.match(DIRECTIVE_START);
  if (!m) return { type: 'message', text, where };
  const value = m[2].trim();
  const type = directiveName(m[1]);
  switch (type) {
    case 'click':
    case 'expect-button':
      if (!value) throw new Error(`${where}: "${type}:" needs the label of the button`);
      return { type, label: unquote(value), where };
    case 'type-from':
      if (!value) throw new Error(`${where}: "type-from:" needs "prompt" or the path of the file to wait for`);
      if (/^(prompt|ask)\b/i.test(value)) return { type: 'message', text: null, prompt: true, fromFile: null, label: unquote(value.replace(/^(prompt|ask)\s*/i, '')) || null, where };
      return { type: 'message', text: null, prompt: true, fromFile: path.resolve(value), where };
    case 'wait':
    case 'max-seconds': {
      const seconds = parseFloat(value);
      if (!(seconds >= 0)) throw new Error(`${where}: "${type}:" needs a number of seconds, got "${value}"`);
      return { type, seconds, where };
    }
    default:
      if (!value) throw new Error(`${where}: "${type}:" needs a pattern`);
      return { type, ...parsePattern(value, where), where };
  }
}

/** The settings of a front matter or a CSV row, with canonical keys. An unknown key is an error, to catch typos. */
export function canonicalSettings(obj, where) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = canonicalKey(k);
    if (!key) throw new Error(`${where}: unknown setting "${k}" (known: ${SETTING_KEYS.join(', ')})`);
    out[key] = v;
  }
  return out;
}

/** Parses the text of one Markdown scenario. */
export function parseMarkdown(text, file) {
  let settings = {};
  let body = text.replace(/^\uFEFF/, '');
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (fm) {
    let parsed;
    try { parsed = YAML.parse(fm[1]); } catch (e) { throw new Error(`${file}: invalid front matter: ${e.message}`); }
    settings = canonicalSettings(parsed || {}, file);
    body = body.slice(fm[0].length);
  }
  const offset = fm ? fm[0].split(/\r?\n/).length - 1 : 0;
  const raw = [];
  let current = null;
  let blank = false;
  body.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, '')).split(/\r?\n/).forEach((line, i) => {
    const where = `${file}:${i + 1 + offset}`;
    const item = line.match(/^ {0,3}(?:\d+[.)]|[-*+])\s+(.*)$/);
    if (item) {
      current = { lines: [stripComment(item[1])], where };
      raw.push(current);
      blank = false;
    } else if (!line.trim()) {
      if (current) blank = true;
    } else if (current && /^(\s{2,}|\t)/.test(line)) {
      const directive = line.match(DIRECTIVE_LINE);
      if (directive) {
        raw.push({ lines: [stripComment(directive[1])], where });
        current = { lines: [], where, closed: true };
      } else if (!current.closed) {
        if (blank) current.lines.push('');
        current.lines.push(line.replace(/^(\t| {2,4})/, ''));
      }
      blank = false;
    } else {
      current = null; // a heading or a paragraph ends the step above it
      blank = false;
    }
  });
  const steps = raw.filter(r => r.lines.length).map(r => parseStep(r.lines.join('\n'), r.where));
  return [{ name: String(settings.name || path.parse(file).name), file, settings, steps }];
}

/** A directive may end with `# comment` (two spaces before the #), as in the examples; a message never loses text. */
function stripComment(line) {
  return DIRECTIVE_START.test(line.trim()) ? line.replace(/\s{2,}#.*$/, '') : line;
}

function parseCsvRows(text) {
  text = text.replace(/^\uFEFF/, '');
  const head = text.split(/\r?\n/, 1)[0];
  const delimiter = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
      if (c === '\n') line++;
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push({ cells: row, line: rowLine });
      row = [];
      field = '';
      rowLine = ++line;
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, line: rowLine }); }
  return rows.filter(r => r.cells.some(f => f.trim() !== ''));
}

/** Parses the text of one CSV file: one or many conversations. */
export function parseCsv(text, file, warnings = []) {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new Error(`${file}: the CSV is empty`);
  const header = rows[0].cells.map(h => h.trim());
  const columns = header.map(h => CSV_STEP_COLUMNS[squash(h)] || canonicalKey(h) || null);
  const ignored = header.filter((h, i) => h && !columns[i]);
  if (ignored.length) warnings.push(`${file}: ignoring column(s) ${ignored.join(', ')}`);
  if (!columns.includes('message')) throw new Error(`${file}: the CSV needs a "message" column`);
  const fallbackName = path.parse(file).name;
  const conversations = new Map();
  let current = null;
  const stepColumns = new Set(Object.values(CSV_STEP_COLUMNS));
  for (const { cells, line } of rows.slice(1)) {
    const where = `${file}:${line}`;
    const cell = key => { const i = columns.indexOf(key); return i >= 0 ? (cells[i] || '') : ''; };
    const id = cell('conversation').trim() || (current ? current.name : fallbackName);
    if (!conversations.has(id)) conversations.set(id, { name: id, file, settings: {}, steps: [] });
    current = conversations.get(id);
    columns.forEach((key, i) => {
      if (!key || stepColumns.has(key)) return;
      const value = (cells[i] || '').trim();
      if (!value) return;
      if (current.settings[key] === undefined) current.settings[key] = value;
      else if (String(current.settings[key]) !== value) {
        throw new Error(`${where}: conversation "${id}" has two values for ${key}: "${current.settings[key]}" and "${value}"`);
      }
    });
    if (cell('message').trim()) current.steps.push(parseStep(cell('message'), where));
    for (const check of CHECKS) {
      const value = cell(check).trim();
      if (value) current.steps.push(parseStep(`${check}: ${value}`, where));
    }
  }
  return [...conversations.values()];
}

/** Parses scenario text by its file extension. */
export function parseScenarioText(text, file, warnings = []) {
  if (/\.csv$/i.test(file)) return parseCsv(text, file, warnings);
  if (/\.(md|markdown)$/i.test(file)) return parseMarkdown(text, file);
  throw new Error(`${file}: expected a .md or .csv file`);
}

/** The .md and .csv files of the inputs (a directory means its scenario files, sorted). */
export function listScenarioFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new Error(`no such file: ${input}`);
    if (fs.statSync(input).isDirectory()) {
      fs.readdirSync(input).filter(f => /\.(md|csv)$/i.test(f) && !/^readme\.md$/i.test(f)).sort().forEach(f => files.push(path.join(input, f)));
    } else {
      files.push(input);
    }
  }
  return files;
}

/** Reads every file (a directory means its .md and .csv files) and returns the raw conversations. */
export function readScenarioFiles(inputs, warnings = []) {
  const files = listScenarioFiles(inputs);
  if (!files.length) throw new Error('no scenario file given (.md or .csv)');
  return files.flatMap(file => parseScenarioText(fs.readFileSync(file, 'utf8'), file, warnings));
}

/** Writes a conversation back as Markdown (the UI's form editor saves through this). */
export function toMarkdown({ settings = {}, steps = [], title = '' }) {
  const front = Object.entries(settings).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const lines = [];
  if (front.length) lines.push('---', YAML.stringify(Object.fromEntries(front)).trimEnd(), '---');
  if (title) lines.push(`# ${title}`, '');
  let n = 0;
  for (const step of steps) {
    const indent = CHECKS.includes(step.type) && n > 0;
    const body = stepText(step);
    if (indent) lines.push(`   - ${body}`);
    else lines.push(`${++n}. ${body.split('\n').join('\n   ')}`);
  }
  return lines.join('\n') + '\n';
}

function stepText(step) {
  switch (step.type) {
    case 'message':
      if (step.prompt && !step.fromFile) return `type-from: prompt${step.label ? ' ' + step.label : ''}`;
      if (step.fromFile) return `type-from: ${step.fromFile}`;
      return DIRECTIVE_START.test(step.text || '') ? '\\' + step.text : step.text || '';
    case 'click': case 'expect-button': return `${step.type}: ${step.label}`;
    case 'wait': case 'max-seconds': return `${step.type}: ${step.seconds}`;
    default: return `${step.type}: ${step.display || step.pattern}`;
  }
}
