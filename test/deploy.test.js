// Step 3 (deploy): bind address from the environment, the container health check and the
// in-process hourly refresh of the mirror and the issues.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { resolveServeOptions, healthUrl, checkHealth, isLoopback as optsLoopback, ServeOptionsError } from '../src/serve-options.js';
import { isLoopback } from '../src/server.js';
import { openInstance } from '../src/instance.js';
import { makeSourceRepo, sampleRawConfig, fakeFetch } from './helpers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('serve binds to loopback by default and only leaves it via --host or BTEAM_HOST', () => {
  assert.deepEqual(resolveServeOptions({}, {}), { host: '127.0.0.1', port: 8080, devUser: null, public: false });
  assert.equal(resolveServeOptions({}, { BTEAM_HOST: '' }).host, '127.0.0.1');
  assert.equal(resolveServeOptions({}, { HOST: '0.0.0.0' }).host, '127.0.0.1', 'a generic HOST variable is ignored');
  const c = resolveServeOptions({}, { BTEAM_HOST: '0.0.0.0', PORT: '8090' });
  assert.deepEqual(c, { host: '0.0.0.0', port: 8090, devUser: null, public: true });
  assert.equal(resolveServeOptions({ host: '127.0.0.1' }, { BTEAM_HOST: '0.0.0.0' }).host, '127.0.0.1', '--host wins over the env');
  assert.equal(resolveServeOptions({ port: '9000' }, { PORT: '8090' }).port, 9000);
});

test('serve options reject bad values and the dev user off loopback', () => {
  assert.throws(() => resolveServeOptions({}, { BTEAM_HOST: '0.0.0.0; rm' }), ServeOptionsError);
  assert.throws(() => resolveServeOptions({}, { PORT: 'abc' }), ServeOptionsError);
  assert.throws(() => resolveServeOptions({}, { PORT: '70000' }), ServeOptionsError);
  assert.throws(() => resolveServeOptions({ 'dev-user': 'owner' }, { BTEAM_HOST: '0.0.0.0' }), /loopback/);
  assert.equal(resolveServeOptions({ 'dev-user': 'owner' }, {}).devUser, 'owner');
  for (const h of ['127.0.0.1', '::1', 'localhost', '0.0.0.0', '10.0.0.5', '::']) assert.equal(optsLoopback(h), isLoopback(h), h);
});

