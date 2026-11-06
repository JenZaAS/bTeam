import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeInstance, client, PW } from './helpers.js';
import { createHandler, startServer } from '../src/server.js';
import { checkPasswordPolicy, randomToken, sha256 } from '../src/auth.js';
import { sampleRawConfig } from './helpers.js';

const apps = [];
const app = async (o) => {
  const a = await makeApp(o);
  apps.push(a);
  return a;
};
after(() => apps.forEach((a) => a.close()));

// Same shape as randomToken(24): 24 bytes of unpadded base64url.
const PRE_RE = /^[A-Za-z0-9_-]{32}$/;
const alertText = (html) => /role="alert">([^<]+)</.exec(html)[1];

function issuedPre(page) {
  const form = /name="pre" value="([^"]+)"/.exec(page.text);
  assert.ok(form);
  const set = page.headers.getSetCookie().find((s) => s.startsWith('__Host-bteam_pre='));
  assert.ok(set);
  const cookie = decodeURIComponent(set.slice('__Host-bteam_pre='.length).split(';')[0]);
  return { form: form[1], cookie };
}

test('passwords are stored as argon2id hashes; no plaintext anywhere in the database', async () => {
  const A = await app();
  const row = A.state.db.prepare('SELECT password_hash FROM users WHERE id = ?').get('owner');
  assert.match(row.password_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  const dump = JSON.stringify(A.state.db.prepare('SELECT * FROM users').all()) + JSON.stringify(A.state.db.prepare('SELECT * FROM audit').all());
  assert.ok(!dump.includes(PW.owner));
  assert.ok(!JSON.stringify(A.state.auth.listUsers()).includes('argon2'));
});

test('user management rules', async () => {
  const A = await app();
  await assert.rejects(A.state.auth.addUser('owner', 'owner', 'another-long-pass-1'), /already exists/);
  await assert.rejects(A.state.auth.addUser('x', 'owner', 'another-long-pass-1'), /user id/);
  await assert.rejects(A.state.auth.addUser('third', 'nope', 'another-long-pass-1'), /unknown role/);
  assert.match(checkPasswordPolicy('short'), /at least 12/);
  assert.match(checkPasswordPolicy('xx-designer-xx-1', { userId: 'designer' }), /user id/);
  assert.equal(checkPasswordPolicy('a-fine-long-pass'), null);
});

test('successful login sets a hardened cookie and rotates the session', async () => {
  const A = await app();
  const c = client(A.base);
  const r = await c.login('owner', PW.owner);
  assert.equal(r.status, 303);
  const set = r.headers.getSetCookie().find((s) => s.startsWith('__Host-bteam_session='));
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Path=\//);
  const first = c.jar.get('__Host-bteam_session');
  // The database stores only a hash of the token.
  assert.ok(A.state.db.prepare('SELECT 1 FROM sessions WHERE id_hash = ?').get(sha256(first)));
  assert.ok(!A.state.db.prepare('SELECT 1 FROM sessions WHERE id_hash = ?').get(first));
  // Logging in again (with the old cookie still present) replaces the old session.
  c.jar.delete('__Host-bteam_session');
  const pre = /name="pre" value="([^"]+)"/.exec((await c.get('login')).text)[1];
  c.jar.set('__Host-bteam_session', first);
  assert.equal((await c.post('login', { pre, user: 'owner', password: PW.owner })).status, 303);
  const second = c.jar.get('__Host-bteam_session');
  assert.notEqual(first, second);
  assert.equal(A.state.auth.getSession(first), null);
  assert.ok(A.state.auth.getSession(second));
});

test('wrong passwords and unknown users get the same generic answer', async () => {
  const A = await app();
  const a = await client(A.base).login('owner', 'wrong-password-xx');
  const b = await client(A.base).login('nobody', 'wrong-password-xx');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  const msg = (t) => /role="alert">([^<]+)</.exec(t)[1];
  assert.equal(msg(a.text), msg(b.text));
  assert.ok(!a.headers.getSetCookie().some((s) => s.includes('bteam_session=')));
});

