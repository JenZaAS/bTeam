import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, ConfigError, loadConfig } from '../src/config.js';
import { sortNavBoxes, splitNavBoxes } from '../src/views.js';
import { sampleRawConfig } from './helpers.js';

const base = () => sampleRawConfig('https://git.example.com/org/repo.git');

test('valid sample config loads and normalises', () => {
  const c = validateConfig(base());
  assert.equal(c.instance.id, 'sample');
  assert.equal(c.source.refreshMs, 600_000);
  assert.equal(c.boxes.length, 8);
  assert.ok(c.boxes.every((b) => b.nav === 'primary' && b.order === null));
  assert.equal(c.defaultRole, 'owner');
  assert.deepEqual(c.roles.designer.policy.auto_accept_eligible, ['ui']);
  assert.equal(c.boxes.find((b) => b.id === 'digest').latest, 1);
});

test('rejects credentials in the source URL', () => {
  const raw = base();
  raw.source.url = 'https://user:abc@git.example.com/org/repo.git';
  assert.throws(() => validateConfig(raw), /must not contain credentials/);
});

test('rejects unknown keys, box types, bad regex and unknown roles', () => {
  const raw = base();
  raw.surprise = 1;
  raw.boxes.push({ id: 'x', type: 'mystery' });
  raw.boxes[3].filename_pattern = '(';
  raw.roles.designer.policy.route_other_to = 'nobody';
  raw.roles.designer.hide.boxes = ['nope'];
  try {
    validateConfig(raw);
    assert.fail('expected error');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    const all = err.errors.join('\n');
    assert.match(all, /unknown key "surprise"/);
    assert.match(all, /type "mystery" is unknown/);
    assert.match(all, /filename_pattern is not a valid regular expression/);
    assert.match(all, /route_other_to: unknown role "nobody"/);
    assert.match(all, /hide.boxes: unknown box "nope"/);
  }
});

test('token_env must be a variable name, never a value', () => {
  const raw = base();
  raw.source.token_env = 'lowercase-value-not-a-name';
  assert.throws(() => validateConfig(raw), /environment variable NAME/);
});

test('issue boxes need an issue_source; duplicate ids are rejected', () => {
  const raw = base();
  delete raw.issue_source;
  raw.boxes.push({ ...raw.boxes[0] });
  assert.throws(() => validateConfig(raw), (err) => /needs a top-level issue_source/.test(err.message) && /duplicated/.test(err.message));
});

test('users map to roles and may not carry credentials', () => {
  const raw = base();
  raw.users = [{ id: 'alpha', role: 'owner' }, { id: 'beta', role: 'designer', password: 'x' }];
  assert.throws(() => validateConfig(raw), /unknown key "password"/);
});

test('nav advanced and any safe integer order are accepted', () => {
  const raw = base();
  raw.boxes[0].nav = 'advanced';
  raw.boxes[0].order = 0;
  raw.boxes[1].order = -3;
  raw.boxes[2].order = 2 ** 53 - 1;
  raw.boxes[3].order = 5;
  raw.boxes[4].order = 5;
  const c = validateConfig(raw);
  assert.equal(c.boxes[0].nav, 'advanced');
  assert.equal(c.boxes[0].order, 0);
  assert.equal(c.boxes[1].nav, 'primary');
  assert.equal(c.boxes[1].order, -3);
  assert.equal(c.boxes[2].order, 2 ** 53 - 1);
  assert.equal(c.boxes[3].order, 5);
  assert.equal(c.boxes[4].order, 5);
  assert.equal(c.boxes[5].nav, 'primary');
  assert.equal(c.boxes[5].order, null);
});

