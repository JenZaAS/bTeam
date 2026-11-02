import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, PW } from './helpers.js';
import { isLoopback } from '../src/server.js';
import { themeCss } from '../src/theme.js';

const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
function block(html, open, close) {
  const i = html.indexOf(open);
  assert.ok(i >= 0, open);
  const j = html.indexOf(close, i + open.length);
  assert.ok(j > i, close);
  return html.slice(i, j + close.length);
}

let A, owner, designer;
before(async () => {
  A = await makeApp({ handlerOptions: { themeCss: themeCss({ tokens: { accent: '#123456', bg: 'red;}</style>' } }) } });
  owner = client(A.base);
  designer = client(A.base);
  assert.equal((await owner.login('owner', PW.owner)).status, 303);
  assert.equal((await designer.login('designer', PW.designer)).status, 303);
});
after(() => A.close());

test('home page lists boxes with strict security headers and no scripts', async () => {
  const r = await owner.get('');
  assert.equal(r.status, 200);
  const ids = ['digest', 'decisions', 'now', 'design', 'docs', 'questions', 'issues', 'source'];
  const nav = block(r.text, '<nav', '</nav>');
  const cards = block(r.text, '<ul class="bt-cards">', '</ul>');
  const footer = block(r.text, '<footer', '</footer>');
  assert.match(nav, /aria-label="Main navigation"/);
  assert.deepEqual(hrefs(nav), ['./', ...ids.map((id) => `box?id=${id}`), 'workshop', 'inbox', 'advanced']);
  assert.deepEqual(hrefs(cards), ids.map((id) => `box?id=${id}`));
  assert.ok(!r.text.includes('bt-type'));
  assert.ok(!footer.includes('bt-nav-more'));
  assert.ok(!/href="advanced"/.test(footer));
  assert.ok(!footer.includes(A.mirror.commitInfo.short));
  assert.ok(!footer.includes('Source:'));
  assert.ok(!/<script/i.test(r.text));
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
});

test('advanced page shows the mirror line when every box is primary', async () => {
  const r = await owner.get('advanced');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>More ·/);
  const main = block(r.text, '<main', '</main>');
  assert.match(main, /<h1>More<\/h1>/);
  const footer = block(r.text, '<footer', '</footer>');
  assert.ok(!footer.includes('bt-nav-more'));
  assert.ok(!/href="advanced"/.test(footer));
  assert.match(main, /Source:/);
  assert.match(main, new RegExp(A.mirror.commitInfo.short));
  assert.ok(!main.includes('box?id='));
  assert.ok(!main.includes('Nothing here yet.'));
});

test('served HTML pages do not set a no-referrer policy', async () => {
  const login = await client(A.base).get('login');
  const home = await owner.get('');
  const missing = await owner.get('nowhere');
  assert.equal(login.status, 200);
  assert.equal(home.status, 200);
  assert.equal(missing.status, 404);
  for (const r of [login, home, missing]) {
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.match(r.text, /<meta name="referrer" content="same-origin">/);
    assert.ok(!r.text.includes('no-referrer'));
    assert.ok(!/referrerpolicy\s*=/i.test(r.text));
  }
});

test('every box page renders behind login', async () => {
  for (const id of ['digest', 'decisions', 'now', 'design', 'docs', 'questions', 'issues', 'source']) {
    const r = await owner.get(`box?id=${id}`);
    assert.equal(r.status, 200, id);
  }
  const g = await owner.get('box?id=design&folder=2026-01-02&width=390');
  assert.match(g.text, /raw\?path=shots%2F2026-01-02%2Fhome-390.png/);
  assert.ok(!g.text.includes('home-1440.png"'));
});

