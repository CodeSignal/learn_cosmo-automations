'use strict';

/**
 * Credentials the candidate creates.
 *
 * The scenario declares TYPES — what a Slack credential is called, which fields
 * it has, and how those become a header. The candidate creates the instances and
 * types the secret in. That is the change worth testing, because picking the only
 * entry in a dropdown tested nothing, and this tests three real things: which type
 * a node needs, that the secret goes in a named field, and what a 401 means.
 *
 * The other half of it is that a secret must not be reachable except by knowing
 * it — so the browser payload and the graded STDOUT both get checked.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run, hashGraph, paletteFor } = require('../engine');
const { executeWorkflow } = require('../engine/scheduler');
const {
  credentialTypes, credentialsFor, applyCredential, secretsIn, BUILT_IN_TYPES,
} = require('../engine/credentials');
const { validateScenario } = require('../engine/validate');
const { listScenarios, readJson } = require('../engine/scenarios');

const SCENARIO = {
  title: 'Credential test',
  credentialTypes: [
    {
      name: 'acmeApi',
      label: 'Acme API',
      auth: [{ in: 'header', name: 'X-Api-Key', value: '{apiKey}' }],
      fields: [{ name: 'apiKey', label: 'API Key', type: 'password' }],
    },
    {
      name: 'twoHeaders',
      label: 'Two Headers',
      auth: [
        { in: 'header', name: 'X-Account', value: '{account}' },
        { in: 'header', name: 'Authorization', value: 'Bearer {token}' },
      ],
      fields: [
        { name: 'account', label: 'Account', type: 'string' },
        { name: 'token', label: 'Token', type: 'password' },
      ],
    },
  ],
  triggerPayload: { manualTrigger: [{}] },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
  mockApi: {
    hosts: {
      'api.acme.test': {
        requireAuth: { header: 'X-Api-Key', equals: 'sk_test_RIGHT' },
        routes: [
          { method: 'GET', path: '/things', when: 'unauthenticated', status: 401, body: { error: 'bad key' } },
          { method: 'GET', path: '/things', when: 'authenticated', status: 200, body: { ok: true } },
        ],
      },
    },
  },
};

/** One HTTP Request node, with whatever credentials the candidate made. */
async function runWith(credentials, credentialId = 'c1') {
  const graph = {
    version: 1,
    nodes: [
      { id: 't', name: 'T', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'h',
        name: 'Fetch',
        type: 'httpRequest',
        position: [1, 0],
        credentialId,
        parameters: {
          method: 'GET',
          url: 'https://api.acme.test/things',
          sendQuery: false, query: [], sendBody: false, body: [], neverError: false,
        },
      },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'h', toInput: 0 }],
    credentials,
  };
  const trace = await executeWorkflow(SCENARIO, graph);
  return { graph, trace, record: trace.nodes.find((n) => n.name === 'Fetch') };
}

/* ── the candidate's value is what authenticates ───────────────────────── */

test('the right key authenticates; a wrong one is a real 401', async () => {
  const right = await runWith([{ id: 'c1', name: 'Mine', type: 'acmeApi', fields: { apiKey: 'sk_test_RIGHT' } }]);
  assert.strictEqual(right.record.status, 'success');
  assert.strictEqual(right.trace.httpCalls[0].status, 200);

  const wrong = await runWith([{ id: 'c1', name: 'Mine', type: 'acmeApi', fields: { apiKey: 'sk_test_WRONG' } }]);
  assert.strictEqual(wrong.record.status, 'error');
  assert.strictEqual(wrong.trace.httpCalls[0].status, 401);
  assert.match(wrong.record.error, /401/);
});

test('no credential at all is the same 401, not a crash', async () => {
  const { record, trace } = await runWith([], null);
  assert.strictEqual(record.status, 'error');
  assert.strictEqual(trace.httpCalls[0].status, 401);
});

test('a credential created but left blank sends no header rather than a broken one', () => {
  const types = credentialTypes(SCENARIO);
  assert.deepStrictEqual(applyCredential({ type: 'acmeApi', fields: {} }, types), {});
  assert.deepStrictEqual(applyCredential({ type: 'acmeApi', fields: { apiKey: '   ' } }, types), {});
  assert.deepStrictEqual(
    applyCredential({ type: 'acmeApi', fields: { apiKey: 'k' } }, types),
    { 'X-Api-Key': 'k' },
  );
});

