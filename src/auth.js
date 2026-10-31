// Accounts, passwords (argon2id), sessions and login rate limiting.
// Users are created and reset from the CLI only; there is no self-signup.
import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';
import { audit } from './db.js';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane).
const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const USER_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
let dummyHash = null;

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function checkPasswordPolicy(password, { userId = '', minLength = 12 } = {}) {
  if (typeof password !== 'string') return 'password is required';
  if (password.length < minLength) return `password must be at least ${minLength} characters`;
  if (password.length > 256) return 'password is too long';
  if (userId && password.toLowerCase().includes(userId.toLowerCase())) return 'password must not contain the user id';
  return null;
}

export async function hashPassword(password) {
  return argonHash(password, ARGON);
}

export function createAuth({ db, config, now = () => Date.now() }) {
  const a = config.auth;
  const roles = config.roles;

  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    users: db.prepare('SELECT id, role, disabled, created_at, password_changed_at FROM users ORDER BY id'),
    insertUser: db.prepare('INSERT INTO users (id, role, password_hash, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)'),
    setPassword: db.prepare('UPDATE users SET password_hash = ?, updated_at = ?, password_changed_at = ? WHERE id = ?'),
    setRole: db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (id_hash, user_id, csrf, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT s.*, u.role, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?'),
    touch: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?'),
    rateCount: db.prepare('SELECT COUNT(*) AS n, MIN(at) AS first FROM rate_events WHERE key = ? AND at > ?'),
    rateAdd: db.prepare('INSERT INTO rate_events (key, at) VALUES (?, ?)'),
    rateClear: db.prepare('DELETE FROM rate_events WHERE key = ?'),
    ratePrune: db.prepare('DELETE FROM rate_events WHERE at <= ?'),
  };

  function assertRole(role) {
    if (!roles[role]) throw new Error(`unknown role "${role}" (configured: ${Object.keys(roles).join(', ')})`);
  }

  async function addUser(id, role, password) {
    if (!USER_ID_RE.test(id)) throw new Error('user id must be 2-32 lowercase letters, digits, - or _');
    assertRole(role);
    if (q.user.get(id)) throw new Error(`user "${id}" already exists`);
    const problem = checkPasswordPolicy(password, { userId: id, minLength: a.minPasswordLength });
    if (problem) throw new Error(problem);
    const t = now();
    q.insertUser.run(id, role, await hashPassword(password), t, t, t);
    audit(db, 'cli', 'user.add', `${id} role=${role}`);
  }

  async function resetPassword(id, password) {
    if (!q.user.get(id)) throw new Error(`no user "${id}"`);
    const problem = checkPasswordPolicy(password, { userId: id, minLength: a.minPasswordLength });
    if (problem) throw new Error(problem);
    const t = now();
    q.setPassword.run(await hashPassword(password), t, t, id);
    q.deleteUserSessions.run(id);
    q.rateClear.run(`acct:${id}`);
    audit(db, 'cli', 'user.reset', id);
  }

  function setRole(id, role) {
    assertRole(role);
    if (!q.setRole.run(role, now(), id).changes) throw new Error(`no user "${id}"`);
    q.deleteUserSessions.run(id);
    audit(db, 'cli', 'user.role', `${id} role=${role}`);
  }

  function setDisabled(id, disabled) {
    if (!q.setDisabled.run(disabled ? 1 : 0, now(), id).changes) throw new Error(`no user "${id}"`);
    if (disabled) q.deleteUserSessions.run(id);
    audit(db, 'cli', disabled ? 'user.disable' : 'user.enable', id);
  }

  function unlock(id) {
    q.rateClear.run(`acct:${id}`);
    audit(db, 'cli', 'user.unlock', id);
  }

  function listUsers() {
    return q.users.all().map((u) => ({ id: u.id, role: u.role, disabled: Boolean(u.disabled), createdAt: new Date(u.created_at).toISOString(), passwordChangedAt: new Date(u.password_changed_at).toISOString() }));
  }

  const windowStart = () => now() - a.lockoutMs;
  function isLimited(key, max) {
    const r = q.rateCount.get(key, windowStart());
    return r.n >= max;
  }

  /**
   * Check a login. Returns {ok, user} or {ok:false, reason}. The reason is for logs only;
   * the UI shows one generic message so it does not reveal which accounts exist.
   */
  async function login(id, password, clientKey) {
    const userId = String(id ?? '').trim().toLowerCase().slice(0, 64);
    const ipKey = `ip:${clientKey}`;
    const acctKey = `acct:${userId}`;
    q.ratePrune.run(now() - 24 * 3600_000);
    if (isLimited(ipKey, a.maxAttemptsPerClient)) return { ok: false, reason: 'client-limited' };
    if (isLimited(acctKey, a.maxFailures)) {
      q.rateAdd.run(ipKey, now());
      return { ok: false, reason: 'account-locked' };
    }
    const user = USER_ID_RE.test(userId) ? q.user.get(userId) : null;
    dummyHash ??= await hashPassword(randomToken());
    let valid = false;
    try {
      valid = await argonVerify(user ? user.password_hash : dummyHash, String(password ?? '').slice(0, 256));
    } catch {
      valid = false;
    }
    if (!user || !valid || user.disabled || !roles[user.role]) {
      q.rateAdd.run(ipKey, now());
      q.rateAdd.run(acctKey, now());
      audit(db, `client:${clientKey}`, 'login.fail', userId);
      return { ok: false, reason: !user ? 'unknown-user' : user.disabled ? 'disabled' : 'bad-password' };
    }
    q.rateClear.run(acctKey);
    audit(db, userId, 'login.ok', `client:${clientKey}`);
    return { ok: true, user: { id: user.id, role: user.role } };
  }

  /** Start a new session (always a fresh id: rotation on login). Returns the raw token for the cookie. */
  function createSession(userId, previousToken = null) {
    if (previousToken) q.deleteSession.run(sha256(previousToken));
    const token = randomToken();
    const t = now();
    q.insertSession.run(sha256(token), userId, randomToken(24), t, t, t + a.sessionMaxMs);
    return token;
  }

  /** Resolve a session token. Applies idle and absolute expiry. */
  function getSession(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const idHash = sha256(token);
    const s = q.session.get(idHash);
    if (!s) return null;
    const t = now();
    if (s.expires_at <= t || s.last_seen_at + a.sessionIdleMs <= t || s.disabled || !roles[s.role]) {
      q.deleteSession.run(idHash);
      return null;
    }
    if (t - s.last_seen_at > 60_000) q.touch.run(t, idHash);
    return { userId: s.user_id, role: s.role, csrf: s.csrf };
  }

  function destroySession(token) {
    if (typeof token === 'string' && token) q.deleteSession.run(sha256(token));
  }

  function prune() {
    const t = now();
    q.pruneSessions.run(t, t - a.sessionIdleMs);
    q.ratePrune.run(t - 24 * 3600_000);
  }

  return { addUser, resetPassword, setRole, setDisabled, unlock, listUsers, login, createSession, getSession, destroySession, prune, getUser: (id) => q.user.get(id) ?? null };
}