test('the CLI refuses --dev-user when BTEAM_HOST is public, before opening anything', () => {
  const bin = path.join(ROOT, 'bin', 'bteam.js');
  const r = spawnSync(process.execPath, [bin, 'serve', '--dev-user', 'owner', '--config', '/nonexistent.yaml'], { encoding: 'utf8', env: { PATH: process.env.PATH, BTEAM_HOST: '0.0.0.0' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /loopback/);
});

test('health URL targets loopback for wildcard binds and follows PORT', () => {
  assert.equal(healthUrl({}), 'http://127.0.0.1:8080/healthz');
  assert.equal(healthUrl({ BTEAM_HOST: '0.0.0.0', PORT: '8090' }), 'http://127.0.0.1:8090/healthz');
  assert.equal(healthUrl({ BTEAM_HOST: '::' }), 'http://127.0.0.1:8080/healthz');
  assert.equal(healthUrl({ BTEAM_HOST: '10.1.2.3' }), 'http://10.1.2.3:8080/healthz');
});

test('health check passes only on 200 and fails on 503, errors and timeouts', async () => {
  let status = 200;
  let hang = false;
  const server = http.createServer((req, res) => {
    if (hang) return;
    res.writeHead(req.url === '/healthz' ? status : 404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/healthz`;
  try {
    assert.equal(await checkHealth(url), true);
    status = 503;
    assert.equal(await checkHealth(url), false);
    hang = true;
    assert.equal(await checkHealth(url, { timeoutMs: 200 }), false);
    assert.equal(await checkHealth('http://127.0.0.1:1/healthz', { timeoutMs: 500 }), false);
    // The script itself: exit code only.
    hang = false;
    status = 200;
    const script = path.join(ROOT, 'bin', 'healthcheck.js');
    const env = { PATH: process.env.PATH, BTEAM_HOST: '0.0.0.0', PORT: String(server.address().port) };
    // Async spawn: the test server lives in this process and must keep answering.
    const run = () => new Promise((resolve) => spawn(process.execPath, [script], { env, stdio: 'ignore' }).on('exit', resolve));
    assert.equal(await run(), 0);
    status = 503;
    assert.equal(await run(), 1);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('serve refreshes the mirror and the issues in-process every source/issue refresh interval (1h)', async () => {
  const repo = makeSourceRepo({ 'README.md': '# one\n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-sched-'));
  const raw = sampleRawConfig(repo.url);
  raw.source.refresh = '1h';
  raw.issue_source.refresh = '1h';
  const cfg = path.join(dir, 'instance.yaml');
  fs.writeFileSync(cfg, stringify(raw));
  const calls = [];
  const inst = openInstance({ configPath: cfg, dataDir: path.join(dir, 'data'), env: {}, fetchImpl: fakeFetch(undefined, calls) });
  await inst.syncAll();
  const first = inst.mirror.commit;
  assert.ok(first);
  assert.equal(calls.length, 1);

  const sync = mock.method(inst.mirror, 'sync');
  const refresh = mock.method(inst.issues, 'refresh');
  mock.timers.enable({ apis: ['setInterval'] });
  let stop;
  try {
    stop = inst.schedule({ log: { error() {} } });
    mock.timers.tick(59 * 60_000);
    assert.equal(sync.mock.callCount(), 0, 'nothing before the hour');
    repo.commit('README.md', '# two\n');
    mock.timers.tick(60_000);
    assert.equal(sync.mock.callCount(), 1);
    assert.equal(refresh.mock.callCount(), 1);
    await sync.mock.calls[0].result;
    await refresh.mock.calls[0].result;
    assert.notEqual(inst.mirror.commit, first, 'the new commit is picked up');
    mock.timers.tick(3600_000);
    assert.equal(sync.mock.callCount(), 2);
    assert.equal(refresh.mock.callCount(), 2);
    await sync.mock.calls[1].result;
    await refresh.mock.calls[1].result;
    stop();
    mock.timers.tick(3 * 3600_000);
    assert.equal(sync.mock.callCount(), 2, 'stop() clears the timers');
  } finally {
    mock.timers.reset();
    mock.restoreAll();
  }
});

test('a failed hourly refresh is logged without the token and keeps the last good commit', async () => {
  const repo = makeSourceRepo({ 'README.md': '# one\n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-sched-'));
  const raw = sampleRawConfig(repo.url);
  raw.source.refresh = '1h';
  const cfg = path.join(dir, 'instance.yaml');
  fs.writeFileSync(cfg, stringify(raw));
  const inst = openInstance({ configPath: cfg, dataDir: path.join(dir, 'data'), env: { TEST_ISSUES_TOKEN: 'tok-placeholder' }, fetchImpl: async () => { throw new Error('down tok-placeholder'); } });
  await inst.syncAll({ log: { error() {} } });
  const good = inst.mirror.commit;
  fs.rmSync(repo.dir, { recursive: true, force: true }); // the source disappears
  const errors = [];
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const stop = inst.schedule({ log: { error: (m) => errors.push(m) } });
    const sync = mock.method(inst.mirror, 'sync');
    mock.timers.tick(3600_000);
    await sync.mock.calls[0]?.result?.catch(() => {});
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));
    stop();
  } finally {
    mock.timers.reset();
    mock.restoreAll();
  }
  assert.equal(inst.mirror.commit, good);
  assert.ok(inst.core.healthy(), '/healthz stays 200 on a failed refresh');
  assert.ok(errors.some((m) => /mirror sync failed/.test(m)), errors.join('\n'));
  assert.ok(errors.some((m) => /issue refresh failed/.test(m)));
  assert.ok(errors.every((m) => !m.includes('tok-placeholder')));
});

test('the Dockerfile runs as non-root, binds 0.0.0.0 only via BTEAM_HOST and ships a health check', () => {
  const df = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const users = [...df.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
  assert.ok(users.length && !/^(root|0)(:|$)/.test(users.at(-1)), 'last USER is not root');
  assert.match(df, /^ENV[\s\S]*BTEAM_HOST=0\.0\.0\.0/m);
  assert.ok(!/--host\s+0\.0\.0\.0/.test(df), 'no hard-coded public bind in the command');
  assert.match(df, /^HEALTHCHECK [^\n]*\\\n\s*CMD \["node", "\/app\/bin\/healthcheck\.js"\]/m);
  assert.match(df, /^VOLUME \["\/data"\]/m);
  assert.ok(!/BTEAM_(SOURCE|ISSUES)_TOKEN\s*=/.test(df), 'no token values in the image');
  const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8').split('\n');
  for (const p of ['.env', 'data', 'instance.yaml', 'node_modules', '.git']) assert.ok(ignore.some((l) => l.trim().replace(/^\//, '').replace(/\/$/, '') === p), `.dockerignore has ${p}`);
});

test('bteam backup writes a verified, private copy of the live database and never overwrites', async () => {
  const repo = makeSourceRepo({ 'README.md': '# one\n' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bteam-bak-'));
  const cfg = path.join(dir, 'instance.yaml');
  fs.writeFileSync(cfg, stringify(sampleRawConfig(repo.url)));
  const data = path.join(dir, 'data');
  const bin = path.join(ROOT, 'bin', 'bteam.js');
  const run = (args, input) => spawnSync(process.execPath, [bin, ...args, '--config', cfg, '--data', data], { encoding: 'utf8', input, env: { PATH: process.env.PATH } });
  assert.equal(run(['user', 'add', 'owner', '--role', 'owner', '--password-stdin'], 'test-only-placeholder-1\n').status, 0);
  // A second connection stays open, as the running server would.
  const { openDb, dbPath } = await import('../src/db.js');
  const live = openDb(dbPath(data, 'sample'));
  try {
    const r = run(['backup']);
    assert.equal(r.status, 0, r.stderr);
    const file = r.stdout.match(/backup written: (\S+)/)[1];
    assert.ok(file.startsWith(path.join(data, 'backups', 'sample-')));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(r.stdout, /1 user\(s\)/);
    const again = run(['backup', '--out', file]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /refusing to overwrite/);
  } finally {
    live.close();
  }
});
