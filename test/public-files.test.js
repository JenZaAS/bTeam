import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { makeApp, makeInstance, makeSourceRepo, client, PW, PNG } from './helpers.js';
import { validateConfig } from '../src/config.js';
import { NotFound } from '../src/core.js';

const PHRASE = 'plainnotealpha';
const TXT = 'notes/only.txt';
const IMAGE = 'img/pixel.PNG';

function rawConfig(url) {
  return {
    instance: { id: 'sample', title: 'Sample', locale: ['en'] },
    source: { type: 'git-mirror', url, branch: 'main', refresh: '10m' },
    boxes: [
      { id: 'docs', type: 'documents', title: 'Docs', paths: ['**/*'] },
      { id: 'shots', type: 'gallery', title: 'Shots', root: 'img/' },
      { id: 'source', type: 'source-browser', title: 'Files', include: ['**/*'] },
    ],
    roles: {
      owner: { audiences: ['all', 'owner'] },
      designer: { audiences: ['all'] },
    },
    viewer: { default_role: 'designer' },
  };
}

const FILES = {
  'docs/public.md': '---\naudience: all\n---\n# Public\n\nHello from the public note.\n',
  [TXT]: `${PHRASE} is in the text file.\n`,
  [IMAGE]: PNG,
};

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function rawHead(base, urlPath, cookie) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        method: 'HEAD',
        path: urlPath.startsWith('/') ? urlPath : `/${urlPath}`,
        headers: cookie ? { cookie } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let app, owner, designer, cli;

before(async () => {
  const src = makeSourceRepo(FILES, { stampAudience: false });
  app = await makeApp({ raw: rawConfig(src.url) });
  owner = client(app.base);
  designer = client(app.base);
  assert.equal((await owner.login('owner', PW.owner)).status, 303);
  assert.equal((await designer.login('designer', PW.designer)).status, 303);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-files-'));
  const cfg = path.join(dir, 'instance.yaml');
  const data = path.join(dir, 'data');
  fs.writeFileSync(cfg, stringify(rawConfig(src.url)));
  const bin = fileURLToPath(new URL('../bin/bteam.js', import.meta.url));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C' };
  const run = (args) => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [bin, ...args, '--config', cfg, '--data', data], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (err) {
      return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };
  const sync = run(['sync']);
  assert.equal(sync.status, 0, sync.stderr || sync.stdout);
  cli = (role, ...args) => run(['tool', ...args, '--role', role]);
});

after(() => app?.close());

test('docs.public_extensions defaults to image types and rejects bad entries', () => {
  const raw = rawConfig('file:///tmp/repo');
  assert.deepEqual(validateConfig(raw).docs.publicExtensions, ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);

  raw.docs = { public_extensions: ['.PNG', 'jpg', 'JPG'] };
  assert.deepEqual(validateConfig(raw).docs.publicExtensions, ['png', 'jpg']);

  const empty = rawConfig('file:///tmp/repo');
  empty.docs = { public_extensions: [] };
  assert.deepEqual(validateConfig(empty).docs.publicExtensions, []);

  for (const bad of ['png', [''], ['../x'], ['a.b'], ['*'], ['.'], ['png/jpg']]) {
    const next = rawConfig('file:///tmp/repo');
    next.docs = { public_extensions: bad };
    assert.throws(() => validateConfig(next), /public_extensions/, JSON.stringify(bad));
  }
});

test('an extension listed in docs.public_extensions stays visible to a role without owner', async () => {
  const repo = makeSourceRepo(
    {
      'docs/note.txt': 'textfilebody\n',
      'img/pixel.png': PNG,
      'docs/read.md': '---\naudience: all\n---\n# Read\n',
    },
    { stampAudience: false },
  );
  const raw = rawConfig(repo.url);
  raw.docs = { public_extensions: ['txt'] };
  const inst = await makeInstance({ raw });
  const text = await inst.core.get_file(inst.designer, 'docs/note.txt');
  assert.equal(text.kind, 'text');
  assert.match(text.text, /textfilebody/);
  await assert.rejects(() => inst.core.get_file(inst.designer, 'img/pixel.png'), (err) => err instanceof NotFound);
  await assert.rejects(() => inst.core.get_box(inst.designer, 'source', { dir: 'img' }), (err) => err instanceof NotFound);
  assert.equal((await inst.core.get_file(inst.owner, 'img/pixel.png')).kind, 'image');
  const docs = await inst.core.get_box(inst.designer, 'source', { dir: 'docs' });
  assert.deepEqual(docs.files.map((f) => f.name).sort(), ['note.txt', 'read.md']);
});