test('a type may set more than one header, and needs all of its fields to do it', () => {
  const types = credentialTypes(SCENARIO);
  const full = { type: 'twoHeaders', fields: { account: 'acc1', token: 't1' } };
  assert.deepStrictEqual(applyCredential(full, types), {
    'X-Account': 'acc1', Authorization: 'Bearer t1',
  });

  // A half-filled credential contributes only the rule it can complete.
  const half = { type: 'twoHeaders', fields: { account: 'acc1' } };
  assert.deepStrictEqual(applyCredential(half, types), { 'X-Account': 'acc1' });
});

test('an unknown credential type applies nothing instead of throwing', () => {
  assert.deepStrictEqual(applyCredential({ type: 'nope', fields: { a: 1 } }, credentialTypes(SCENARIO)), {});
});

test('the two original types still work, so old scenarios are not stranded', () => {
  const types = credentialTypes({});
  assert.ok(types.has('httpHeaderAuth') && types.has('bearerAuth'));
  assert.deepStrictEqual(
    applyCredential({ type: 'httpHeaderAuth', fields: { name: 'X-Key', value: 'v' } }, types),
    { 'X-Key': 'v' },
  );
  assert.deepStrictEqual(
    applyCredential({ type: 'bearerAuth', fields: { token: 'v' } }, types),
    { Authorization: 'Bearer v' },
  );
  assert.ok(BUILT_IN_TYPES.bearerAuth);
});

/* ── whose credential wins ─────────────────────────────────────────────── */

test("the candidate's credential overrides a scenario-supplied one of the same id", () => {
  const scenario = { credentials: [{ id: 'c1', type: 'acmeApi', fields: { apiKey: 'theirs' } }] };
  const graph = { credentials: [{ id: 'c1', type: 'acmeApi', fields: { apiKey: 'mine' } }] };
  assert.strictEqual(credentialsFor(scenario, graph).get('c1').fields.apiKey, 'mine');
  // And a scenario-supplied one still works when the candidate made none.
  assert.strictEqual(credentialsFor(scenario, {}).get('c1').fields.apiKey, 'theirs');
});

/* ── the workflow's identity includes them ─────────────────────────────── */

test('correcting a mistyped key changes the graph hash, so a stale trace cannot look current', () => {
  const base = { nodes: [], connections: [], credentials: [{ id: 'c1', type: 'acmeApi', fields: { apiKey: 'wrong' } }] };
  const fixed = { nodes: [], connections: [], credentials: [{ id: 'c1', type: 'acmeApi', fields: { apiKey: 'right' } }] };
  assert.notStrictEqual(hashGraph(base), hashGraph(fixed));

  // Still stable for the same content, in any key order.
  const reordered = { connections: [], credentials: [{ type: 'acmeApi', fields: { apiKey: 'wrong' }, id: 'c1' }], nodes: [] };
  assert.strictEqual(hashGraph(base), hashGraph(reordered));
});

/* ── nodes ask for a type ──────────────────────────────────────────────── */

test('every integration names the credential type it needs; HTTP Request takes any', () => {
  const palette = paletteFor({ credentialTypes: SCENARIO.credentialTypes });
  const byType = Object.fromEntries(palette.map((n) => [n.type, n.credentialType]));
  assert.strictEqual(byType.slack, 'slackApi');
  assert.strictEqual(byType.postgres, 'postgresApi');
  assert.strictEqual(byType.httpRequest, null, 'the escape hatch accepts anything');
});

test('offering a node whose credential type nobody declared is refused', async () => {
  const report = await validateScenario({
    title: 'x',
    palette: { include: ['manualTrigger', 'slack'] },
    credentialTypes: [],
    triggerPayload: { manualTrigger: [{}] },
    mockApi: { hosts: {} },
  });
  assert.ok(report.errors.some((e) => /"slack".*"slackApi".*does not declare one/s.test(e)),
    `expected a refusal, got: ${report.errors.join(' | ')}`);
});

/* ── secrets do not leak ───────────────────────────────────────────────── */

test('secretsIn collects both what the candidate typed and what the host expects', () => {
  const graph = { credentials: [{ id: 'c1', type: 'acmeApi', fields: { apiKey: 'sk_test_TYPED' } }] };
  const secrets = secretsIn(SCENARIO, graph);
  assert.ok(secrets.has('sk_test_TYPED'), "the candidate's own value");
  assert.ok(secrets.has('sk_test_RIGHT'), 'and the expected one');
});

