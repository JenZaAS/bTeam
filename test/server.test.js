import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeInstance } from './helpers.js';
import { createHandler, startServer, isLoopback } from '../src/server.js';
import { themeCss } from '../src/theme.js';

let I, server, base, dserver, dbase;
before(async () => {
  I = await makeInstance();
  server = await startServer({ handler: createHandler({ core: I.core, viewer: I.owner, themeCss: themeCss({ tokens: { accent: '#123456', bg: 'red;}</style>' } }) }), port: 0 });
  base = `http://127.0.0.1:${server.address().port}/`;
  dserver = await startServer({ handler: createHandler({ core: I.core, viewer: I.designer }), port: 0 });
  dbase = `http://127.0.0.1:${dserver.address().port}/`;
});
after(() => {
  for (const s of [server, dserver]) {
    s.closeAllConnections();
    s.close();
  }
});

const get = (url) => fetch(url).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() }));

test('home page lists boxes with strict security headers and no scripts', async () => {
  const r = await get(base);
  assert.equal(r.status, 200);
  assert.match(r.text, /href="box\?id=digest"/);
  assert.ok(!/<script/i.test(r.text));
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('every box page renders', async () => {
  for (const id of ['digest', 'decisions', 'now', 'design', 'docs', 'questions', 'issues', 'source']) {
    const r = await get(`${base}box?id=${id}`);
    assert.equal(r.status, 200, id);
  }
  const g = await get(`${base}box?id=design&folder=2026-01-02&width=390`);
  assert.match(g.text, /raw\?path=shots%2F2026-01-02%2Fhome-390.png/);
  assert.ok(!g.text.includes('home-1440.png"'));
});

test('documents, files, images and search work; unknown things 404', async () => {
  assert.match((await get(`${base}doc?path=docs%2Fguide.md`)).text, /<h2 id="install">/);
  assert.match((await get(`${base}file?path=src%2Fapp.js`)).text, /console.log\(&quot;hi&quot;\)/);
  const img = await fetch(`${base}raw?path=shots%2F2026-01-02%2Fhome-390.png`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match((await get(`${base}search?q=mirror`)).text, /Use a mirror/);
  for (const p of ['doc?path=..%2Fx', 'raw?path=secret%2F.env', 'box?id=nope', 'nowhere']) assert.equal((await get(base + p)).status, 404, p);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('JSON tools respect the role', async () => {
  const owner = await (await fetch(`${base}api/get_box?id=issues`)).json();
  const designer = await (await fetch(`${dbase}api/get_box?id=issues`)).json();
  assert.deepEqual(owner.issues.map((i) => i.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(designer.issues.map((i) => i.number), [1, 3]);
  assert.equal((await fetch(`${dbase}doc?path=docs%2Fsecret-ops.md`)).status, 404);
});

test('theme tokens are sanitised', async () => {
  const css = (await get(`${base}theme.css`)).text;
  assert.match(css, /--bt-accent: #123456;/);
  assert.ok(!css.includes('</style>'));
});

test('language follows Accept-Language and ?lang', async () => {
  const nb = await fetch(base, { headers: { 'Accept-Language': 'nb-NO,nb;q=0.9' } }).then((r) => r.text());
  assert.match(nb, /<html lang="nb">/);
  assert.match(nb, /Oversikt/);
  assert.match(await get(`${base}?lang=en`).then((r) => r.text), /Overview/);
});

test('only loopback hosts count as safe binds', () => {
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(!isLoopback('0.0.0.0'));
});