test('logout ends the session server-side', async () => {
  const A = await app();
  const c = client(A.base);
  await c.login('designer', PW.designer);
  const token = c.jar.get('__Host-bteam_session');
  const r = await c.post('logout', { csrf: await c.csrf() });
  assert.equal(r.status, 303);
  assert.equal(A.state.auth.getSession(token), null);
  const replay = await fetch(A.base, { redirect: 'manual', headers: { cookie: `__Host-bteam_session=${token}` } });
  assert.equal(replay.status, 303);
});

test('sessions expire after idle time and after the absolute maximum', async () => {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const A = await app({ now: () => t });
  const s1 = A.state.auth.createSession('owner');
  t += 11 * 3600_000;
  assert.ok(A.state.auth.getSession(s1), 'still valid within idle window');
  t += 13 * 3600_000;
  assert.equal(A.state.auth.getSession(s1), null, 'idle expiry');
  const s2 = A.state.auth.createSession('owner');
  for (let i = 0; i < 15; i++) {
    t += 11 * 3600_000; // keep active
    assert.ok(A.state.auth.getSession(s2), `active at step ${i}`);
  }
  t += 11 * 3600_000; // past 7 days in total
  assert.equal(A.state.auth.getSession(s2), null, 'absolute expiry');
});

test('password reset, disable and role change end existing sessions', async () => {
  const A = await app();
  let s = A.state.auth.createSession('designer');
  await A.state.auth.resetPassword('designer', 'a-new-placeholder-pass');
  assert.equal(A.state.auth.getSession(s), null);
  assert.equal((await A.state.auth.login('designer', PW.designer, 'x')).ok, false);
  assert.equal((await A.state.auth.login('designer', 'a-new-placeholder-pass', 'x')).ok, true);
  s = A.state.auth.createSession('designer');
  A.state.auth.setDisabled('designer', true);
  assert.equal(A.state.auth.getSession(s), null);
  assert.equal((await A.state.auth.login('designer', 'a-new-placeholder-pass', 'x')).ok, false);
  A.state.auth.setDisabled('designer', false);
  s = A.state.auth.createSession('designer');
  A.state.auth.setRole('designer', 'owner');
  assert.equal(A.state.auth.getSession(s), null);
  assert.equal(A.state.auth.getUser('designer').role, 'owner');
});

