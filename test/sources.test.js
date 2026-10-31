import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Mirror } from '../src/mirror.js';
import { IssueSource } from '../src/issues.js';
import { fakeFetch, makeSourceRepo } from './helpers.js';

test('issue token is read from the env var and sent as a bearer header', async () => {
  const calls = [];
  const src = new IssueSource({ repo: 'o/r', tokenEnv: 'T', env: { T: 'tok123' }, fetchImpl: fakeFetch(undefined, calls) });
  await src.refresh();
  assert.equal(calls[0].headers.Authorization, 'Bearer tok123');
  assert.match(calls[0].url, /\/repos\/o\/r\/issues\?state=all/);
  assert.ok(src.issues.every((i) => i.number !== 7));
});

test('issue errors never echo the token', async () => {
  const src = new IssueSource({ repo: 'o/r', tokenEnv: 'T', env: { T: 'tok123' }, fetchImpl: async () => { throw new Error('boom tok123'); } });
  await assert.rejects(() => src.refresh(), (err) => !err.message.includes('tok123'));
  assert.ok(!src.lastError.includes('tok123'));
});

test('mirror never stores a token in its git config and passes it only via env', async () => {
  const repo = makeSourceRepo({ 'a.md': '# a\n' });
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-m-')), 'm.git');
  const m = new Mirror({ url: repo.url, branch: 'main', dir, tokenEnv: 'T', env: { T: 'secret-token-value' } });
  await m.sync();
  const cfg = fs.readFileSync(path.join(dir, 'config'), 'utf8');
  assert.ok(!cfg.includes('secret-token-value'));
  assert.ok(!cfg.toLowerCase().includes('authorization'));
  assert.equal(execFileSync('git', ['-C', dir, 'config', 'remote.origin.url']).toString().trim(), repo.url);
  // the token is only attached for https remotes
  assert.equal(m._gitEnv().GIT_CONFIG_COUNT, undefined);
  const https = new Mirror({ url: 'https://git.example.com/o/r.git', branch: 'main', dir, tokenEnv: 'T', env: { T: 'secret-token-value' } });
  assert.equal(https._gitEnv().GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.ok(!https._redact('x secret-token-value y').includes('secret-token-value'));
});

test('mirror reports a clean error for a missing branch', async () => {
  const repo = makeSourceRepo({ 'a.md': '# a\n' });
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-m-')), 'm.git');
  const m = new Mirror({ url: repo.url, branch: 'nope', dir });
  await assert.rejects(() => m.sync(), /fetch failed/);
  assert.equal(m.ready, false);
});
