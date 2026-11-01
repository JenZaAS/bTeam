// Consistent online backup of the instance database (safe while "serve" is running, WAL mode).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export class BackupError extends Error {}

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Write a backup of `db` and verify it. Never overwrites an existing file.
 * @returns {Promise<{file: string, users: number}>}
 */
export async function backupDb(db, { dataDir, instanceId, out = null, now = new Date() }) {
  const file = path.resolve(out ?? path.join(dataDir, 'backups', `${instanceId}-${stamp(now)}.sqlite`));
  if (fs.existsSync(file)) throw new BackupError(`refusing to overwrite ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await db.backup(file);
  fs.chmodSync(file, 0o600);
  const check = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new BackupError(`backup failed its integrity check: ${result}`);
    return { file, users: check.prepare('SELECT COUNT(*) AS n FROM users').get().n };
  } finally {
    check.close();
  }
}