test('POSTs need the session CSRF token and a same-origin Origin', async () => {
  const A = await app();
  const c = client(A.base);
  await c.login('owner', PW.owner);
  const csrf = await c.csrf('workshop');
  assert.equal((await c.post('workshop-save', { title: 'x' })).status, 403);
  assert.equal((await c.post('workshop-save', { title: 'x', csrf: 'wrong' })).status, 403);
  const cross = await c.post('workshop-save', { title: 'x', csrf }, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(cross.text, 'cross-origin request refused');
  const opaque = await c.post('workshop-save', { title: 'x', csrf }, { origin: 'null' });
  assert.equal(opaque.status, 403);
  assert.equal(opaque.text, 'cross-origin request refused');
  assert.equal((await c.post('workshop-save', { title: 'x', csrf })).status, 303);
  // Another user's token does not work for this session.
  const d = client(A.base);
  await d.login('designer', PW.designer);
  assert.equal((await d.post('workshop-save', { title: 'x', csrf })).status, 403);
  // Non-form bodies are refused.
  const raw = await fetch(`${A.base}workshop-save`, { method: 'POST', headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 400);
  assert.equal(A.state.workshop.list('owner').length, 1);
});

test('login itself is CSRF-protected with a pre-session token', async () => {
  const A = await app();
  const c = client(A.base);
  const r = await c.post('login', { user: 'owner', password: PW.owner });
  assert.equal(r.status, 403);
  await c.get('login');
  const r2 = await c.post('login', { user: 'owner', password: PW.owner, pre: 'forged' });
  assert.equal(r2.status, 403);
});

test('repeated failures lock the account; unlock clears it', async () => {
  const A = await app();
  for (let i = 0; i < 5; i++) assert.equal((await client(A.base).login('designer', `wrong-${i}-password`)).status, 401);
  // Even the right password is refused while locked, with the same generic message.
  assert.equal((await client(A.base).login('designer', PW.designer)).status, 401);
  A.state.auth.unlock('designer');
  assert.equal((await client(A.base).login('designer', PW.designer)).status, 303);
});

test('lockout expires after the configured window', async () => {
  let t = Date.parse('2026-01-01T00:00:00Z');
  const A = await app({ now: () => t });
  for (let i = 0; i < 5; i++) await A.state.auth.login('owner', 'nope-nope-nope', 'c1');
  assert.equal((await A.state.auth.login('owner', PW.owner, 'c2')).reason, 'account-locked');
  t += 16 * 60_000;
  assert.equal((await A.state.auth.login('owner', PW.owner, 'c2')).ok, true);
});

test('one client is rate limited across accounts', async () => {
  const A = await app();
  for (let i = 0; i < 20; i++) await A.state.auth.login(`user-${i % 10}`, 'nope-nope-nope', 'same-client');
  const r = await A.state.auth.login('owner', PW.owner, 'same-client');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'client-limited');
  assert.equal((await A.state.auth.login('owner', PW.owner, 'other-client')).ok, true);
});

test('dev user override only applies to loopback clients and needs an existing user', async () => {
  const A = await app();
  const server = await startServer({ handler: createHandler({ core: A.core, auth: A.state.auth, workshop: A.state.workshop, inbox: A.state.inbox, devUser: 'designer' }), port: 0 });
  try {
    const base = `http://127.0.0.1:${server.address().port}/`;
    const r = await fetch(base, { redirect: 'manual' });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /Development mode/);
    assert.match(text, /Signed in as designer/);
    assert.doesNotMatch(/<footer[\s\S]*<\/footer>/.exec(text)[0], /<code>/);
    // A non-loopback client (simulated) gets no override.
    const handler = createHandler({ core: A.core, auth: A.state.auth, devUser: 'designer' });
    const out = {};
    await handler(
      { method: 'GET', url: '/', headers: {}, socket: { remoteAddress: '192.0.2.10' } },
      { writeHead: (s, h) => Object.assign(out, { s, h }), end: () => {} },
    );
    assert.equal(out.s, 303);
    // Unknown dev user: no override.
    const h2 = createHandler({ core: A.core, auth: A.state.auth, devUser: 'ghost' });
    const out2 = {};
    await h2({ method: 'GET', url: '/', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, { writeHead: (s) => (out2.s = s), end: () => {} });
    assert.equal(out2.s, 303);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('browser login sends a same-origin Origin; an Origin of null is still refused', async () => {
  const A = await app();
  const c = client(A.base);
  const page = await c.get('login');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.match(page.text, /<meta name="referrer" content="same-origin">/);
  const pre = /name="pre" value="([^"]+)"/.exec(page.text)[1];
  const form = { pre, user: 'owner', password: PW.owner, next: './' };
  // (a) Opaque origin. Browsers send the four characters "null" when no origin is disclosed.
  const opaque = await c.post('login', form, { origin: 'null' });
  assert.equal(opaque.status, 403);
  assert.equal(opaque.text, 'cross-origin request refused');
  // (b) Plain cross-site Origin, with no X-Forwarded-Host.
  const cross = await c.post('login', form, { origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  assert.equal(cross.text, 'cross-origin request refused');
  // (c) is the forged X-Forwarded-Host test below.
  // Referrer-Policy: same-origin makes the browser send this page's own origin on the form POST.
  const ok = await c.post('login', form, { origin: A.base.replace(/\/$/, '') });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('referrer-policy'), 'same-origin');
  assert.equal(ok.headers.get('location'), './');
  const home = await c.get('');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('referrer-policy'), 'same-origin');
  assert.match(home.text, /Signed in as owner/);
  assert.doesNotMatch(/<footer[\s\S]*<\/footer>/.exec(home.text)[0], /<code>/);
});

test('a forged X-Forwarded-Host plus a matching Origin is refused', async () => {
  const inst = await makeInstance();
  const raw = { ...sampleRawConfig(inst.src.url), web: { trust_proxy: true } };
  const A = await app({ raw });
  assert.equal(A.config.web.trustProxy, true);
  const c = client(A.base);
  const page = await c.get('login');
  const pre = /name="pre" value="([^"]+)"/.exec(page.text)[1];
  const forged = await c.post(
    'login',
    { pre, user: 'owner', password: PW.owner },
    { origin: 'https://evil.example.test', 'x-forwarded-host': 'evil.example.test' },
  );
  assert.equal(forged.status, 403);
  assert.equal(forged.text, 'cross-origin request refused');
  // No public origin: a real browser Origin that matches Host still logs in.
  const ok = await c.login('owner', PW.owner);
  assert.equal(ok.status, 303);
  assert.equal((await c.get('')).status, 200);
});

