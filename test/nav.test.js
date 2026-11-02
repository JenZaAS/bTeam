import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, makeSourceRepo, client, PW, sampleRawConfig } from './helpers.js';
import { sortNavBoxes, splitNavBoxes, advancedView, homeView, layout } from '../src/views.js';
import { strings } from '../src/i18n.js';

const t = strings('en');
const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

function block(html, open, close) {
  const i = html.indexOf(open);
  assert.ok(i >= 0, open);
  const j = html.indexOf(close, i + open.length);
  assert.ok(j > i, close);
  return html.slice(i, j + close.length);
}

function currentHrefs(navHtml) {
  return [...navHtml.matchAll(/<a\b[^>]*>/g)]
    .filter((m) => m[0].includes('aria-current="page"'))
    .map((m) => /href="([^"]*)"/.exec(m[0])[1]);
}

test('sortNavBoxes orders numbers before unset and does not mutate the input', () => {
  const input = [
    { id: 'a', order: 20 },
    { id: 'b', order: 10 },
    { id: 'c', order: null },
  ];
  const snapshot = input.map((b) => ({ ...b }));
  assert.deepEqual(sortNavBoxes(input).map((b) => b.id), ['b', 'a', 'c']);
  assert.deepEqual(input, snapshot);
});

test('equal orders keep input order', () => {
  const tied = [
    { id: 'a', order: 5 },
    { id: 'b', order: 5 },
  ];
  assert.deepEqual(sortNavBoxes(tied).map((b) => b.id), ['a', 'b']);
  const ranks = [
    { id: 'n', order: -1 },
    { id: 'z', order: 0 },
    { id: 'p', order: 2 },
    { id: 'u', order: null },
  ];
  assert.deepEqual(sortNavBoxes(ranks).map((b) => b.id), ['n', 'z', 'p', 'u']);
});

test('splitNavBoxes keeps relative order and treats a missing nav as primary', () => {
  const boxes = [
    { id: 'p1', nav: 'primary' },
    { id: 'a1', nav: 'advanced' },
    { id: 'miss' },
    { id: 'a2', nav: 'advanced' },
  ];
  const { primary, advanced } = splitNavBoxes(boxes);
  assert.deepEqual(primary.map((b) => b.id), ['p1', 'miss']);
  assert.deepEqual(advanced.map((b) => b.id), ['a1', 'a2']);
});

test('sort then split keeps each group in order', () => {
  const boxes = [
    { id: 'p30', nav: 'primary', order: 30 },
    { id: 'a20', nav: 'advanced', order: 20 },
    { id: 'p10', nav: 'primary', order: 10 },
    { id: 'a-null', nav: 'advanced', order: null },
    { id: 'p-null', nav: 'primary', order: null },
    { id: 'a10', nav: 'advanced', order: 10 },
  ];
  const { primary, advanced } = splitNavBoxes(sortNavBoxes(boxes));
  assert.deepEqual(primary.map((b) => b.id), ['p10', 'p30', 'p-null']);
  assert.deepEqual(advanced.map((b) => b.id), ['a10', 'a20', 'a-null']);
});

test('advancedView renders the mirror commit line', () => {
  const html = advancedView({
    t,
    locale: 'en',
    advancedBoxes: [],
    status: { source: { commit: { short: 'abc1234', date: '2026-01-02T03:04:05.000Z' }, lastSync: '2026-01-02T03:05:06.000Z' } },
  });
  assert.ok(html.includes('Source: <code>abc1234</code> (2026-01-02 03:04) · synced 2026-01-02 03:05 UTC'));
  const noSync = advancedView({
    t,
    locale: 'en',
    advancedBoxes: [],
    status: { source: { commit: { short: 'abc1234', date: '2026-01-02T03:04:05.000Z' }, lastSync: null } },
  });
  assert.ok(noSync.includes('<code>abc1234</code>'));
  assert.ok(noSync.includes('2026-01-02 03:04'));
  assert.ok(!noSync.includes('synced'));
  const unsynced = advancedView({
    t,
    locale: 'en',
    advancedBoxes: [],
    status: { source: { commit: null, lastSync: '2026-01-02T03:05:06.000Z' } },
  });
  assert.ok(unsynced.includes('The source has not been mirrored yet.'));
  assert.ok(!unsynced.includes('synced'));
  assert.ok(!unsynced.includes('03:05'));
});

test('advancedView hides source and issue errors and an empty list', () => {
  const html = advancedView({
    t,
    locale: 'en',
    advancedBoxes: [],
    status: {
      source: { commit: { short: 'abc1234', date: '2026-01-02T03:04:05.000Z' }, lastSync: null, error: 'SOURCE-ERR-XYZ' },
      issues: { error: 'ISSUES-ERR-XYZ', lastSync: '2026-01-02T09:09:09.000Z' },
    },
  });
  assert.ok(!html.includes('SOURCE-ERR-XYZ'));
  assert.ok(!html.includes('ISSUES-ERR-XYZ'));
  assert.ok(!html.includes('<ul'));
  assert.ok(!html.includes('Nothing here yet.'));
});

