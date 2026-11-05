import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, client, PW, PNG, makeSourceRepo, sampleRawConfig } from './helpers.js';
import { readDocsFile, resolveDocsDir, cacheControlFor, isHiddenDocsPath } from '../src/docs-static.js';
import { validateConfig } from '../src/config.js';
import { safeRepoPath } from '../src/util.js';

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/docs-site');
const refused = (status) => status === 401 || status === 303;

let A, owner;
before(async () => {
  A = await makeApp({ handlerOptions: { docsDir: fixture } });
  owner = client(A.base);
  assert.equal((await owner.login('owner', PW.owner)).status, 303);
});
after(() => A.close());

test('a signed-out request for any /docs file is refused', async () => {
  const anon = client(A.base);
  for (const p of ['docs', 'docs/', 'docs/index.html', 'docs/search/search_index.json', 'docs/assets/stylesheets/main.01234567.min.css', 'docs/missing-file.html']) {
    const r = await anon.get(p);
    assert.ok(refused(r.status), `${p} -> ${r.status}`);
    assert.equal(r.text.includes('Static page'), false);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    if (r.status === 303) assert.match(r.headers.get('location'), /login/);
  }
});

function rawReq(base, urlPath, { method = 'GET', cookie } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, method, path: urlPath.startsWith('/') ? urlPath : `/${urlPath}`, headers: cookie ? { cookie } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('HEAD and OPTIONS on /docs', async () => {
  const anonHead = await rawReq(A.base, '/docs/index.html', { method: 'HEAD' });
  assert.equal(anonHead.status, 303);
  assert.equal(anonHead.headers['x-robots-tag'], 'noindex');
  assert.equal(anonHead.headers['cache-control'], 'private, no-store');

  const cookie = [...owner.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const head = await rawReq(A.base, '/docs/index.html', { method: 'HEAD', cookie });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(head.headers['cache-control'], 'private, no-store');
  assert.equal(head.headers['x-robots-tag'], 'noindex');

  const opt = await rawReq(A.base, '/docs', { method: 'OPTIONS' });
  assert.equal(opt.status, 405);
  assert.equal(opt.headers['x-robots-tag'], 'noindex');
});

test('a signed-in request gets the file and the cache headers', async () => {
  const page = await owner.get('docs');
  assert.equal(page.status, 200);
  assert.match(page.text, /Static page/);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('cache-control'), 'private, no-store');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');

  const slash = await owner.get('docs/');
  assert.equal(slash.status, 200);
  assert.match(slash.text, /Static page/);
  assert.equal(slash.headers.get('cache-control'), 'private, no-store');

  const index = await owner.get('docs/index.html');
  assert.equal(index.status, 200);
  assert.equal(index.headers.get('cache-control'), 'private, no-store');
  assert.equal(index.headers.get('x-robots-tag'), 'noindex');

  const nested = await owner.get('docs/guide/');
  assert.equal(nested.status, 200);
  assert.match(nested.text, /Guide page/);

  const search = await owner.get('docs/search/search_index.json');
  assert.equal(search.status, 200);
  assert.equal(search.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(search.text, /"docs"/);
  assert.equal(search.headers.get('cache-control'), 'private, no-store');
  assert.equal(search.headers.get('x-robots-tag'), 'noindex');

  const asset = await owner.get('docs/assets/stylesheets/main.01234567.min.css');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(asset.text, /fixture/);
  assert.equal(asset.headers.get('cache-control'), 'private, max-age=604800');
  assert.equal(asset.headers.get('x-robots-tag'), 'noindex');

  const missing = await owner.get('docs/missing-file.html');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-robots-tag'), 'noindex');
  assert.equal(missing.headers.get('cache-control'), 'private, no-store');
});

test('path escapes are refused', async () => {
  const cookie = [...owner.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const paths = [
    'docs/../package.json',
    'docs/..%2fpackage.json',
    'docs/%2e%2e/package.json',
    'docs/%2e%2e%2fpackage.json',
    'docs/guide/../../package.json',
  ];
  for (const p of paths) {
    const r = await rawReq(A.base, p, { cookie });
    assert.equal(r.status, 400, p);
    assert.equal(r.text.includes('Static page'), false);
    assert.equal(r.headers['x-robots-tag'], 'noindex');
  }
});

test('readDocsFile rejects crafted relative paths', () => {
  // ".." that still lands on a file inside the folder is rejected by the segment check.
  // A later root check would allow this one, so this case depends on that guard.
  const dotdot = readDocsFile(fixture, '/docs/guide/../index.html', '/docs/guide/../index.html');
  assert.equal(dotdot.error, 'bad');
  const encoded = readDocsFile(fixture, '/docs/index.html', '/docs/%2e%2e/index.html');
  assert.equal(encoded.error, 'bad');
  const slash = readDocsFile(fixture, '/docs/index.html', '/docs/%2findex.html');
  assert.equal(slash.error, 'bad');
  const back = readDocsFile(fixture, '/docs/index.html', '/docs/..\\index.html');
  assert.equal(back.error, 'bad');
  const ok = readDocsFile(fixture, '/docs/index.html', '/docs/index.html');
  assert.match(ok.body.toString('utf8'), /Static page/);
});

test('a symlink that leaves the root is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-docs-'));
  fs.cpSync(fixture, dir, { recursive: true });
  fs.symlinkSync(path.resolve('package.json'), path.join(dir, 'outside.json'));
  const outside = readDocsFile(dir, '/docs/outside.json', '/docs/outside.json');
  assert.equal(outside.error, 'bad');
  const inside = readDocsFile(dir, '/docs/index.html', '/docs/index.html');
  assert.equal(inside.error, undefined);
  assert.match(inside.body.toString('utf8'), /Static page/);
});