test('with web.public_origin set, Origin must match it and not X-Forwarded-Host', async () => {
  const inst = await makeInstance();
  const raw = { ...sampleRawConfig(inst.src.url), web: { trust_proxy: true, public_origin: 'https://app.example.test' } };
  const A = await app({ raw });
  assert.equal(A.config.web.publicOrigin, 'https://app.example.test');
  const c = client(A.base);
  const page = await c.get('login');
  const pre = /name="pre" value="([^"]+)"/.exec(page.text)[1];
  const form = { pre, user: 'owner', password: PW.owner };
  const forged = await c.post('login', form, { origin: 'https://evil.example.test', 'x-forwarded-host': 'evil.example.test' });
  assert.equal(forged.status, 403);
  assert.equal(forged.text, 'cross-origin request refused');
  // Matching the listen Host is not enough once a public origin is configured.
  const viaHost = await c.post('login', form, { origin: A.base.replace(/\/$/, '') });
  assert.equal(viaHost.status, 403);
  const ok = await c.post('login', form, { origin: 'https://app.example.test', 'x-forwarded-host': 'evil.example.test' });
  assert.equal(ok.status, 303);
  const home = await c.get('');
  assert.equal(home.status, 200);
  assert.match(home.text, /Signed in as owner/);
  assert.match((await c.get('advanced')).text, /<code>owner<\/code>/);
});

test('non-secure cookie mode uses plain cookie names without Secure', async () => {
  const inst = await makeInstance();
  const raw = { ...sampleRawConfig(inst.src.url), web: { secure_cookies: false, same_site: 'strict' } };
  const A = await app({ raw });
  const r = await client(A.base).login('owner', PW.owner);
  const set = r.headers.getSetCookie().find((s) => s.startsWith('bteam_session='));
  assert.ok(set);
  assert.ok(!/Secure/.test(set));
  assert.match(set, /SameSite=Strict/);
});

test('a valid pre-login cookie is reused on the next login page', async () => {
  const A = await app();
  const crafted = `${'Ab3-_'.repeat(6)}Cd`;
  for (const token of [randomToken(24), crafted]) {
    assert.match(token, PRE_RE);
    const c = client(A.base);
    c.jar.set('__Host-bteam_pre', token);
    const got = issuedPre(await c.get('login'));
    assert.equal(got.form, token);
    assert.equal(got.cookie, token);
  }
});

