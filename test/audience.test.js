import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, client, PW, makeSourceRepo } from './helpers.js';
import { validateConfig } from '../src/config.js';
import { NotFound } from '../src/core.js';

function rawConfig(url) {
  return {
    instance: { id: 'sample', title: 'Sample', locale: ['en'] },
    source: { type: 'git-mirror', url, branch: 'main', refresh: '10m' },
    boxes: [
      { id: 'docs', type: 'documents', title: 'Docs', paths: ['docs/*.md'] },
      { id: 'source', type: 'source-browser', include: ['**/*'] },
    ],
    roles: {
      owner: {},
      designer: { audiences: ['all', 'team'] },
    },
  };
}

const DOCS = {
  'docs/public.md': '---\naudience: all\n---\n# Public\n\nHello from the public note.\n',
  'docs/plain.md': '# Plain\n\nThis file has no audience field.\n',
  'docs/blank.md': '---\naudience:\n---\n# Blank\n\nEmpty audience.\n',
  'docs/spaced.md': '---\naudience: "   "\n---\n# Spaced\n\nBlank audience.\n',
  'docs/other.md': '---\naudience: team\n---\n# Other\n\nTeam note body.\n',
  'docs/unknown.md': '---\naudience: nope\n---\n# Unknown\n\nNope body.\n',
  'docs/list.md': '---\naudience:\n  - all\n---\n# List\n\nList body.\n',
  'docs/.hidden.md': '---\naudience: all\n---\n# Dot\n\nDot body.\n',
  'src/app.js': 'console.log("ok");\n',
};

let app, owner, designer;

before(async () => {
  const src = makeSourceRepo(DOCS, { stampAudience: false });
  app = await makeApp({ raw: rawConfig(src.url) });
  owner = client(app.base);
  designer = client(app.base);
  assert.equal((await owner.login('owner', PW.owner)).status, 303);
  assert.equal((await designer.login('designer', PW.designer)).status, 303);
});

after(() => app?.close());

test('audiences default to all and hide_paths default to an empty list', () => {
  const raw = rawConfig('file:///tmp/repo');
  const config = validateConfig(raw);
  assert.deepEqual(config.audiences, ['all']);
  assert.deepEqual(config.roles.owner.audiences, ['all']);
  assert.deepEqual(config.roles.designer.audiences, ['all', 'team']);
  assert.deepEqual(config.docs.hidePaths, []);

  raw.audiences = ['all', 'team'];
  raw.roles.owner.audiences = ['team'];
  raw.docs = { hide_paths: ['/drafts/', 'notes'] };
  const next = validateConfig(raw);
  assert.deepEqual(next.audiences, ['all', 'team']);
  assert.deepEqual(next.roles.owner.audiences, ['team']);
  assert.deepEqual(next.roles.designer.audiences, ['all', 'team']);
  assert.deepEqual(next.docs.hidePaths, ['drafts', 'notes']);

  const badPrefix = rawConfig('file:///tmp/repo');
  badPrefix.docs = { hide_paths: ['../out'] };
  assert.throws(() => validateConfig(badPrefix), /hide_paths/);
  const badWord = rawConfig('file:///tmp/repo');
  badWord.audiences = [' '];
  assert.throws(() => validateConfig(badWord), /audiences/);
});

test('a document with no audience is denied the same way as a missing document', async () => {
  for (const p of ['docs/plain.md', 'docs/blank.md', 'docs/spaced.md', 'docs/list.md']) {
    await assert.rejects(() => app.core.get_document(app.owner, p), (err) => err instanceof NotFound);
    await assert.rejects(() => app.core.get_file(app.owner, p), (err) => err instanceof NotFound);
    await assert.rejects(() => app.core.read_raw(app.owner, p), (err) => err instanceof NotFound);
  }

  const missing = await owner.get('doc?path=docs%2Fno-such.md');
  const plain = await owner.get('doc?path=docs%2Fplain.md');
  assert.equal(missing.status, 404);
  assert.equal(plain.status, 404);
  assert.equal(plain.text, missing.text);
  assert.equal(plain.text.includes('no audience field'), false);

  const apiMissing = await owner.get('api/get_document?path=docs%2Fno-such.md');
  const apiPlain = await owner.get('api/get_document?path=docs%2Fplain.md');
  assert.equal(apiPlain.status, 404);
  assert.equal(apiPlain.text, apiMissing.text);

  assert.equal((await owner.get('file?path=docs%2Fplain.md')).status, 404);
  assert.equal((await owner.get('file?path=docs%2Fblank.md')).status, 404);
  assert.equal((await owner.get('raw?path=docs%2Fplain.md')).status, 404);
  assert.equal((await owner.get('raw?path=docs%2Flist.md')).status, 404);
});