test('documents, files, images and search work; unknown things 404', async () => {
  assert.match((await owner.get('doc?path=docs%2Fguide.md')).text, /<h2 id="install">/);
  assert.match((await owner.get('file?path=src%2Fapp.js')).text, /console.log\(&quot;hi&quot;\)/);
  const img = await owner.get('raw?path=shots%2F2026-01-02%2Fhome-390.png');
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match((await owner.get('search?q=mirror')).text, /Use a mirror/);
  for (const p of ['doc?path=..%2Fx', 'raw?path=secret%2F.env', 'box?id=nope', 'nowhere']) assert.equal((await owner.get(p)).status, 404, p);
  assert.equal((await fetch(A.base, { method: 'PUT' })).status, 405);
});

test('JSON tools use the signed-in user\'s role', async () => {
  const o = JSON.parse((await owner.get('api/get_box?id=issues')).text);
  const d = JSON.parse((await designer.get('api/get_box?id=issues')).text);
  assert.equal(o.box.nav, 'primary');
  assert.equal(o.box.order, null);
  assert.deepEqual(o.issues.map((i) => i.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(d.issues.map((i) => i.number), [1, 3]);
  assert.equal((await designer.get('doc?path=docs%2Fsecret-ops.md')).status, 404);
  assert.equal((await owner.get('doc?path=docs%2Fsecret-ops.md')).status, 200);
  assert.match((await designer.get('')).text, /<code>designer<\/code>/);
});

test('nothing but login, health and stylesheets is reachable without a session', async () => {
  const anon = client(A.base);
  for (const p of ['', 'box?id=digest', 'doc?path=docs%2Fguide.md', 'raw?path=shots%2F2026-01-02%2Fhome-390.png', 'search?q=mirror', 'workshop', 'inbox', 'inbox-item?id=1', 'advanced']) {
    const r = await anon.get(p);
    assert.equal(r.status, 303, p);
    assert.match(r.headers.get('location'), /^login/, p);
  }
  assert.equal((await anon.get('box?id=digest')).headers.get('location'), 'login?next=box%3Fid%3Ddigest');
  assert.equal((await anon.get('advanced')).headers.get('location'), 'login?next=advanced');
  assert.equal((await anon.get('api/status')).status, 401);
  const login = await anon.get('login');
  assert.equal(login.status, 200);
  assert.ok(!login.text.includes('box?id='), 'login page must not list boxes');
  assert.ok(!login.text.includes('More'));
  assert.ok(!login.text.includes('not been mirrored'));
  assert.equal((await anon.get('healthz')).status, 200);
  assert.equal((await anon.get('assets/base.css')).status, 200);
  const css = (await anon.get('theme.css')).text;
  assert.match(css, /--bt-accent: #123456;/);
  assert.ok(!css.includes('</style>'));
});

test('login honours a safe next target only', async () => {
  const c = client(A.base);
  const r = await c.login('owner', PW.owner, 'box?id=digest');
  assert.equal(r.headers.get('location'), 'box?id=digest');
  const c2 = client(A.base);
  for (const bad of ['https://evil.example/', '//evil.example', '/\\evil', '../x']) {
    const r2 = await c2.login('owner', PW.owner, bad);
    assert.equal(r2.headers.get('location'), './', bad);
    await c2.post('logout', { csrf: await c2.csrf() });
  }
});

test('language follows Accept-Language and ?lang', async () => {
  const nb = await owner.get('', { 'Accept-Language': 'nb-NO,nb;q=0.9' });
  assert.match(nb.text, /<html lang="nb">/);
  assert.match(nb.text, /Oversikt/);
  assert.match((await owner.get('?lang=en')).text, /Overview/);
});

test('api/status returns the mirror commit for the signed-in owner', async () => {
  const s = JSON.parse((await owner.get('api/status')).text);
  assert.equal(s.source.commit.short, A.mirror.commitInfo.short);
});

test('base stylesheet marks More and drops the type label', async () => {
  const css = (await owner.get('assets/base.css')).text;
  assert.match(css, /bt-nav-more/);
  assert.match(css, /a\.bt-advanced-link\s*\{[^}]*display:\s*inline-flex[^}]*min-height:\s*44px[^}]*padding:/);
  assert.ok(!css.includes('bt-type'));
});

test('only loopback hosts count as safe binds', () => {
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(!isLoopback('0.0.0.0'));
});
