// Inbox: users submit contributions; an external agent processes them via the CLI.
// bTeam never posts to the forge itself: it only records the agent's decision and any issue URL.
export const INBOX_KINDS = ['idea', 'ui', 'bug', 'question'];
export const INBOX_STATUSES = ['new', 'triaged', 'accepted', 'issue-created', 'digest', 'question-back', 'rejected'];
export const LIMITS = { title: 200, body: 20_000, reply: 20_000 };

export class InboxError extends Error {}

/**
 * Decide where a submission goes, from the submitting role's policy.
 * - kind listed in policy.auto_accept_eligible -> "auto-accept-eligible" (the agent may adopt it directly if sound)
 * - otherwise, if policy.route_other_to is set -> "owner-decision" (with the configured question label)
 * - otherwise -> "standard"
 */
export function routeFor(policy = {}, kind, ownerLabel = null) {
  const eligible = Array.isArray(policy.auto_accept_eligible) ? policy.auto_accept_eligible : [];
  if (eligible.includes(kind)) return { route: 'auto-accept-eligible', target: null, label: null };
  if (policy.route_other_to) return { route: 'owner-decision', target: policy.route_other_to, label: ownerLabel };
  return { route: 'standard', target: null, label: null };
}

export function createInbox({ db, config, now = () => Date.now() }) {
  const ownerLabel = config.inbox.ownerQuestionLabel;
  const q = {
    insert: db.prepare(`INSERT INTO inbox (user_id, kind, title, body, ref, workshop_item_id, status, route, route_target, route_label, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?)`),
    mine: db.prepare('SELECT * FROM inbox WHERE user_id = ? ORDER BY created_at DESC, id DESC'),
    one: db.prepare('SELECT * FROM inbox WHERE id = ?'),
    byStatus: db.prepare('SELECT * FROM inbox WHERE status = ? ORDER BY created_at, id'),
    all: db.prepare('SELECT * FROM inbox ORDER BY created_at, id'),
    messages: db.prepare('SELECT author, body, created_at FROM inbox_messages WHERE inbox_id = ? ORDER BY id'),
    addMessage: db.prepare('INSERT INTO inbox_messages (inbox_id, author, body, created_at) VALUES (?, ?, ?, ?)'),
    events: db.prepare('SELECT actor, from_status, to_status, note, at FROM inbox_events WHERE inbox_id = ? ORDER BY id'),
    addEvent: db.prepare('INSERT INTO inbox_events (inbox_id, actor, from_status, to_status, note, at) VALUES (?, ?, ?, ?, ?, ?)'),
    update: db.prepare('UPDATE inbox SET status = ?, reply = ?, issue_url = ?, agent_note = ?, updated_at = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE inbox SET status = ?, updated_at = ? WHERE id = ?'),
    ownWorkshop: db.prepare('SELECT id FROM workshop_items WHERE id = ? AND user_id = ?'),
  };

  const shape = (r, { withThread = false } = {}) => {
    if (!r) return null;
    const out = {
      id: r.id,
      userId: r.user_id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      ref: r.ref,
      workshopItemId: r.workshop_item_id,
      status: r.status,
      route: r.route,
      routeTarget: r.route_target,
      routeLabel: r.route_label,
      reply: r.reply,
      issueUrl: r.issue_url,
      agentNote: r.agent_note,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
    if (withThread) {
      out.messages = q.messages.all(r.id).map((m) => ({ author: m.author, body: m.body, at: new Date(m.created_at).toISOString() }));
      out.events = q.events.all(r.id).map((e) => ({ actor: e.actor, from: e.from_status, to: e.to_status, note: e.note, at: new Date(e.at).toISOString() }));
    }
    return out;
  };

  return {
    /** A user submits a contribution. `policy` is the user's role policy; `ref` must already be validated as visible. */
    submit: db.transaction((user, input) => {
      const kind = String(input.kind ?? '');
      if (!INBOX_KINDS.includes(kind)) throw new InboxError(`kind must be one of ${INBOX_KINDS.join(', ')}`);
      const title = String(input.title ?? '').trim();
      const body = String(input.body ?? '').replace(/\r\n/g, '\n').trim();
      if (!title) throw new InboxError('title is required');
      if (title.length > LIMITS.title || body.length > LIMITS.body) throw new InboxError('text is too long');
      let workshopId = null;
      if (input.workshopItemId) {
        workshopId = Number(input.workshopItemId);
        if (!q.ownWorkshop.get(workshopId, user.id)) throw new InboxError('unknown workshop item');
      }
      const r = routeFor(user.policy, kind, ownerLabel);
      const t = now();
      const id = Number(q.insert.run(user.id, kind, title, body, input.ref || null, workshopId, r.route, r.target, r.label, t, t).lastInsertRowid);
      q.addEvent.run(id, `user:${user.id}`, null, 'new', `route=${r.route}`, t);
      return id;
    }),

    mine: (userId) => q.mine.all(userId).map((r) => shape(r)),

    /** One submission for its owner (null for anyone else). */
    mineOne(userId, id) {
      const r = q.one.get(Number(id));
      return r && r.user_id === userId ? shape(r, { withThread: true }) : null;
    },

    /** The user answers a question-back; the item goes back to "new" for the agent. */
    userReply: db.transaction((userId, id, text) => {
      const r = q.one.get(Number(id));
      if (!r || r.user_id !== userId) throw new InboxError('not found');
      if (r.status !== 'question-back') throw new InboxError('you can only answer when a question was sent back to you');
      const body = String(text ?? '').trim();
      if (!body || body.length > LIMITS.reply) throw new InboxError('answer is empty or too long');
      const t = now();
      q.addMessage.run(r.id, `user:${userId}`, body, t);
      q.setStatus.run('new', t, r.id);
      q.addEvent.run(r.id, `user:${userId}`, r.status, 'new', 'answered question', t);
    }),

    // ---- agent side (CLI) ----
    list({ status = null } = {}) {
      if (status && !INBOX_STATUSES.includes(status)) throw new InboxError(`unknown status "${status}"`);
      return (status ? q.byStatus.all(status) : q.all.all()).map((r) => shape(r));
    },
    show(id) {
      const r = shape(q.one.get(Number(id)), { withThread: true });
      if (!r) throw new InboxError(`no inbox item ${id}`);
      return r;
    },
    /** Record the agent's decision. Never talks to the forge. */
    update: db.transaction((id, { status, reply, issueUrl, note, actor = 'agent' }) => {
      const r = q.one.get(Number(id));
      if (!r) throw new InboxError(`no inbox item ${id}`);
      const next = status ?? r.status;
      if (!INBOX_STATUSES.includes(next)) throw new InboxError(`status must be one of ${INBOX_STATUSES.join(', ')}`);
      const url = issueUrl ?? r.issue_url;
      if (url && !/^https:\/\/[^\s<>"]{1,500}$/.test(url)) throw new InboxError('issue URL must be an https:// URL');
      if (next === 'issue-created' && !url) throw new InboxError('status issue-created needs --issue-url');
      if (reply !== undefined && String(reply).length > LIMITS.reply) throw new InboxError('reply is too long');
      const newReply = reply !== undefined ? String(reply).trim() : r.reply;
      if (next === 'question-back' && !newReply) throw new InboxError('status question-back needs --reply with the question');
      const t = now();
      q.update.run(next, newReply || null, url || null, note !== undefined ? String(note).slice(0, 2000) : r.agent_note, t, r.id);
      if (reply !== undefined && newReply) q.addMessage.run(r.id, actor, newReply, t);
      q.addEvent.run(r.id, actor, r.status, next, note ? String(note).slice(0, 500) : null, t);
      return shape(q.one.get(r.id), { withThread: true });
    }),
  };
}
