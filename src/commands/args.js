/** A small argument parser: positionals, --flag, --key value, --key=value, repeated keys for lists. */

/**
 * @param {string[]} argv
 * @param {Record<string, 'boolean' | 'string' | 'number' | 'list'>} spec
 * @returns {{ _: string[], [key: string]: any }}
 */
export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('--') || arg === '--') { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq > 0 ? eq : undefined);
    const type = spec[key];
    if (!type) throw new Error(`unknown option --${key} (see --help)`);
    if (type === 'boolean') { out[key] = eq > 0 ? !/^(false|0|no)$/i.test(arg.slice(eq + 1)) : true; continue; }
    let value;
    if (eq > 0) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length) value = argv[++i];
    else throw new Error(`--${key} needs a value`);
    if (type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`--${key} needs a number, got "${value}"`);
      out[key] = n;
    } else if (type === 'list') {
      out[key] = [...(out[key] || []), ...value.split(',').map(s => s.trim()).filter(Boolean)];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Command-line flags that set conversation settings (the file wins over them). */
export const SETTING_FLAGS = {
  org: 'org', surface: 'surface', app: 'app', path: 'path', site: 'site', user: 'user', agent: 'agent', credentials: 'credentials',
  network: 'network', 'login-url': 'loginUrl', 'auth-url': 'authUrl', viewport: 'viewport', record: 'record',
  'reply-timeout': 'replyTimeout', settle: 'settle', 'type-delay': 'typeDelay', warmup: 'warmup', 'input-timeout': 'inputTimeout',
};

/** The settings given as flags. */
export function settingsFromFlags(args) {
  const out = {};
  for (const [flag, key] of Object.entries(SETTING_FLAGS)) if (args[flag] !== undefined) out[key] = args[flag];
  if (args['hide-login-as-banner']) out.hideLoginAsBanner = true;
  if (args['no-fresh']) out.fresh = false;
  return out;
}

/** @returns {Record<string, "boolean" | "string" | "number" | "list">} */
export const settingSpec = () => ({ ...Object.fromEntries(Object.keys(SETTING_FLAGS).map(k => [k, 'string'])), 'hide-login-as-banner': 'boolean', 'no-fresh': 'boolean' });
