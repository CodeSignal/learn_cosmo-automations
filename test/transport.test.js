'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveRequest, normalisePath } = require('../engine/mock/resolver');

const SCENARIO = {
  mockApi: {
    hosts: {
      'api.acme-crm.test': {
        requireAuth: { header: 'X-Api-Key', equals: 'sk_test_FAKE_2f9a1c' },
        routes: [
          { method: 'GET', path: '/v1/orders', when: 'unauthenticated', status: 401, body: { error: 'missing api key' } },
          { method: 'GET', path: '/v1/orders', when: 'authenticated', status: 200, body: { orders: [{ id: 1 }] } },
          { method: 'POST', path: '/v1/orders/:id/flag', status: 202, body: { ok: true } },
        ],
      },
      'slack.test': {
        routes: [{ method: 'POST', path: '/api/chat.postMessage', status: 200, body: { ok: true } }],
      },
    },
  },
};

const AUTH = { 'X-Api-Key': 'sk_test_FAKE_2f9a1c' };

test('an authenticated request gets the fixture', () => {
  const res = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.acme-crm.test/v1/orders', headers: AUTH,
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.orders, [{ id: 1 }]);
});

test('a missing or wrong credential gets a real 401', () => {
  const none = resolveRequest(SCENARIO, { method: 'GET', url: 'https://api.acme-crm.test/v1/orders', headers: {} });
  assert.strictEqual(none.status, 401);

  const wrong = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.acme-crm.test/v1/orders', headers: { 'X-Api-Key': 'nope' },
  });
  assert.strictEqual(wrong.status, 401);
});

test('header matching is case-insensitive, as HTTP requires', () => {
  const res = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.acme-crm.test/v1/orders',
    headers: { 'x-API-key': 'sk_test_FAKE_2f9a1c' },
  });
  assert.strictEqual(res.status, 200);
});

test('an unlisted host is denied — default deny, never a fall-through', () => {
  const res = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.github.com/users/octocat', headers: {},
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.denied, true);
  assert.match(res.body.error, /no mock API for host "api\.github\.com"/);
  assert.match(res.body.error, /api\.acme-crm\.test/, 'tells the learner what is available');
});

test('a matched host with an unmatched route is a 404, not a 200', () => {
  const res = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.acme-crm.test/v1/customers', headers: AUTH,
  });
  assert.strictEqual(res.status, 404);
});

test('path parameters and query constraints match', () => {
  const res = resolveRequest(SCENARIO, {
    method: 'POST', url: 'https://api.acme-crm.test/v1/orders/AC-4801/flag', headers: AUTH,
  });
  assert.strictEqual(res.status, 202);

  const withQuery = resolveRequest(
    { mockApi: { hosts: { 'x.test': { routes: [{ method: 'GET', path: '/a', query: { since: '*' }, status: 200, body: {} }] } } } },
    { method: 'GET', url: 'https://x.test/a?since=2026-01-01', headers: {} },
  );
  assert.strictEqual(withQuery.status, 200);

  const missingQuery = resolveRequest(
    { mockApi: { hosts: { 'x.test': { routes: [{ method: 'GET', path: '/a', query: { since: '*' }, status: 200, body: {} }] } } } },
    { method: 'GET', url: 'https://x.test/a', headers: {} },
  );
  assert.strictEqual(missingQuery.status, 404);
});

test('path traversal is normalised away before fixture matching', () => {
  assert.strictEqual(normalisePath('/v1/../../etc/passwd'), '/etc/passwd');
  assert.strictEqual(normalisePath('/v1/./orders'), '/v1/orders');
  assert.strictEqual(normalisePath('/v1//orders'), '/v1/orders');

  // ..-escaping cannot reach a route it was not granted.
  const res = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.acme-crm.test/v1/deep/../orders', headers: AUTH,
  });
  assert.strictEqual(res.status, 200, 'normalises to /v1/orders');
});

test('the method allowlist rejects CONNECT and TRACE', () => {
  for (const method of ['CONNECT', 'TRACE', 'OPTIONS']) {
    const res = resolveRequest(SCENARIO, { method, url: 'https://api.acme-crm.test/v1/orders', headers: AUTH });
    assert.strictEqual(res.status, 405, method);
  }
});

test('the reported path is the loopback rewrite, never the candidate-typed host', () => {
  const res = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.acme-crm.test/v1/orders?since=2026-07-30', headers: AUTH,
  });
  assert.strictEqual(res.loopbackPath, '/__mock/api.acme-crm.test/v1/orders?since=2026-07-30');
});

test('userinfo in the authority cannot smuggle a different host', () => {
  const res = resolveRequest(SCENARIO, {
    method: 'GET', url: 'https://api.acme-crm.test@evil.example.com/v1/orders', headers: AUTH,
  });
  assert.strictEqual(res.status, 403, 'the real host is evil.example.com and is not listed');
});

test('a malformed URL is a 400, not a crash', () => {
  for (const url of ['not-a-url', '', '/v1/orders', 'ftp:/broken']) {
    const res = resolveRequest(SCENARIO, { method: 'GET', url, headers: {} });
    assert.ok(res.status >= 400, JSON.stringify(url));
  }
});

test('NO EGRESS BY CONSTRUCTION: the engine imports no network module', () => {
  // The plan requires the code path that would call real fetch/http to not
  // exist. This test is that guarantee — it fails the build if one appears.
  const forbidden = /require\s*\(\s*['"](node:)?(http|https|net|tls|dgram|dns|child_process)['"]\s*\)|\bfetch\s*\(|\bnew\s+WebSocket\b|\bimport\s*\(\s*['"](node:)?(http|https|net)['"]/;
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      // Strip comments so prose about fetch/http does not trip the check.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (forbidden.test(code)) offenders.push(path.relative(process.cwd(), full));
    }
  };
  walk(path.join(__dirname, '..', 'engine'));

  assert.deepStrictEqual(offenders, [],
    'engine/ must never import a network module — route all I/O through the mock resolver');
});
