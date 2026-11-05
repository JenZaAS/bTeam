import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, client, PW } from './helpers.js';
import { readDocsFile, resolveDocsDir, cacheControlFor } from '../src/docs-static.js';
import { validateConfig } from '../src/config.js';
import { sampleRawConfig } from './helpers.js';

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
    if (r.status === 303) assert.match(r.headers.get('location'), /login/);
  }
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

function rawGet(base, urlPath, cookie) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: `/${urlPath}`, headers: cookie ? { cookie } : {} },
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
    const r = await rawGet(A.base, p, cookie);
    assert.equal(r.status, 400, p);
    assert.equal(r.text.includes('Static page'), false);
    assert.equal(r.headers['x-robots-tag'], 'noindex');
  }
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