test('bad nav and non-integer order are config errors', () => {
  for (const nav of ['Advanced', 'both', '', true, null, 1]) {
    const raw = base();
    raw.boxes[0].nav = nav;
    assert.throws(
      () => validateConfig(raw),
      (err) => err instanceof ConfigError && err.errors.includes('boxes[0].nav must be "primary" or "advanced"'),
      JSON.stringify(nav),
    );
  }
  for (const order of [1.5, '10', true, null, 2 ** 53]) {
    const raw = base();
    raw.boxes[0].order = order;
    assert.throws(
      () => validateConfig(raw),
      (err) => err instanceof ConfigError && err.errors.includes('boxes[0].order must be an integer'),
      JSON.stringify(order),
    );
  }
});

test('there is no cap on primary boxes', () => {
  assert.equal(validateConfig(base()).boxes.length, 8);
  const raw = base();
  raw.boxes.push({ id: 'ninth', type: 'documents', paths: ['extra/*.md'], nav: 'primary', order: 1 });
  const c = validateConfig(raw);
  assert.equal(c.boxes.length, 9);
  assert.equal(c.boxes[8].nav, 'primary');
  assert.equal(c.boxes[8].order, 1);
});

test('instance.example.yaml loads the advanced group and illustrative primary order', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../instance.example.yaml');
  const c = loadConfig(file);
  assert.equal(c.boxes.length, 8);
  const byId = Object.fromEntries(c.boxes.map((b) => [b.id, b]));
  for (const id of ['now', 'documents', 'issues', 'source']) {
    assert.equal(byId[id].nav, 'advanced', id);
    assert.equal(byId[id].order, null, id);
  }
  assert.equal(byId.decisions.nav, 'primary');
  assert.equal(byId.decisions.order, 20);
  assert.equal(byId.digest.nav, 'primary');
  assert.equal(byId.digest.order, 40);
  assert.equal(byId.gallery.nav, 'primary');
  assert.equal(byId.gallery.order, 60);
  assert.equal(byId.questions.nav, 'primary');
  assert.equal(byId.questions.order, 80);
  const { primary, advanced } = splitNavBoxes(sortNavBoxes(c.boxes));
  assert.deepEqual(primary.map((b) => b.id), ['decisions', 'digest', 'gallery', 'questions']);
  assert.deepEqual(advanced.map((b) => b.id), ['now', 'documents', 'issues', 'source']);
});

test('auth, web, workshop and inbox settings are validated with safe defaults', () => {
  const base = sampleRawConfig('https://git.example.com/o/r.git');
  const c = validateConfig(base);
  assert.equal(c.web.secureCookies, true);
  assert.equal(c.web.sameSite, 'Lax');
  assert.equal(c.web.trustProxy, false);
  assert.equal(c.web.publicOrigin, null);
  assert.equal(c.auth.maxFailures, 5);
  assert.equal(c.auth.sessionIdleMs, 12 * 3600_000);
  assert.equal(c.inbox.ownerQuestionLabel, 'needs-owner-decision');
  const c2 = validateConfig({ ...base, auth: { session_idle: '30m', session_max: '1d', max_failures: 3 }, web: { same_site: 'strict', secure_cookies: false } });
  assert.equal(c2.auth.sessionIdleMs, 30 * 60_000);
  assert.equal(c2.web.sameSite, 'Strict');
  assert.equal(c2.web.secureCookies, false);
  const c3 = validateConfig({ ...base, web: { trust_proxy: true, public_origin: 'https://app.example.test' } });
  assert.equal(c3.web.trustProxy, true);
  assert.equal(c3.web.publicOrigin, 'https://app.example.test');
  for (const bad of [{ auth: { min_password_length: 4 } }, { auth: { session_idle: '8d' } }, { auth: { nope: 1 } }, { web: { same_site: 'none' } }, { web: { secure_cookies: 'yes' } }, { web: { public_origin: 'https://app.example.test/login' } }, { web: { public_origin: 'https://user:abc@app.example.test' } }, { inbox: { owner_question_label: 'a\nb' } }]) {
    assert.throws(() => validateConfig({ ...base, ...bad }), undefined, JSON.stringify(bad));
  }
});