test('an unset or missing directory answers 404 and the app still starts', async () => {
  const off = await makeApp();
  try {
    assert.equal((await client(off.base).get('healthz')).status, 200);
    const c = client(off.base);
    assert.equal((await c.login('owner', PW.owner)).status, 303);
    const r = await c.get('docs/index.html');
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  } finally {
    off.close();
  }

  const gone = await makeApp({ handlerOptions: { docsDir: path.join(os.tmpdir(), 'bteam-docs-missing') } });
  try {
    const c = client(gone.base);
    await c.login('owner', PW.owner);
    assert.equal((await c.get('docs/')).status, 404);
  } finally {
    gone.close();
  }
});

test('a hidden path gives 404', async () => {
  const hidden = readDocsFile(fixture, '/docs/guide/index.html', '/docs/guide/index.html', { hidePaths: ['guide'] });
  assert.equal(hidden.error, 'missing');
  const home = readDocsFile(fixture, '/docs/index.html', '/docs/index.html', { hidePaths: ['guide'] });
  assert.match(home.body.toString('utf8'), /Static page/);
  assert.equal(isHiddenDocsPath('guide/index.html', ['guide']), true);
  assert.equal(isHiddenDocsPath('guideline/index.html', ['guide']), false);

  const src = makeSourceRepo();
  const raw = sampleRawConfig(src.url);
  raw.docs = { hide_paths: ['/guide/'] };
  const app = await makeApp({ raw, handlerOptions: { docsDir: fixture } });
  try {
    const c = client(app.base);
    assert.equal((await c.login('owner', PW.owner)).status, 303);
    const guide = await c.get('docs/guide/');
    assert.equal(guide.status, 404);
    assert.equal(guide.text.includes('Guide page'), false);
    assert.equal((await c.get('docs/guide/index.html')).status, 404);
    const page = await c.get('docs/index.html');
    assert.equal(page.status, 200);
    assert.match(page.text, /Static page/);
  } finally {
    app.close();
  }
});

test('a dot segment is rejected the same way as a parent segment', async () => {
  const parent = readDocsFile(fixture, '/docs/guide/../index.html', '/docs/guide/../index.html');
  assert.equal(parent.error, 'bad');
  for (const p of ['/docs/.env', '/docs/.git/HEAD', '/docs/.well-known/security.txt', '/docs/guide/.hidden']) {
    const got = readDocsFile(fixture, p, p);
    assert.equal(got.error, parent.error, p);
  }
  assert.equal(safeRepoPath('docs/.env'), null);
  assert.equal(safeRepoPath('.git/config'), null);
  assert.equal(safeRepoPath('docs/.well-known/a'), null);
  assert.equal(safeRepoPath('../x'), null);
  assert.equal(safeRepoPath('docs/guide.md'), 'docs/guide.md');

  const cookie = [...owner.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const traversal = await rawReq(A.base, 'docs/../package.json', { cookie });
  assert.equal(traversal.status, 400);
  for (const p of ['docs/.env', 'docs/.git/config', 'docs/guide/.well-known']) {
    const got = await rawReq(A.base, p, { cookie });
    assert.equal(got.status, traversal.status, p);
    assert.equal(got.text.includes('Static page'), false, p);
  }
});

test('an svg under /docs is text/plain and a png stays image/png', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-docs-types-'));
  const svg = '<svg>mark</svg>\n';
  fs.writeFileSync(path.join(dir, 'mark.svg'), svg);
  fs.writeFileSync(path.join(dir, 'mark.SVG'), svg);
  fs.writeFileSync(path.join(dir, 'x.png.svg'), svg);
  fs.writeFileSync(path.join(dir, 'pixel.png'), PNG);
  const app = await makeApp({ handlerOptions: { docsDir: dir } });
  try {
    const c = client(app.base);
    assert.equal((await c.login('owner', PW.owner)).status, 303);
    for (const name of ['mark.svg', 'mark.SVG', 'x.png.svg']) {
      const r = await c.get(`docs/${name}`);
      assert.equal(r.status, 200, name);
      assert.match(r.headers.get('content-type'), /^text\/plain(?:;\s*charset=utf-8)?$/i, name);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', name);
      assert.match(r.text, /<svg/, name);
    }
    const png = await c.get('docs/pixel.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
  } finally {
    app.close();
  }
});

test('DOCS_DIR overrides docs.dir and an empty value leaves docs off', () => {
  const raw = sampleRawConfig('file:///tmp/repo');
  raw.docs = { dir: 'site' };
  const c = validateConfig(raw, { baseDir: '/tmp/cfg' });
  assert.equal(c.docs.dir, path.resolve('/tmp/cfg/site'));
  assert.equal(resolveDocsDir(c, {}), path.resolve('/tmp/cfg/site'));
  assert.equal(resolveDocsDir(c, { DOCS_DIR: '/var/lib/bteam/other' }), path.resolve('/var/lib/bteam/other'));
  assert.equal(resolveDocsDir(c, { DOCS_DIR: '   ' }), path.resolve('/tmp/cfg/site'));
  assert.equal(resolveDocsDir({ docs: { dir: null } }, {}), null);
  assert.equal(cacheControlFor('index.html'), 'private, no-store');
  assert.equal(cacheControlFor('assets/stylesheets/main.01234567.min.css'), 'private, max-age=604800');
  assert.equal(cacheControlFor('search/search_index.json'), 'private, no-store');
});
