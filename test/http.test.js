import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin } from '../src/http.js';

const req = (headers) => ({ headers });

test('a missing Origin is allowed', () => {
  assert.equal(sameOrigin(req({})), true);
  assert.equal(sameOrigin(req({ origin: '' })), true);
});

test('the literal Origin null is refused', () => {
  assert.equal(sameOrigin(req({ origin: 'null', host: 'app.example.test' })), false);
});

test('a malformed Origin is refused', () => {
  assert.equal(sameOrigin(req({ origin: 'not a url', host: 'app.example.test' })), false);
  assert.equal(sameOrigin(req({ origin: 'https://', host: 'app.example.test' })), false);
});

test('the Origin host must include the same port as Host', () => {
  assert.equal(sameOrigin(req({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:9090' })), false);
  assert.equal(sameOrigin(req({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080' })), true);
  // Without public_origin only the host is compared, so the scheme is not checked.
  assert.equal(sameOrigin(req({ origin: 'https://127.0.0.1:8080', host: '127.0.0.1:8080' })), true);
});

test('an IPv6 Host with a port matches', () => {
  assert.equal(sameOrigin(req({ origin: 'http://[::1]:8080', host: '[::1]:8080' })), true);
  assert.equal(sameOrigin(req({ origin: 'http://[::1]:8080', host: '[::1]:9090' })), false);
});

test('public_origin is an exact origin match', () => {
  const pub = 'https://app.example.test';
  assert.equal(sameOrigin(req({ origin: 'https://app.example.test', host: 'internal:8080' }), pub), true);
  assert.equal(sameOrigin(req({ origin: 'http://app.example.test', host: 'app.example.test' }), pub), false);
  assert.equal(sameOrigin(req({ origin: 'https://app.example.test:8443', host: 'app.example.test' }), pub), false);
});

test('X-Forwarded-Host is ignored', () => {
  assert.equal(
    sameOrigin(req({ origin: 'https://evil.example', host: 'app.example.test', 'x-forwarded-host': 'evil.example' })),
    false,
  );
  assert.equal(
    sameOrigin(req({ origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080', 'x-forwarded-host': 'evil.example' })),
    true,
  );
});