test('no shipped scenario leaves a credential value where the browser can read it', () => {
  // The allowlist in server.js, applied here to every scenario we ship.
  const fields = ['version', 'bespokeIdentifier', 'title', 'credentialTypes'];
  for (const entry of listScenarios()) {
    const scenario = readJson(entry.scenarioPath);
    const out = {};
    for (const f of fields) if (scenario[f] !== undefined) out[f] = scenario[f];
    out.palette = paletteFor(scenario);
    const sent = JSON.stringify(out);

    for (const host of Object.values((scenario.mockApi || {}).hosts || {})) {
      const expected = host.requireAuth && host.requireAuth.equals;
      if (expected) assert.ok(!sent.includes(expected), `${entry.name}: expected secret reached the client`);
    }
    for (const cred of scenario.credentials || []) {
      for (const value of Object.values(cred.fields || {})) {
        assert.ok(!sent.includes(String(value)), `${entry.name}: credential value reached the client`);
      }
    }
  }
});

test('a credential value the candidate typed never appears in the graded report', async () => {
  const { formatReport } = require('../grading/format');
  const { graph, trace } = await runWith(
    [{ id: 'c1', name: 'Mine', type: 'acmeApi', fields: { apiKey: 'sk_test_RIGHT' } }],
  );
  const report = formatReport({
    scenario: SCENARIO, graph, trace, assertions: [], graphHash: trace.graphHash,
  });
  assert.ok(!report.includes('sk_test_RIGHT'), 'the secret is in the report');
});

/* ── the shipped scenarios use the new model ───────────────────────────── */

test('every shipped scenario declares credential types, and its solution creates them', () => {
  for (const entry of listScenarios()) {
    const scenario = readJson(entry.scenarioPath);
    const solutionPath = path.join(path.dirname(entry.scenarioPath), 'reference_solution.json');
    if (!fs.existsSync(solutionPath)) continue;
    const solution = JSON.parse(fs.readFileSync(solutionPath, 'utf8'));

    const needed = new Set(solution.nodes.filter((n) => n.credentialId).map((n) => n.credentialId));
    if (!needed.size) continue;

    assert.ok((scenario.credentialTypes || []).length,
      `${entry.name} uses credentials but declares no credentialTypes`);

    const made = new Map((solution.credentials || []).map((c) => [c.id, c]));
    for (const id of needed) {
      assert.ok(made.has(id),
        `${entry.name}: the reference solution attaches "${id}" but never creates it`);
      const declared = (scenario.credentialTypes || []).some((t) => t.name === made.get(id).type);
      assert.ok(declared,
        `${entry.name}: credential "${id}" has type "${made.get(id).type}", which is not declared`);
    }
  }
});

test('a secret in an unfamiliar shape is redacted too, not just the ones we invented', async () => {
  const { formatReport } = require('../grading/format');
  // Nothing about "hunter2-correcthorse" matches sk_/xox/Bearer.
  const scenario = {
    ...SCENARIO,
    mockApi: {
      hosts: {
        'api.acme.test': {
          requireAuth: { header: 'X-Api-Key', equals: 'hunter2-correcthorse' },
          routes: [
            { method: 'GET', path: '/things', when: 'unauthenticated', status: 401, body: { error: 'bad key' } },
            { method: 'GET', path: '/things', when: 'authenticated', status: 200, body: { ok: true } },
          ],
        },
      },
    },
  };
  const graph = {
    version: 1,
    nodes: [
      { id: 't', name: 'T', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'h', name: 'Fetch', type: 'httpRequest', position: [1, 0], credentialId: 'c1',
        parameters: {
          method: 'GET', url: 'https://api.acme.test/things',
          sendQuery: false, query: [], sendBody: false, body: [], neverError: false,
        },
      },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'h', toInput: 0 }],
    credentials: [{ id: 'c1', name: 'Mine', type: 'acmeApi', fields: { apiKey: 'hunter2-correcthorse' } }],
  };
  const trace = await executeWorkflow(scenario, graph);
  const report = formatReport({
    scenario,
    graph,
    trace,
    graphHash: trace.graphHash,
    assertions: [{ id: 'x', pass: false, detail: 'expected hunter2-correcthorse', message: '' }],
  });
  assert.ok(!report.includes('hunter2-correcthorse'),
    'a secret that matches none of the patterns must still be redacted');
  assert.match(report, /\*\*\*/);
});
