import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, makeSourceRepo, client, PW, sampleRawConfig } from './helpers.js';
import { teaserItems, homeView } from '../src/views.js';
import { strings } from '../src/i18n.js';
import { validateConfig } from '../src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsFixture = path.join(root, 'test/fixtures/docs-site');

function block(html, open, close) {
  const i = html.indexOf(open);
  assert.ok(i >= 0, open);
  const j = html.indexOf(close, i + open.length);
  assert.ok(j > i, close);
  return html.slice(i, j + close.length);
}

function entrance(url) {
  const raw = sampleRawConfig(url);
  raw.links = [{ label: 'Example test site', url: 'https://test.example.com' }];
  raw.roles.designer.hide.boxes = ['questions'];
  const design = raw.boxes.find((b) => b.id === 'design');
  design.title = 'Design';
  design.nav = 'primary';
  for (const id of ['now', 'docs', 'issues', 'source']) raw.boxes.find((b) => b.id === id).nav = 'advanced';
  raw.home = {
    hero: { en: 'Read the notes, or sketch in the workshop.', nb: 'Les notatene, eller skisser i verkstedet.' },
    doors: [
      {
        id: 'specs',
        label: { en: 'Specifications-generic', nb: 'Generiske krav' },
        href: '/docs/',
        blurb: { en: 'Short pages in plain language.', nb: 'Korte sider i vanlig språk.' },
        tag: { en: 'Read', nb: 'Les' },
      },
      {
        id: 'workshop',
        label: { en: 'Workshop', nb: 'Verksted' },
        href: '/workshop',
        blurb: { en: 'Private notes, visible only to you.', nb: 'Private notater, synlige bare for deg.' },
        tag: { en: 'Write', nb: 'Skriv' },
      },
    ],
    links: [{ label: { en: 'Design', nb: 'Design' }, href: 'box?id=design' }],
    teasers: {
      questions: { enabled: true, max: 3, box: 'questions' },
      decisions: { enabled: true, max: 3, box: 'decisions' },
      digest: { enabled: true, box: 'digest' },
    },
  };
  return raw;
}

function withoutItems(url) {
  const raw = entrance(url);
  raw.boxes.find((b) => b.id === 'digest').pattern = 'digest/none/*.md';
  const decisions = raw.boxes.find((b) => b.id === 'decisions');
  decisions.paths = ['decisions/none/*.md'];
  decisions.fallback = { file: 'PLAN.md', heading: '^Later' };
  raw.boxes.find((b) => b.id === 'questions').issues.labels = ['no-such-label'];
  return raw;
}

test('decision and question teasers are empty when there is nothing real to show', () => {
  const decisions = teaserItems('decisions', {
    entries: [],
    fallback: { file: 'PLAN.md', sections: [{ heading: 'Later', html: '<p>a pending choice</p>' }] },
  }, 3);
  assert.deepEqual(decisions, []);
  assert.deepEqual(teaserItems('questions', { issues: [], documents: [], error: 'nope' }, 3), []);
  assert.deepEqual(teaserItems('digest', { entries: [] }, 1), []);
});

test('core files do not ship project copy or an empty-teaser placeholder', () => {
  const banned = ['FixtureBrandAlpha', 'fixturebrandalpha', 'AcmePlan', 'Ingen ennå', '(/docs)', 'Specifications-generic'];
  const files = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(js|css)$/.test(name)) files.push(p);
    }
  };
  walk(path.join(root, 'src'));
  assert.ok(files.length > 5);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const word of banned) assert.equal(text.includes(word), false, `${path.relative(root, file)} contains ${word}`);
  }
  for (const rel of ['src/views.js', 'src/i18n.js', 'src/assets/base.css', 'src/server.js']) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.equal(text.includes('CASCADE'), false, `${rel} contains CASCADE`);
  }
});

