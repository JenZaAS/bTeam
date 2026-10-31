// Per-instance SQLite database: users, sessions, rate limiting, Workshop, Inbox and an audit log.
// It lives in the data directory (never in the repo or the config).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MIGRATIONS = [
  // 1: step 2 schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    password_changed_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE rate_events (
    key TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX rate_events_key ON rate_events(key, at);

  CREATE TABLE workshop_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX workshop_items_user ON workshop_items(user_id, updated_at);
  CREATE TABLE workshop_versions (
    item_id INTEGER NOT NULL REFERENCES workshop_items(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, version)
  );
  -- Hook for later steps (mockups, colour profiles, images). Not used by the UI yet.
  CREATE TABLE workshop_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES workshop_items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    media_type TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    data BLOB,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    ref TEXT,
    workshop_item_id INTEGER REFERENCES workshop_items(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'new',
    route TEXT NOT NULL,
    route_target TEXT,
    route_label TEXT,
    reply TEXT,
    issue_url TEXT,
    agent_note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX inbox_user ON inbox(user_id, created_at);
  CREATE INDEX inbox_status ON inbox(status, created_at);
  CREATE TABLE inbox_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE inbox_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inbox_id INTEGER NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    note TEXT,
    at INTEGER NOT NULL
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  `,
];

export function dbPath(dataDir, instanceId) {
  return path.join(dataDir, `${instanceId}.sqlite`);
}

/** Open (and migrate) the instance database. Use ':memory:' for tests. */
export function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, 'a', 0o600));
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function audit(db, actor, action, detail = '') {
  db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(Date.now(), actor, action, String(detail).slice(0, 500));
}
