import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { makeApp, client, PW, sampleRawConfig } from './helpers.js';
import { routeFor } from '../src/inbox.js';

let A, owner, designer;
before(async () => {
  A = await makeApp();
  owner = client(A.base);
  designer = client(A.base);
  await owner.login('owner', PW.owner);
  await designer.login('designer', PW.designer);
});
after(() => A.close());

const idFrom = (r) => Number(/id=(\d+)/.exec(r.headers.get('location'))[1]);

test('workshop CRUD with history', async () => {
  const csrf = await designer.csrf('workshop');
  const r = await designer.post('workshop-save', { csrf, kind: 'idea', title: 'Softer cards', body: 'Use **rounder** corners <script>x</script>' });
  assert.equal(r.status, 303);
  const id = idFrom(r);
  const page = await designer.get(`workshop-item?id=${id}`);
  assert.match(page.text, /<strong>rounder<\/strong>/);
  assert.ok(!page.text.includes('<script>x'));
  assert.equal((await designer.post('workshop-save', { csrf, id, version: 1, kind: 'idea', title: 'Softer cards v2', body: 'More' })).status, 303);
  // A stale version is refused instead of silently overwriting.
  const stale = await designer.post('workshop-save', { csrf, id, version: 1, kind: 'idea', title: 'Old tab', body: 'x' });
  assert.equal(stale.status, 400);
  assert.match(stale.text, /changed since you opened it/);
  const hist = A.state.workshop.history('designer', id);
  assert.deepEqual(hist.map((h) => h.title), ['Softer cards']);
  assert.equal(A.state.workshop.get('designer', id).title, 'Softer cards v2');
  assert.equal((await designer.post('workshop-delete', { csrf, id })).status, 303);
  assert.equal((await designer.get(`workshop-item?id=${id}`)).status, 404);
});

test('workshop validation', async () => {
  const csrf = await designer.csrf('workshop');
  assert.equal((await designer.post('workshop-save', { csrf, title: '' })).status, 400);
  assert.equal((await designer.post('workshop-save', { csrf, title: 'x'.repeat(201) })).status, 400);
});

test('workshop items are private to each user', async () => {
  const dc = await designer.csrf('workshop');
  const id = idFrom(await designer.post('workshop-save', { csrf: dc, kind: 'note', title: 'Designer private note', body: 'mine' }));
  const oc = await owner.csrf('workshop');
  assert.ok(!(await owner.get('workshop')).text.includes('Designer private note'));
  assert.equal((await owner.get(`workshop-item?id=${id}`)).status, 404);
  assert.equal((await owner.post('workshop-save', { csrf: oc, id, version: 1, title: 'hijack', body: '' })).status, 404);
  assert.equal((await owner.post('workshop-delete', { csrf: oc, id })).status, 404);
  assert.equal(A.state.workshop.get('designer', id).title, 'Designer private note');
  assert.throws(() => A.state.workshop.get('owner', id));
  // Owner cannot attach someone else's workshop item to an inbox submission either.
  const r = await owner.post('inbox-submit', { csrf: oc, kind: 'idea', title: 'x', body: '', workshop_item_id: id });
  assert.equal(r.status, 400);
});

test('routing follows the role policy', () => {
  const policy = { auto_accept_eligible: ['ui'], route_other_to: 'owner' };
  assert.deepEqual(routeFor(policy, 'ui', 'L'), { route: 'auto-accept-eligible', target: null, label: null });
  assert.deepEqual(routeFor(policy, 'bug', 'L'), { route: 'owner-decision', target: 'owner', label: 'L' });
  assert.deepEqual(routeFor({}, 'ui', 'L'), { route: 'standard', target: null, label: null });
});