test('homeView shows a source error on the card page', () => {
  const html = homeView({
    t,
    locale: 'en',
    primaryBoxes: [],
    status: { source: { error: 'SOURCE-ERR-XYZ' }, links: [] },
  });
  assert.match(html, /<p class="bt-warn">SOURCE-ERR-XYZ<\/p>/);
});

test('layout omits the nav when logged out and lists only primary boxes plus More', () => {
  const status = { instance: { title: 'Sample' }, source: {} };
  const loggedOut = layout({
    t,
    locale: 'en',
    status,
    primaryBoxes: [{ id: 'digest', title: 'Digest' }],
    title: 'Sign in',
    body: '<p>hi</p>',
    user: null,
  });
  assert.ok(!loggedOut.includes('<nav'));
  assert.ok(!loggedOut.includes('href="advanced"'));
  const signedIn = layout({
    t,
    locale: 'en',
    status,
    primaryBoxes: [
      { id: 'decisions', title: 'Decisions' },
      { id: 'digest', title: 'Digest' },
    ],
    title: '',
    body: '',
    user: { id: 'owner', role: 'owner', csrf: 'tok', dev: true, workshop: false, inbox: false },
  });
  const nav = block(signedIn, '<nav', '</nav>');
  assert.match(nav, /aria-label="Main navigation"/);
  assert.ok(!nav.includes('aria-label="Overview"'));
  assert.match(nav, />Overview</);
  assert.deepEqual(hrefs(nav), ['./', 'box?id=decisions', 'box?id=digest', 'advanced']);
  const nb = layout({
    t: strings('nb'),
    locale: 'nb',
    status,
    primaryBoxes: [{ id: 'digest', title: 'Digest' }],
    title: '',
    body: '',
    user: { id: 'owner', role: 'owner', csrf: 'tok', dev: true, workshop: false, inbox: false },
  });
  const navNb = block(nb, '<nav', '</nav>');
  assert.match(navNb, /aria-label="Hovednavigasjon"/);
  assert.match(navNb, />Oversikt</);
  assert.ok(!navNb.includes('aria-label="Oversikt"'));
});

function withNav(url, hide) {
  const raw = sampleRawConfig(url);
  const box = Object.fromEntries(raw.boxes.map((b) => [b.id, b]));
  box.digest.order = 20;
  box.decisions.order = 10;
  box.now.nav = 'advanced';
  box.now.order = 30;
  box.docs.nav = 'advanced';
  box.docs.order = 20;
  box.issues.nav = 'advanced';
  box.issues.order = 10;
  box.issues.visible_to = ['owner'];
  box.source.nav = 'advanced';
  raw.roles.designer.hide.boxes = hide;
  return raw;
}

const PRIMARY = ['decisions', 'digest', 'design', 'questions'];
const OWNER_ADVANCED = ['issues', 'docs', 'now', 'source'];

let A, B, owner, designer, ownerB, designerB;
before(async () => {
  const src = makeSourceRepo();
  A = await makeApp({ raw: withNav(src.url, ['source']) });
  B = await makeApp({ raw: withNav(src.url, ['now', 'docs', 'issues', 'source']) });
  owner = client(A.base);
  designer = client(A.base);
  ownerB = client(B.base);
  designerB = client(B.base);
  assert.equal((await owner.login('owner', PW.owner)).status, 303);
  assert.equal((await designer.login('designer', PW.designer)).status, 303);
  assert.equal((await ownerB.login('owner', PW.owner)).status, 303);
  assert.equal((await designerB.login('designer', PW.designer)).status, 303);
});
after(() => {
  A?.close();
  B?.close();
});

test('owner nav and home cards follow primary order; advanced page follows advanced order', async () => {
  const home = await owner.get('');
  const nav = block(home.text, '<nav', '</nav>');
  const cards = block(home.text, '<ul class="bt-cards">', '</ul>');
  assert.deepEqual(hrefs(nav), ['./', ...PRIMARY.map((id) => `box?id=${id}`), 'workshop', 'inbox', 'advanced']);
  assert.deepEqual(hrefs(cards), PRIMARY.map((id) => `box?id=${id}`));
  const advanced = await owner.get('advanced');
  assert.equal(advanced.status, 200);
  const main = block(advanced.text, '<main', '</main>');
  assert.deepEqual(
    hrefs(main).filter((h) => h.startsWith('box?id=')),
    OWNER_ADVANCED.map((id) => `box?id=${id}`),
  );
  assert.match(main, /<a class="bt-advanced-link" href="box\?id=issues">/);
});