test('an audience other than all is denied for the default list', async () => {
  await assert.rejects(() => app.core.get_document(app.owner, 'docs/other.md'), (err) => err instanceof NotFound);
  await assert.rejects(() => app.core.get_document(app.owner, 'docs/unknown.md'), (err) => err instanceof NotFound);
  await assert.rejects(() => app.core.read_raw(app.owner, 'docs/other.md'), (err) => err instanceof NotFound);
  assert.equal((await owner.get('doc?path=docs%2Fother.md')).status, 404);
  assert.equal((await owner.get('api/get_document?path=docs%2Funknown.md')).status, 404);
  assert.equal((await owner.get('raw?path=docs%2Fother.md')).status, 404);
});

test('audience all is allowed', async () => {
  const doc = await app.core.get_document(app.owner, 'docs/public.md');
  assert.match(doc.html, /Hello from the public note/);
  const page = await owner.get('doc?path=docs%2Fpublic.md');
  assert.equal(page.status, 200);
  assert.match(page.text, /Hello from the public note/);
  const api = JSON.parse((await owner.get('api/get_document?path=docs%2Fpublic.md')).text);
  assert.equal(api.path, 'docs/public.md');
  assert.match(api.html, /Hello from the public note/);
  assert.equal((await owner.get('file?path=docs%2Fpublic.md')).status, 200);
  const raw = await owner.get('raw?path=docs%2Fpublic.md');
  assert.equal(raw.status, 200);
  assert.match(raw.text, /Hello from the public note/);
  await assert.rejects(() => app.core.get_file(app.owner, 'src/app.js'), (err) => err instanceof NotFound);
});

test('a role audience list allows that value for the signed-in user', async () => {
  await assert.rejects(() => app.core.get_document(app.owner, 'docs/other.md'), (err) => err instanceof NotFound);
  const doc = await app.core.get_document(app.designer, 'docs/other.md');
  assert.match(doc.html, /Team note body/);
  assert.equal((await owner.get('doc?path=docs%2Fother.md')).status, 404);
  const page = await designer.get('doc?path=docs%2Fother.md');
  assert.equal(page.status, 200);
  assert.match(page.text, /Team note body/);
  assert.match((await app.core.get_document(app.designer, 'docs/public.md')).html, /Hello from the public note/);
  await assert.rejects(() => app.core.get_document(app.designer, 'docs/plain.md'), (err) => err instanceof NotFound);
  await assert.rejects(() => app.core.get_document(app.designer, 'docs/unknown.md'), (err) => err instanceof NotFound);
});

test('the document index omits denied documents', async () => {
  const ownerDocs = (await app.core.get_box(app.owner, 'docs')).documents.map((d) => d.path);
  assert.deepEqual(ownerDocs, ['docs/public.md']);
  const designerDocs = (await app.core.get_box(app.designer, 'docs')).documents.map((d) => d.path).sort();
  assert.deepEqual(designerDocs, ['docs/other.md', 'docs/public.md']);

  const page = await owner.get('box?id=docs');
  assert.equal(page.status, 200);
  assert.match(page.text, /docs\/public\.md/);
  for (const name of ['plain.md', 'blank.md', 'spaced.md', 'other.md', 'unknown.md', 'list.md', '.hidden.md']) {
    assert.equal(page.text.includes(name), false, name);
  }

  const tree = await app.core.get_box(app.owner, 'source', { dir: 'docs' });
  assert.deepEqual(tree.files.map((f) => f.name), ['public.md']);

  assert.equal((await app.core.search(app.owner, 'no audience field')).results.length, 0);
  const found = await app.core.search(app.designer, 'Team note');
  assert.deepEqual(found.results.map((r) => r.path), ['docs/other.md']);
});
