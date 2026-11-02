import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeInstance } from './helpers.js';

let I;
before(async () => {
  I = await makeInstance();
});

test('mirror lists files from the configured branch', async () => {
  const files = (await I.mirror.files()).map((f) => f.path);
  assert.ok(files.includes('docs/guide.md'));
  assert.equal(I.mirror.commitInfo.short.length, 7);
});

test('list_boxes returns the configured boxes', () => {
  const boxes = I.core.list_boxes(I.owner);
  assert.deepEqual(boxes.map((b) => b.id), ['digest', 'decisions', 'now', 'design', 'docs', 'questions', 'issues', 'source']);
  assert.ok(boxes.every((b) => b.nav === 'primary' && b.order === null));
});

test('digest shows the newest file rendered and older ones listed', async () => {
  const d = await I.core.get_box(I.owner, 'digest');
  assert.equal(d.entries[0].path, 'digest/2026-01-02.md');
  assert.match(d.entries[0].html, /Fresh news/);
  assert.equal(d.entries[1].html, undefined);
});

test('decisions are listed by date with front matter and inline fields, README skipped', async () => {
  const d = await I.core.get_box(I.owner, 'decisions');
  assert.deepEqual(d.entries.map((e) => [e.title, e.date, e.status]), [
    ['Second decision', '2026-01-05', 'proposed'],
    ['Use a mirror', '2026-01-01', 'accepted'],
  ]);
  assert.equal(d.fallback, undefined);
});

test('documents box with sections shows the latest matching sections, newest first', async () => {
  const d = await I.core.get_box(I.owner, 'now');
  assert.deepEqual(d.sections.map((s) => s.heading), ['Status 2026-01-03', 'Status 2026-01-02']);
});

test('gallery groups by date folder and filename pattern', async () => {
  const top = await I.core.get_box(I.owner, 'design');
  assert.deepEqual(top.folders.map((f) => f.folder), ['2026-01-02', '2026-01-01']);
  const day = await I.core.get_box(I.owner, 'design', { folder: '2026-01-02' });
  assert.deepEqual(day.groups.map((g) => g.key), ['home', 'settings']);
  assert.deepEqual(day.filters.width, ['390', '1440']);
  assert.match(day.notes.html, /Top fixes/);
  const filtered = await I.core.get_box(I.owner, 'design', { folder: '2026-01-02', variant: 'dark' });
  assert.deepEqual(filtered.groups.flatMap((g) => g.items.map((i) => i.name)), ['dark-home-390.png']);
});

test('source browser navigates folders and honours exclude', async () => {
  const root = await I.core.get_box(I.owner, 'source');
  assert.ok(root.dirs.some((d) => d.path === 'docs'));
  assert.ok(!root.dirs.some((d) => d.path === 'secret'));
  const src = await I.core.get_box(I.owner, 'source', { dir: 'src' });
  assert.deepEqual(src.files.map((f) => f.name), ['app.js', 'bin.dat']);
  await assert.rejects(() => I.core.get_file(I.owner, 'secret/.env'), /secret/);
  await assert.rejects(() => I.core.get_box(I.owner, 'source', { dir: '../etc' }));
});

test('documents render safely: raw HTML escaped, javascript: links dropped, relative links rewritten', async () => {
  const doc = await I.core.get_document(I.owner, 'docs/guide.md');
  assert.ok(!doc.html.includes('<script>'));
  assert.match(doc.html, /&lt;script&gt;/);
  assert.ok(!/href="javascript:/i.test(doc.html));
  assert.match(doc.html, /href="https:\/\/example.com" rel="noopener noreferrer"/);
  assert.match(doc.html, /href="doc\?path=decisions%2F0001-first.md#why"/);
  assert.match(doc.html, /<img src="raw\?path=shots%2F2026-01-02%2Fhome-390.png"/);
  assert.deepEqual(doc.toc.map((h) => h.slug), ['guide', 'install', 'usage']);
  const readme = await I.core.get_document(I.owner, 'README.md');
  assert.match(readme.html, /bt-deadlink">missing/);
});

test('paths outside every box, traversal and unknown files are not reachable', async () => {
  for (const p of ['../x', '/etc/passwd', 'nope.md', 'secret/.env', '']) {
    await assert.rejects(() => I.core.get_document(I.owner, p));
    await assert.rejects(() => I.core.read_raw(I.owner, p));
  }
});

test('issues box excludes pull requests and closed issues', async () => {
  const d = await I.core.get_box(I.owner, 'issues');
  assert.deepEqual(d.issues.map((i) => i.number), [1, 2, 3, 4, 5]);
  assert.ok(!d.issues[0].bodyHtml.includes('<img'));
});

test('open questions come from the configured label', async () => {
  const d = await I.core.get_box(I.owner, 'questions');
  assert.deepEqual(d.issues.map((i) => i.number), [3]);
});

test('designer role: security issues hidden by label, label glob and title pattern', async () => {
  const d = await I.core.get_box(I.designer, 'issues');
  assert.deepEqual(d.issues.map((i) => i.number), [1, 3]);
  const s = await I.core.search(I.designer, 'header');
  assert.deepEqual(s.results.filter((r) => r.kind === 'issue').map((r) => r.number), [3]);
  const so = await I.core.search(I.owner, 'header');
  assert.deepEqual(so.results.filter((r) => r.kind === 'issue').map((r) => r.number).sort(), [2, 3]);
});

test('designer role: hidden paths disappear from lists, documents and search', async () => {
  const docs = await I.core.get_box(I.designer, 'docs');
  assert.ok(!docs.documents.some((d) => d.path === 'docs/secret-ops.md'));
  await assert.rejects(() => I.core.get_document(I.designer, 'docs/secret-ops.md'));
  assert.ok((await I.core.get_document(I.owner, 'docs/secret-ops.md')).html.includes('runbook'));
  const s = await I.core.search(I.designer, 'runbook');
  assert.equal(s.results.length, 0);
  assert.deepEqual(I.core.status(I.designer).policy, { auto_accept_eligible: ['ui'], route_other_to: 'owner' });
});

test('search finds documents with snippets', async () => {
  const s = await I.core.search(I.owner, 'fresh news');
  assert.equal(s.results[0].path, 'digest/2026-01-02.md');
  assert.match(s.results[0].snippet, /Fresh news/);
  assert.equal((await I.core.search(I.owner, 'x')).results.length, 0);
});

test('mirror picks up new commits on the next sync', async () => {
  I.src.commit('digest/2026-01-03.md', '# Digest 3 Jan\n');
  const before = I.mirror.commit;
  await I.mirror.sync();
  assert.notEqual(I.mirror.commit, before);
  const d = await I.core.get_box(I.owner, 'digest');
  assert.equal(d.entries[0].path, 'digest/2026-01-03.md');
});
