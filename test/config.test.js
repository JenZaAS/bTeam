import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, ConfigError } from '../src/config.js';
import { sampleRawConfig } from './helpers.js';

const base = () => sampleRawConfig('https://git.example.com/org/repo.git');

test('valid sample config loads and normalises', () => {
  const c = validateConfig(base());
  assert.equal(c.instance.id, 'sample');
  assert.equal(c.source.refreshMs, 600_000);
  assert.equal(c.boxes.length, 8);
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

test('auth, web, workshop and inbox settings are validated with safe defaults', () => {
  const base = sampleRawConfig('https://git.example.com/o/r.git');
  const c = validateConfig(base);
  assert.equal(c.web.secureCookies, true);
  assert.equal(c.web.sameSite, 'Lax');
  assert.equal(c.auth.maxFailures, 5);
  assert.equal(c.auth.sessionIdleMs, 12 * 3600_000);
  assert.equal(c.inbox.ownerQuestionLabel, 'needs-owner-decision');
  const c2 = validateConfig({ ...base, auth: { session_idle: '30m', session_max: '1d', max_failures: 3 }, web: { same_site: 'strict', secure_cookies: false } });
  assert.equal(c2.auth.sessionIdleMs, 30 * 60_000);
  assert.equal(c2.web.sameSite, 'Strict');
  assert.equal(c2.web.secureCookies, false);
  for (const bad of [{ auth: { min_password_length: 4 } }, { auth: { session_idle: '8d' } }, { auth: { nope: 1 } }, { web: { same_site: 'none' } }, { web: { secure_cookies: 'yes' } }, { inbox: { owner_question_label: 'a\nb' } }]) {
    assert.throws(() => validateConfig({ ...base, ...bad }), undefined, JSON.stringify(bad));
  }
});