test('a hidden advanced box is absent for that role and still open for the owner', async () => {
  const advanced = await designer.get('advanced');
  const main = block(advanced.text, '<main', '</main>');
  assert.deepEqual(
    hrefs(main).filter((h) => h.startsWith('box?id=')),
    ['box?id=docs', 'box?id=now'],
  );
  assert.equal((await designer.get('box?id=source')).status, 404);
  assert.equal((await designer.get('box?id=issues')).status, 404);
  assert.equal((await owner.get('box?id=source')).status, 200);
  assert.equal((await owner.get('box?id=issues')).status, 200);
  const ownerList = JSON.parse((await owner.get('api/list_boxes')).text);
  assert.deepEqual(
    ownerList.map((b) => [b.id, b.nav, b.order]),
    [
      ['digest', 'primary', 20],
      ['decisions', 'primary', 10],
      ['now', 'advanced', 30],
      ['design', 'primary', null],
      ['docs', 'advanced', 20],
      ['questions', 'primary', null],
      ['issues', 'advanced', 10],
      ['source', 'advanced', null],
    ],
  );
  const designerList = JSON.parse((await designer.get('api/list_boxes')).text);
  assert.deepEqual(designerList.map((b) => b.id), ['digest', 'decisions', 'now', 'design', 'docs', 'questions']);
  assert.equal((await designer.get('api/get_box?id=source')).status, 404);
});

test('get_box includes nav and order on the nested box', async () => {
  const digest = JSON.parse((await owner.get('api/get_box?id=digest')).text);
  assert.equal(digest.box.nav, 'primary');
  assert.equal(digest.box.order, 20);
  const now = JSON.parse((await owner.get('api/get_box?id=now')).text);
  assert.equal(now.box.nav, 'advanced');
  assert.equal(now.box.order, 30);
  const source = JSON.parse((await owner.get('api/get_box?id=source')).text);
  assert.equal(source.box.nav, 'advanced');
  assert.equal(source.box.order, null);
});

test('search still finds content in an advanced box', async () => {
  const api = JSON.parse((await owner.get('api/search?q=Install')).text);
  assert.ok(api.results.some((r) => r.path === 'docs/guide.md' && r.box === 'docs'));
  const page = await designer.get('search?q=Install');
  assert.equal(page.status, 200);
  assert.match(page.text, /doc\?path=docs%2Fguide\.md/);
});

test('aria-current follows Overview, the open box, or More', async () => {
  const now = block((await owner.get('box?id=now')).text, '<nav', '</nav>');
  assert.deepEqual(currentHrefs(now), ['advanced']);
  const decisions = block((await owner.get('box?id=decisions')).text, '<nav', '</nav>');
  assert.deepEqual(currentHrefs(decisions), ['box?id=decisions']);
  const advanced = block((await owner.get('advanced')).text, '<nav', '</nav>');
  assert.deepEqual(currentHrefs(advanced), ['advanced']);
  const home = block((await owner.get('')).text, '<nav', '</nav>');
  assert.deepEqual(currentHrefs(home), ['./']);
  const doc = block((await owner.get('doc?path=docs%2Fguide.md')).text, '<nav', '</nav>');
  assert.deepEqual(currentHrefs(doc), ['advanced']);
});

test('a shared path highlights the primary box; an advanced-only path highlights More', async () => {
  // PLAN.md is in primary decisions and in advanced now, and source includes every file.
  const shared = block((await owner.get('doc?path=PLAN.md')).text, '<nav', '</nav>');
  assert.deepEqual(currentHrefs(shared), ['box?id=decisions']);
  // docs/guide.md is only in advanced boxes (docs, and source).
  const onlyAdvanced = block((await owner.get('doc?path=docs%2Fguide.md')).text, '<nav', '</nav>');
  assert.deepEqual(currentHrefs(onlyAdvanced), ['advanced']);
});

test('advanced page uses the Norwegian strings', async () => {
  const html = (await owner.get('advanced?lang=nb')).text;
  assert.match(html, /<h1>Avansert<\/h1>/);
  assert.match(html, /href="advanced">Mer</);
  assert.match(html, /<nav class="bt-nav" aria-label="Hovednavigasjon">/);
  assert.match(html, />Oversikt</);
});

test('signed-in POST /advanced is a 404 and login next=advanced lands there', async () => {
  const csrf = await owner.csrf('advanced');
  assert.equal((await owner.post('advanced', { csrf })).status, 404);
  const fresh = client(A.base);
  const r = await fresh.login('owner', PW.owner, 'advanced');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'advanced');
});

test('hiding every advanced box still shows More and the primary boxes', async () => {
  const ownerPage = await ownerB.get('advanced');
  const designerPage = await designerB.get('advanced');
  assert.equal(designerPage.status, 200);
  assert.equal(ownerPage.status, 200);
  const hash = B.mirror.commitInfo.short;
  assert.ok(ownerPage.text.includes(hash));
  assert.ok(designerPage.text.includes(hash));
  const main = block(designerPage.text, '<main', '</main>');
  assert.ok(!main.includes('box?id='));
  assert.ok(!main.includes('Nothing here yet.'));
  const nav = block(designerPage.text, '<nav', '</nav>');
  assert.deepEqual(hrefs(nav), ['./', ...PRIMARY.map((id) => `box?id=${id}`), 'workshop', 'inbox', 'advanced']);
});
