// Per-user Workshop: private notes and ideas with version history.
// Every query is scoped to the owning user; there is no cross-user access path.
export const WORKSHOP_KINDS = ['note', 'idea'];
export const LIMITS = { title: 200, body: 50_000 };

export class WorkshopError extends Error {}

function clean(input) {
  const kind = WORKSHOP_KINDS.includes(input.kind) ? input.kind : 'note';
  const title = String(input.title ?? '').trim();
  const body = String(input.body ?? '').replace(/\r\n/g, '\n');
  if (!title) throw new WorkshopError('title is required');
  if (title.length > LIMITS.title) throw new WorkshopError(`title is longer than ${LIMITS.title} characters`);
  if (body.length > LIMITS.body) throw new WorkshopError(`text is longer than ${LIMITS.body} characters`);
  return { kind, title, body };
}

export function createWorkshop({ db, config, now = () => Date.now() }) {
  const max = config.workshop.maxItemsPerUser;
  const q = {
    list: db.prepare('SELECT id, kind, title, version, created_at, updated_at FROM workshop_items WHERE user_id = ? ORDER BY updated_at DESC, id DESC'),
    count: db.prepare('SELECT COUNT(*) AS n FROM workshop_items WHERE user_id = ?'),
    get: db.prepare('SELECT * FROM workshop_items WHERE id = ? AND user_id = ?'),
    insert: db.prepare('INSERT INTO workshop_items (user_id, kind, title, body, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)'),
    update: db.prepare('UPDATE workshop_items SET kind = ?, title = ?, body = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?'),
    saveVersion: db.prepare('INSERT INTO workshop_versions (item_id, version, title, body, created_at) VALUES (?, ?, ?, ?, ?)'),
    versions: db.prepare('SELECT v.version, v.title, v.body, v.created_at FROM workshop_versions v JOIN workshop_items i ON i.id = v.item_id WHERE v.item_id = ? AND i.user_id = ? ORDER BY v.version DESC LIMIT 50'),
    remove: db.prepare('DELETE FROM workshop_items WHERE id = ? AND user_id = ?'),
  };
  const shape = (r) => r && { id: r.id, kind: r.kind, title: r.title, body: r.body, version: r.version, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() };

  return {
    list: (userId) => q.list.all(userId).map(shape),
    get(userId, id) {
      const item = shape(q.get.get(Number(id), userId));
      if (!item) throw new WorkshopError('not found');
      return item;
    },
    history: (userId, id) => q.versions.all(Number(id), userId).map((v) => ({ version: v.version, title: v.title, body: v.body, createdAt: new Date(v.created_at).toISOString() })),
    create(userId, input) {
      const c = clean(input);
      if (q.count.get(userId).n >= max) throw new WorkshopError(`you can have at most ${max} items`);
      const t = now();
      return Number(q.insert.run(userId, c.kind, c.title, c.body, t, t).lastInsertRowid);
    },
    /** Update with optimistic locking: `version` must match the version the user edited. */
    update: db.transaction((userId, id, input) => {
      const c = clean(input);
      const cur = q.get.get(Number(id), userId);
      if (!cur) throw new WorkshopError('not found');
      const expected = Number(input.version ?? cur.version);
      if (expected !== cur.version) throw new WorkshopError('this item changed since you opened it; reload and try again');
      if (cur.kind === c.kind && cur.title === c.title && cur.body === c.body) return cur.version;
      q.saveVersion.run(cur.id, cur.version, cur.title, cur.body, cur.updated_at);
      q.update.run(c.kind, c.title, c.body, now(), cur.id, userId, cur.version);
      return cur.version + 1;
    }),
    remove(userId, id) {
      if (!q.remove.run(Number(id), userId).changes) throw new WorkshopError('not found');
    },
  };
}