test('inbox submission, visibility, question-back and agent updates', async () => {
  const csrf = await designer.csrf('inbox');
  const ui = idFrom(await designer.post('inbox-submit', { csrf, kind: 'ui', title: 'Bigger tap targets', body: 'Buttons are small', ref: 'box:design' }));
  const q = idFrom(await designer.post('inbox-submit', { csrf, kind: 'question', title: 'Can we add a dark mode?', body: '' }));
  const oc = await owner.csrf('inbox');
  const own = idFrom(await owner.post('inbox-submit', { csrf: oc, kind: 'bug', title: 'Owner bug', body: '' }));

  const s = A.state.inbox;
  assert.equal(s.show(ui).route, 'auto-accept-eligible');
  assert.equal(s.show(q).route, 'owner-decision');
  assert.equal(s.show(q).routeLabel, 'needs-owner-decision');
  assert.equal(s.show(own).route, 'standard');
  assert.equal(s.show(ui).ref, 'box:design');

  // Users only see their own submissions.
  const dlist = (await designer.get('inbox')).text;
  assert.match(dlist, /Bigger tap targets/);
  assert.ok(!dlist.includes('Owner bug'));
  assert.equal((await designer.get(`inbox-item?id=${own}`)).status, 404);
  assert.equal((await owner.get(`inbox-item?id=${ui}`)).status, 404);

  // The agent asks a question back; the designer answers; the item returns to "new".
  assert.throws(() => s.update(q, { status: 'question-back' }), /needs --reply/);
  s.update(q, { status: 'question-back', reply: 'For which screens?' });
  let page = await designer.get(`inbox-item?id=${q}`);
  assert.match(page.text, /For which screens\?/);
  assert.match(page.text, /action="inbox-reply"/);
  assert.equal((await owner.post('inbox-reply', { csrf: oc, id: q, body: 'not mine' })).status, 404);
  assert.equal((await designer.post('inbox-reply', { csrf, id: q, body: 'All of them' })).status, 303);
  assert.equal(s.show(q).status, 'new');
  assert.equal((await designer.post('inbox-reply', { csrf, id: q, body: 'again' })).status, 400);

  // Issue created: needs an https URL, which the user then sees.
  assert.throws(() => s.update(ui, { status: 'issue-created' }), /needs --issue-url/);
  assert.throws(() => s.update(ui, { status: 'issue-created', issueUrl: 'javascript:alert(1)' }), /https/);
  assert.throws(() => s.update(ui, { status: 'bogus' }), /status must be/);
  s.update(ui, { status: 'issue-created', issueUrl: 'https://example.com/i/99', note: 'adopted as UI tweak' });
  page = await designer.get(`inbox-item?id=${ui}`);
  assert.match(page.text, /href="https:\/\/example.com\/i\/99"/);
  assert.ok(!page.text.includes('adopted as UI tweak'), 'internal agent notes are not shown to users');
  const ev = s.show(ui).events.map((e) => `${e.from}->${e.to}`);
  assert.deepEqual(ev, ['null->new', 'new->issue-created']);
});

test('inbox references must be visible to the submitting user', async () => {
  const csrf = await designer.csrf('inbox');
  for (const ref of ['doc:docs/secret-ops.md', 'box:nope', 'doc:../x', 'http://x']) {
    assert.equal((await designer.post('inbox-submit', { csrf, kind: 'idea', title: 'x', body: '', ref })).status, 400, ref);
  }
  assert.equal((await designer.post('inbox-submit', { csrf, kind: 'idea', title: 'x', body: '', ref: 'doc:docs/guide.md' })).status, 303);
  assert.equal((await designer.post('inbox-submit', { csrf, kind: 'nonsense', title: 'x', body: '' })).status, 400);
  const prefill = await designer.get('inbox?ref=doc%3Adocs%2Fguide.md');
  assert.match(prefill.text, /value="doc:docs\/guide.md" selected/);
  const hidden = await designer.get('inbox?ref=doc%3Adocs%2Fsecret-ops.md');
  assert.ok(!hidden.text.includes('secret-ops'));
});

test('the inbox CLI lists, shows and updates without touching the network', () => {
  const bin = fileURLToPath(new URL('../bin/bteam.js', import.meta.url));
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-cfg-')), 'instance.yaml');
  fs.writeFileSync(cfg, stringify(sampleRawConfig(A.src.url)));
  // Same database: the CLI uses <data>/<instance id>.sqlite.
  const run = (...args) => execFileSync(process.execPath, [bin, ...args, '--config', cfg, '--data', A.data], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const list = JSON.parse(run('inbox', 'list', '--status', 'new', '--json'));
  assert.ok(list.length >= 1);
  const id = String(list[0].id);
  assert.equal(JSON.parse(run('inbox', 'show', id)).id, Number(id));
  const out = JSON.parse(run('inbox', 'update', id, '--status', 'digest', '--note', 'in tonight\'s digest'));
  assert.equal(out.status, 'digest');
  assert.ok(!run('user', 'list').includes('argon2'));
});
