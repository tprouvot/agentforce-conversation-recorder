/**
 * Development only: reads a credentials file, one `username password  (optional note)` per line, `#` for comments.
 * Sign-in should go through the sf CLI (the alias's user, or Login-As by its admin); a password login exists for
 * test users of development orgs. A user is picked by full username or by the part before the @. Passwords are never
 * logged, shown in the UI, or written anywhere.
 */
import fs from 'node:fs';

/** The lines of a credentials file, without passwords: [{ username, note }] (for the UI's user picker). */
export function listCredentialUsers(file) {
  return rows(file).map(cells => ({ username: cells[0], note: cells.slice(2).join(' ').replace(/^\(|\)$/g, '') || null }));
}

function rows(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split(/\s+/))
    .filter(cells => cells.length >= 2);
}

export function findCredentials(file, user) {
  const key = String(user).toLowerCase();
  const matches = rows(file).filter(([username]) => {
    const u = username.toLowerCase();
    return u === key || u.split('@')[0] === key;
  });
  if (!matches.length) throw new Error(`no line for "${user}" in ${file}`);
  if (matches.length > 1) throw new Error(`"${user}" matches ${matches.length} lines in ${file}: use the full username`);
  return { username: matches[0][0], password: matches[0][1] };
}