test('a pre-login cookie with the wrong shape is replaced', async () => {
  const A = await app();
  const cases = [
    ['wrong charset', `${'Ab3-_'.repeat(6)}C+`],
    ['too long', 'A'.repeat(64)],
    ['too short', `${'Ab3-_'.repeat(6)}C`],
  ];
  for (const [name, value] of cases) {
    assert.equal(PRE_RE.test(value), false, name);
    const c = client(A.base);
    c.jar.set('__Host-bteam_pre', value);
    const got = issuedPre(await c.get('login'));
    assert.equal(got.form, got.cookie, name);
    assert.match(got.form, PRE_RE, name);
    assert.notEqual(got.form, value, name);
  }
});

test('a second login page keeps the first form able to sign in', async () => {
  const A = await app();
  const c = client(A.base);
  const first = issuedPre(await c.get('login'));
  assert.equal(first.form, first.cookie);
  assert.match(first.form, PRE_RE);
  const second = issuedPre(await c.get('login'));
  assert.equal(second.form, first.form);
  assert.equal(second.cookie, first.cookie);
  const r = await c.post('login', { pre: first.form, user: 'owner', password: PW.owner, next: './' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), './');
  const home = await c.get('');
  assert.equal(home.status, 200);
  assert.match(home.text, /Signed in as owner/);
});

test('the per-account login limit locks at the configured threshold', async () => {
  const A = await app();
  const max = A.config.auth.maxFailures;
  const acctCount = (id) => A.state.db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ?').get(`acct:${id}`).n;

  for (let i = 0; i < max - 1; i++) assert.equal((await client(A.base).login('designer', `wrong-${i}-password`)).status, 401);
  assert.equal(acctCount('designer'), max - 1);
  const allowed = await client(A.base).login('designer', PW.designer);
  assert.equal(allowed.status, 303, 'just under the account threshold');
  assert.equal(allowed.headers.get('location'), './');

  let sample;
  for (let i = 0; i < max; i++) {
    const r = await client(A.base).login('owner', `wrong-${i}-password`);
    assert.equal(r.status, 401);
    sample ??= alertText(r.text);
  }
  assert.equal(acctCount('owner'), max);
  const locked = await client(A.base).login('owner', PW.owner);
  assert.equal(locked.status, 401);
  assert.equal(alertText(locked.text), sample);
  assert.ok(!locked.headers.getSetCookie().some((s) => s.includes('bteam_session=')));
  const again = await A.state.auth.login('owner', PW.owner, 'other-client');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'account-locked');
});

test('the per-IP login limit locks at the configured threshold', async () => {
  const A = await app();
  const max = A.config.auth.maxAttemptsPerClient;
  const ipCount = () => A.state.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key LIKE 'ip:%'").get().n;

  let sample;
  for (let i = 0; i < max - 1; i++) {
    const r = await client(A.base).login(`user-${i}`, 'wrong-password-xx');
    assert.equal(r.status, 401);
    sample ??= alertText(r.text);
  }
  assert.equal(ipCount(), max - 1);
  const allowed = await client(A.base).login('owner', PW.owner);
  assert.equal(allowed.status, 303, 'just under the client threshold');
  assert.equal(allowed.headers.get('location'), './');
  // A successful sign-in does not record a client event, so one more failure reaches the threshold.
  assert.equal(ipCount(), max - 1);
  assert.equal((await client(A.base).login('user-extra', 'wrong-password-xx')).status, 401);
  assert.equal(ipCount(), max);

  const locked = await client(A.base).login('designer', PW.designer);
  assert.equal(locked.status, 401);
  assert.equal(alertText(locked.text), sample);
  assert.ok(!locked.headers.getSetCookie().some((s) => s.includes('bteam_session=')));
  const ipKey = A.state.db.prepare("SELECT key FROM rate_events WHERE key LIKE 'ip:%' GROUP BY key").all();
  assert.equal(ipKey.length, 1);
  const same = await A.state.auth.login('designer', PW.designer, ipKey[0].key.slice(3));
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'client-limited');
  assert.equal((await A.state.auth.login('designer', PW.designer, 'other-client')).ok, true);
});