test('door cards and home links keep a 44px target in the stylesheet', () => {
  const css = fs.readFileSync(path.join(root, 'src/assets/base.css'), 'utf8');
  assert.match(css, /a\.bt-door\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.bt-home-links a\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.bt-teaser li a\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /--bt-accent:\s*#0f766e/);
});

test('a configured entrance renders doors from the view, with no card grid', () => {
  const html = homeView({
    t: strings('en'),
    locale: 'en',
    status: { source: {}, links: [] },
    home: validateConfig(entrance('https://git.example.com/org/repo.git')).home,
    teasers: [],
  });
  assert.match(html, /<a class="bt-door" href="docs\/">[\s\S]*<h2>Specifications-generic<\/h2>[\s\S]*<\/a>/);
  assert.match(html, /<a class="bt-door" href="workshop">[\s\S]*<h2>Workshop<\/h2>[\s\S]*<\/a>/);
  assert.match(html, /<a href="box\?id=design">Design<\/a>/);
  assert.ok(!html.includes('bt-cards'));
  assert.ok(!html.includes('(/docs)'));
  assert.ok(!html.includes('Welcome to this panel'));
});

let filled, empty, owner, designer, ownerEmpty;
before(async () => {
  const src = makeSourceRepo();
  const bare = makeSourceRepo();
  filled = await makeApp({ raw: entrance(src.url) });
  empty = await makeApp({ raw: withoutItems(bare.url) });
  owner = client(filled.base);
  designer = client(filled.base);
  ownerEmpty = client(empty.base);
  assert.equal((await owner.login('owner', PW.owner)).status, 303);
  assert.equal((await designer.login('designer', PW.designer)).status, 303);
  assert.equal((await ownerEmpty.login('owner', PW.owner)).status, 303);
});
after(() => {
  filled?.close();
  empty?.close();
});

test('home: present renders both doors, a small design link, and only teasers that have items', async () => {
  const page = await owner.get('');
  assert.equal(page.status, 200);
  const nav = block(page.text, '<nav', '</nav>');
  const main = block(page.text, '<main', '</main>');
  const footer = block(page.text, '<footer', '</footer>');
  assert.match(nav, /href="box\?id=design"/);
  assert.ok(!nav.includes('box?id=source'));
  assert.match(main, /<h1 class="bt-hero">Read the notes, or sketch in the workshop\.<\/h1>/);
  assert.match(main, /<a class="bt-door" href="docs\/">[\s\S]*<h2>Specifications-generic<\/h2>[\s\S]*Short pages in plain language\.[\s\S]*<\/a>/);
  assert.match(main, /<a class="bt-door" href="workshop">[\s\S]*<h2>Workshop<\/h2>[\s\S]*<\/a>/);
  assert.match(main, /<nav class="bt-home-links"[^>]*>\s*<a href="box\?id=design">Design<\/a><\/nav>/);
  assert.ok(!main.includes('class="bt-door" href="box?id=design"'));
  assert.ok(!main.includes('(/docs)'));
  assert.ok(!main.includes('AcmePlan'));
  assert.ok(!main.includes('CASCADE'));
  assert.ok(!main.includes('FixtureBrandAlpha'));
  assert.ok(!main.includes('bt-cards'));
  assert.match(main, /Open questions/);
  assert.match(main, /Which colour for the header\?/);
  assert.match(main, /https:\/\/example\.com\/i\/3/);
  assert.match(main, /Decisions/);
  assert.match(main, /Use a mirror/);
  assert.match(main, /What&#39;s new/);
  assert.match(main, /Digest 2 Jan/);
  assert.match(main, /Fresh news about the mirror/);
  assert.ok(!main.includes('Digest 1 Jan'));
  assert.ok(!main.includes('Nothing here yet'));
  assert.ok(!main.includes('Ingen ennå'));
  assert.ok(!main.includes('Ingenting her ennå'));
  assert.ok(!main.includes('a pending choice'));
  assert.ok(!main.includes('PLAN.md'));
  assert.match(footer, /Signed in as owner/);
  assert.match(footer, /Example test site/);
  assert.doesNotMatch(footer, /<code>/);
  const advanced = await owner.get('advanced');
  const advancedFooter = block(advanced.text, '<footer', '</footer>');
  assert.match(advancedFooter, /<code>owner<\/code>/);
  assert.ok(!advancedFooter.includes('Example test site'));
  assert.match(block(advanced.text, '<main', '</main>'), /box\?id=source/);
});

test('a role that cannot see the questions box does not get that teaser', async () => {
  const main = block((await designer.get('')).text, '<main', '</main>');
  assert.ok(!main.includes('Which colour'));
  assert.ok(!main.includes('Open questions'));
  assert.match(main, /Use a mirror/);
  assert.match(main, /Digest 2 Jan/);
});

test('Norwegian copy comes from home:, not from a built-in product string', async () => {
  const main = block((await owner.get('', { 'Accept-Language': 'nb' })).text, '<main', '</main>');
  assert.match(main, /<h1 class="bt-hero">Les notatene, eller skisser i verkstedet\.<\/h1>/);
  assert.match(main, /<h2>Generiske krav<\/h2>/);
  assert.match(main, /Åpne spørsmål/);
  assert.ok(!main.includes('(/docs)'));
  assert.ok(!main.includes('FixtureBrandAlpha'));
});

test('home: with empty teasers hides them, including a decision fallback', async () => {
  const page = await ownerEmpty.get('');
  const main = block(page.text, '<main', '</main>');
  assert.match(main, /<a class="bt-door" href="docs\/">/);
  assert.match(main, /<a class="bt-door" href="workshop">/);
  assert.ok(!main.includes('bt-teaser'));
  assert.ok(!main.includes('Open questions'));
  assert.ok(!main.includes('What&#39;s new'));
  assert.ok(!main.includes('Nothing here yet'));
  assert.ok(!main.includes('Ingen ennå'));
  assert.ok(!main.includes('a pending choice'));
  assert.ok(!main.includes('PLAN.md'));
  assert.ok(!main.includes('AcmePlan'));
});

test('without home: the entrance is a generic welcome and feature links', async () => {
  const app = await makeApp({ handlerOptions: { docsDir: docsFixture } });
  try {
    const user = client(app.base);
    assert.equal((await user.login('owner', PW.owner)).status, 303);
    const page = await user.get('');
    const main = block(page.text, '<main', '</main>');
    const nav = block(page.text, '<nav', '</nav>');
    assert.match(main, /<h1 class="bt-hero">Welcome to this panel\.<\/h1>/);
    assert.match(main, /href="docs\/"/);
    assert.match(main, /href="workshop"/);
    assert.match(main, /href="inbox"/);
    assert.ok(!main.includes('bt-door'));
    assert.ok(!main.includes('bt-cards'));
    assert.ok(!main.includes('bt-teaser'));
    assert.ok(!main.includes('box?id='));
    assert.ok(!main.includes('FixtureBrandAlpha'));
    assert.ok(!main.includes('Generiske krav'));
    assert.match(nav, /href="box\?id=design"/);
    const nb = block((await user.get('', { 'Accept-Language': 'nb' })).text, '<main', '</main>');
    assert.match(nb, /Velkommen til dette panelet\./);
    assert.match(nb, />Dokumentasjon</);
    assert.match(nb, />Verksted</);
  } finally {
    app.close();
  }
});

test('without home: and with workshop, inbox and docs off, only the welcome remains', async () => {
  const src = makeSourceRepo();
  const raw = sampleRawConfig(src.url);
  raw.workshop = { enabled: false };
  raw.inbox = { enabled: false };
  const app = await makeApp({ raw });
  try {
    const user = client(app.base);
    assert.equal((await user.login('owner', PW.owner)).status, 303);
    const main = block((await user.get('')).text, '<main', '</main>');
    assert.match(main, /Welcome to this panel/);
    assert.ok(!main.includes('href="workshop"'));
    assert.ok(!main.includes('href="inbox"'));
    assert.ok(!main.includes('href="docs/'));
    assert.ok(!main.includes('bt-door'));
    assert.ok(!main.includes('FixtureBrandAlpha'));
  } finally {
    app.close();
  }
});
