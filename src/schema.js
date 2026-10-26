/**
 * A small JSON Schema validator for the subset the tool's own schemas use: type, enum, pattern, format uri,
 * minimum, maximum, properties, additionalProperties false, required, items, minItems, anyOf. It keeps the tool free
 * of a validator dependency; the schemas stay standard, so editors and other tools can use them too.
 */
import fs from 'node:fs';

const SCHEMAS = new Map();

/** Loads a schema shipped in schema/ (cached). */
export function loadSchema(name) {
  if (!SCHEMAS.has(name)) {
    SCHEMAS.set(name, JSON.parse(fs.readFileSync(new URL(`../schema/${name}.schema.json`, import.meta.url), 'utf8')));
  }
  return SCHEMAS.get(name);
}

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Returns the list of problems ("settings.viewport: must match ...") of `value` against `schema`; empty when valid.
 * @param {any} value
 * @param {any} schema
 * @param {string} [at]
 * @param {any} [root] the schema `$ref: "#/$defs/..."` resolves against
 * @returns {string[]}
 */
export function validate(value, schema, at = '', root = schema) {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node && node[key], root);
    if (!target) throw new Error(`schema: unresolved $ref ${schema.$ref}`);
    return validate(value, target, at, root);
  }
  const errors = [];
  const where = at || '(root)';
  if (schema.anyOf) {
    const ok = schema.anyOf.some(s => !validate(value, s, at, root).length);
    if (!ok) errors.push(`${where}: does not match any allowed form`);
    return errors;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const fits = types.some(t => t === actual || (t === 'integer' && Number.isInteger(value)) || (t === 'number' && actual === 'number'));
    if (!fits) { errors.push(`${where}: must be ${types.join(' or ')}, got ${actual}`); return errors; }
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${where}: must be one of ${schema.enum.join(', ')}, got "${value}"`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: "${value}" does not match ${schema.pattern}`);
    if (schema.format === 'uri') { try { new URL(value); } catch { errors.push(`${where}: "${value}" is not a URL`); } }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(item, schema.items, `${at}[${i}]`, root)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required || []) if (value[key] === undefined) errors.push(`${at ? at + '.' : ''}${key}: is required`);
    for (const [key, v] of Object.entries(value)) {
      const sub = schema.properties && schema.properties[key];
      const next = at ? `${at}.${key}` : key;
      if (sub) errors.push(...validate(v, sub, next, root));
      else if (schema.additionalProperties === false) errors.push(`${next}: is not a known property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(v, schema.additionalProperties, next, root));
    }
  }
  return errors;
}