test('a text file is left out for a role without owner, and a listed image stays visible', async () => {
  await assert.rejects(() => app.core.get_file(app.designer, TXT), (err) => err instanceof NotFound);
  await assert.rejects(() => app.core.read_raw(app.designer, TXT), (err) => err instanceof NotFound);
  const text = await app.core.get_file(app.owner, TXT);
  assert.equal(text.kind, 'text');
  assert.match(text.text, new RegExp(PHRASE));
  assert.match((await app.core.read_raw(app.owner, TXT)).body.toString('utf8'), new RegExp(PHRASE));

  assert.equal((await app.core.get_file(app.designer, IMAGE)).kind, 'image');
  assert.equal((await app.core.get_file(app.owner, IMAGE)).kind, 'image');
  assert.equal((await app.core.read_raw(app.designer, IMAGE)).contentType, 'image/png');
  assert.equal((await app.core.read_raw(app.owner, IMAGE)).contentType, 'image/png');

  const designerRoot = await app.core.get_box(app.designer, 'source');
  assert.deepEqual(designerRoot.dirs.map((d) => d.path).sort(), ['docs', 'img']);
  await assert.rejects(() => app.core.get_box(app.designer, 'source', { dir: 'notes' }), (err) => err instanceof NotFound);
  const ownerNotes = await app.core.get_box(app.owner, 'source', { dir: 'notes' });
  assert.deepEqual(ownerNotes.files.map((f) => f.name), ['only.txt']);
  assert.deepEqual((await app.core.get_box(app.designer, 'source', { dir: 'img' })).files.map((f) => f.name), ['pixel.PNG']);
  assert.deepEqual((await app.core.get_box(app.owner, 'source', { dir: 'img' })).files.map((f) => f.name), ['pixel.PNG']);

  assert.equal((await app.core.search(app.designer, PHRASE)).results.length, 0);
  assert.deepEqual((await app.core.search(app.owner, PHRASE)).results.map((r) => r.path), [TXT]);

  const routes = [
    ['file?path=notes%2Fonly.txt', 'file?path=notes%2Fmissing.txt'],
    ['raw?path=notes%2Fonly.txt', 'raw?path=notes%2Fmissing.txt'],
    ['box?id=source&dir=notes', 'box?id=source&dir=missing'],
    ['api/get_box?id=source&dir=notes', 'api/get_box?id=source&dir=missing'],
  ];
  for (const [hiddenPath, missingPath] of routes) {
    const hidden = await designer.get(hiddenPath);
    const missing = await designer.get(missingPath);
    assert.equal(hidden.status, 404, hiddenPath);
    assert.equal(hidden.text, missing.text, hiddenPath);
    assert.equal(hidden.text.includes(PHRASE), false, hiddenPath);
    assert.equal(hidden.text.includes('only.txt'), false, hiddenPath);
  }

  const ownerFile = await owner.get('file?path=notes%2Fonly.txt');
  assert.equal(ownerFile.status, 200);
  assert.match(ownerFile.text, new RegExp(PHRASE));
  const ownerRaw = await owner.get('raw?path=notes%2Fonly.txt');
  assert.equal(ownerRaw.status, 200);
  assert.match(ownerRaw.text, new RegExp(PHRASE));

  for (const who of [owner, designer]) {
    const page = await who.get('file?path=img%2Fpixel.PNG');
    assert.equal(page.status, 200);
    assert.match(page.text, /pixel\.PNG/);
    const raw = await who.get('raw?path=img%2Fpixel.PNG');
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('content-type'), 'image/png');
    const listing = await who.get('box?id=source&dir=img');
    assert.equal(listing.status, 200);
    assert.match(listing.text, /pixel\.PNG/);
  }

  const designerTree = await designer.get('box?id=source');
  assert.equal(designerTree.status, 200);
  assert.equal(designerTree.text.includes('notes/'), false);
  assert.equal(designerTree.text.includes('only.txt'), false);
  const ownerTree = await owner.get('box?id=source&dir=notes');
  assert.equal(ownerTree.status, 200);
  assert.match(ownerTree.text, /only\.txt/);

  const designerSearch = await designer.get(`search?q=${PHRASE}`);
  assert.equal(designerSearch.status, 200);
  assert.equal(designerSearch.text.includes('only.txt'), false);
  assert.equal(designerSearch.text.includes('notes%2Fonly.txt'), false);
  const ownerSearch = await owner.get(`search?q=${PHRASE}`);
  assert.equal(ownerSearch.status, 200);
  assert.match(ownerSearch.text, /file\?path=notes%2Fonly\.txt/);
  assert.match(ownerSearch.text, /<ul class="bt-results">[\s\S]*plainnotealpha/);

  const designerApi = JSON.parse((await designer.get(`api/search?q=${PHRASE}`)).text);
  assert.deepEqual(designerApi.results, []);
  const ownerApi = JSON.parse((await owner.get(`api/search?q=${PHRASE}`)).text);
  assert.deepEqual(ownerApi.results.map((r) => r.path), [TXT]);

  const designerCookie = cookieHeader(designer.jar);
  const ownerCookie = cookieHeader(owner.jar);
  for (const p of ['file?path=notes%2Fonly.txt', 'raw?path=notes%2Fonly.txt']) {
    const hidden = await rawHead(app.base, p, designerCookie);
    const missing = await rawHead(app.base, p.replace('only.txt', 'missing.txt'), designerCookie);
    assert.equal(hidden.status, 404, p);
    assert.equal(hidden.status, missing.status, p);
    assert.equal(hidden.text.includes(PHRASE), false, p);
    const seen = await rawHead(app.base, p, ownerCookie);
    assert.equal(seen.status, 200, p);
  }
  for (const who of [designerCookie, ownerCookie]) {
    for (const p of ['file?path=img%2Fpixel.PNG', 'raw?path=img%2Fpixel.PNG']) {
      assert.equal((await rawHead(app.base, p, who)).status, 200, p);
    }
  }

  const cliDenied = cli('designer', 'search', `q=${PHRASE}`);
  assert.equal(cliDenied.status, 0, cliDenied.stderr);
  assert.deepEqual(JSON.parse(cliDenied.stdout).results, []);
  const cliFound = cli('owner', 'search', `q=${PHRASE}`);
  assert.equal(cliFound.status, 0, cliFound.stderr);
  assert.deepEqual(JSON.parse(cliFound.stdout).results.map((r) => r.path), [TXT]);

  const cliDir = cli('designer', 'get_box', 'id=source', 'dir=notes');
  assert.notEqual(cliDir.status, 0);
  assert.equal(cliDir.stdout.includes('only.txt'), false);
  assert.equal(cliDir.stdout.includes(PHRASE), false);
  const cliNotes = JSON.parse(cli('owner', 'get_box', 'id=source', 'dir=notes').stdout);
  assert.deepEqual(cliNotes.files.map((f) => f.name), ['only.txt']);
  const cliImage = JSON.parse(cli('designer', 'get_box', 'id=source', 'dir=img').stdout);
  assert.deepEqual(cliImage.files.map((f) => f.name), ['pixel.PNG']);
  const cliOwnerImage = JSON.parse(cli('owner', 'get_box', 'id=source', 'dir=img').stdout);
  assert.deepEqual(cliOwnerImage.files.map((f) => f.name), ['pixel.PNG']);
});
