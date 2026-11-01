import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeInstance, makeApp, client, sampleRawConfig, PW, makeSourceRepo } from './helpers.js';

test('list_boxes and get_box expose nav and order in config order', async () => {
  const { core, owner } = await makeInstance();
  const listed = core.list_boxes(owner);
  assert.deepEqual(
    listed.map((b) => [b.id, b.nav, b.order]),
    [
      ['digest', 'primary', null],
      ['decisions', 'primary', null],
      ['now', 'primary', null],
      ['design', 'primary', null],
      ['docs', 'primary', null],
      ['questions', 'primary', null],
      ['issues', 'primary', null],
      ['source', 'primary', null],
    ],
  );
  const box = (await core.get_box(owner, 'digest')).box;
  assert.equal(box.nav, 'primary');
  assert.equal(box.order, null);

  const src2 = makeSourceRepo();
  const raw = sampleRawConfig(src2.url);
  raw.boxes[2].nav = 'advanced';
  raw.boxes[2].order = 5;
  const { core: c2, owner: o2 } = await makeInstance({ raw });
  assert.equal(c2.list_boxes(o2).find((b) => b.id === 'now').nav, 'advanced');
  assert.equal(c2.list_boxes(o2).find((b) => b.id === 'now').order, 5);
  assert.ok(c2.list_boxes(o2).some((b) => b.nav === 'advanced'));
});

function navRaw(url) {
  const raw = sampleRawConfig(url);
  raw.boxes = [
    { id: 'third', type: 'digest', pattern: 'digest/*.md', order: 20 },
    { id: 'first', type: 'digest', pattern: 'digest/*.md', order: 10 },
    { id: 'second', type: 'digest', pattern: 'digest/*.md' },
    { id: 'adv-a', type: 'digest', pattern: 'digest/*.md', nav: 'advanced', order: 2 },
    { id: 'adv-b', type: 'digest', pattern: 'digest/*.md', nav: 'advanced', order: 1 },
    { id: 'issues', type: 'issues', issues: { labels: [], state: 'open' } },
    { id: 'source', type: 'source-browser', include: ['**/*'], exclude: ['secret/**'] },
  ];
  raw.roles.designer.hide = { ...raw.roles.designer.hide, boxes: ['adv-b'] };
  raw.boxes.push({ id: 'owner-only', type: 'digest', pattern: 'digest/*.md', nav: 'advanced', visible_to: ['owner'] });
  return raw;
}

let A, owner, designer;
before(async () => {
  const src = makeSourceRepo();
  A = await makeApp({ raw: navRaw(src.url) });
  owner = client(A.base);
  designer = client(A.base);
  assert.equal((await owner.login('owner', PW.owner)).status, 303);
  assert.equal((await designer.login('designer', PW.designer)).status, 303);
});
after(() => A?.close());

test('order and advanced grouping in nav, home and Advanced page', async () => {
  const home = await owner.get('');
  const first = home.text.indexOf('box?id=first');
  const third = home.text.indexOf('box?id=third');
  const second = home.text.indexOf('box?id=second');
  assert.ok(first >= 0 && third >= 0 && second >= 0);
  assert.ok(first < third && third < second);
  assert.ok(!home.text.includes('box?id=adv-a'));
  assert.ok(!home.text.includes('box?id=owner-only'));

  const adv = await owner.get('advanced');
  const bPos = adv.text.indexOf('box?id=adv-b');
  const aPos = adv.text.indexOf('box?id=adv-a');
  const oPos = adv.text.indexOf('box?id=owner-only');
  assert.ok(aPos >= 0 && bPos >= 0 && oPos >= 0);
  assert.ok(bPos < aPos, 'advanced boxes ordered by order key (adv-b order 1 before adv-a order 2)');

  const boxAdv = await owner.get('box?id=adv-a');
  assert.match(boxAdv.text, /class="bt-nav-more"[^>]*>[\s\S]*?aria-current="page"/);
  assert.ok(!/href="\.\/"[^>]*aria-current="page"/.test(boxAdv.text));
});

test('hide and visible_to keep boxes out of nav and Advanced', async () => {
  assert.equal((await designer.get('box?id=adv-b')).status, 404);
  assert.equal((await owner.get('box?id=adv-b')).status, 200);
  const dAdv = await designer.get('advanced');
  assert.ok(!dAdv.text.includes('box?id=adv-b'));
  const dHome = await designer.get('');
  assert.ok(!dHome.text.includes('box?id=owner-only'));
  assert.ok(!dAdv.text.includes('box?id=owner-only'));
  assert.equal((await designer.get('box?id=owner-only')).status, 404);
  assert.equal((await owner.get('box?id=owner-only')).status, 200);
});

test('Norwegian labels for More, Advanced and main nav', async () => {
  const r = await owner.get('advanced?lang=nb');
  assert.match(r.text, /Mer/);
  assert.match(r.text, /Avansert/);
  assert.match(r.text, /aria-label="Hovednavigasjon"/);
});
