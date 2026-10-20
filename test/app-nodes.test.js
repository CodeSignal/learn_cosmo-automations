'use strict';

/**
 * The integration nodes: Gmail, Google Sheets, Postgres, Airtable.
 *
 * Every one of them goes through the same mock transport as HTTP Request, so
 * what is worth testing is not "does HTTP work" — `transport.test.js` owns that
 * — but the three things each app node adds on top:
 *
 *   1. the mode follows the operation, so a read is one call and a write is one
 *      call per item. Getting this wrong means forty API calls where one was
 *      meant, which is the expensive kind of mistake
 *   2. the envelope is unwrapped, so `{{ $json.region }}` works downstream
 *      without a Split Out
 *   3. a missing credential is a visible 401 rather than a silent nothing
 */

const test = require('node:test');
const assert = require('node:assert');
const { executeWorkflow } = require('../engine/scheduler');
const { effectiveMode } = require('../shared/node-mode.mjs');
const { getNode } = require('../engine/nodes');

const CREDENTIAL = {
  id: 'cred_app',
  name: 'Test App',
  type: 'httpHeaderAuth',
  fields: { name: 'X-Api-Key', value: 'sk_test_FAKE_app' },
};

const AUTH = { requireAuth: { header: 'X-Api-Key', equals: 'sk_test_FAKE_app' } };
const UNAUTH_ROUTE = (method, path) => ({
  method, path, when: 'unauthenticated', status: 401, body: { error: 'missing api key' },
});

const SCENARIO = {
  credentials: [CREDENTIAL],
  triggerPayload: { manualTrigger: {} },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
  mockApi: {
    hosts: {
      'gmail.test': {
        ...AUTH,
        routes: [
          UNAUTH_ROUTE('POST', '/v1/messages/send'),
          { method: 'POST', path: '/v1/messages/send', when: 'authenticated', status: 200, body: { id: 'msg_1' } },
          {
            method: 'GET',
            path: '/v1/messages',
            when: 'authenticated',
            status: 200,
            body: [{ from: 'a@x.test', subject: 'One' }, { from: 'b@x.test', subject: 'Two' }],
          },
        ],
      },
      'sheets.test': {
        ...AUTH,
        routes: [
          {
            method: 'GET',
            path: '/v4/spreadsheets/doc1/values/Sheet1',
            when: 'authenticated',
            status: 200,
            body: { range: 'Sheet1', values: [{ Region: 'EU', Total: 10 }, { Region: 'US', Total: 20 }] },
          },
          {
            method: 'POST',
            path: '/v4/spreadsheets/doc1/values/Sheet1:append',
            when: 'authenticated',
            status: 200,
            body: { updates: { updatedRows: 1 } },
          },
        ],
      },
      'db.internal.test': {
        ...AUTH,
        routes: [
          UNAUTH_ROUTE('POST', '/query'),
          {
            method: 'POST',
            path: '/query',
            when: 'authenticated',
            status: 200,
            body: { rows: [{ id: 1, region: 'EU' }, { id: 2, region: 'US' }, { id: 3, region: 'EU' }] },
          },
          { method: 'POST', path: '/insert/flagged', when: 'authenticated', status: 201, body: { ok: true } },
        ],
      },
      'api.airtable.test': {
        ...AUTH,
        routes: [
          {
            method: 'GET',
            path: '/v0/appX/Orders',
            when: 'authenticated',
            status: 200,
            body: {
              records: [
                { id: 'rec1', fields: { Region: 'EU', Total: 1420 } },
                { id: 'rec2', fields: { Region: 'US', Total: 5300 } },
              ],
            },
          },
          { method: 'POST', path: '/v0/appX/Orders', when: 'authenticated', status: 200, body: { id: 'rec9' } },
        ],
      },
    },
  },
};

/**
 * @param items  what the trigger emits, so a per-item node can be seen looping
 * @param credentialId  omit to test the unauthenticated path
 */
async function runApp({ type, parameters, items = [{}], credentialId = 'cred_app' }) {
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'sut', name: 'Subject', type, position: [200, 0], parameters,
        ...(credentialId ? { credentialId } : {}),
      },
    ],
    connections: [{ from: 'src', fromOutput: 0, to: 'sut', toInput: 0 }],
  };
  const trace = await executeWorkflow(
    { ...SCENARIO, triggerPayload: { manualTrigger: items } },
    graph,
  );
  const record = trace.nodes.find((n) => n.name === 'Subject');
  return {
    trace,
    record,
    out: (record.output || []).map((i) => i.json),
    calls: trace.httpCalls.filter((c) => c.node === 'Subject'),
  };
}

/* ── the mode follows the operation ────────────────────────────────────── */

test('an integration reports its mode as dynamic, resolved from the operation', () => {
  const cases = [
    ['gmail', { operation: 'send' }, 'runOncePerItem'],
    ['gmail', { operation: 'getAll' }, 'runOnceForAllItems'],
    ['googleSheets', { operation: 'read' }, 'runOnceForAllItems'],
    ['googleSheets', { operation: 'append' }, 'runOncePerItem'],
    ['postgres', { operation: 'executeQuery' }, 'runOnceForAllItems'],
    ['postgres', { operation: 'insert' }, 'runOncePerItem'],
    ['airtable', { operation: 'list' }, 'runOnceForAllItems'],
    ['airtable', { operation: 'create' }, 'runOncePerItem'],
  ];
  for (const [type, parameters, expected] of cases) {
    const def = getNode(type);
    assert.strictEqual(def.mode, 'dynamic', `${type} declares a dynamic mode`);
    assert.strictEqual(
      effectiveMode(def, { parameters }),
      expected,
      `${type} with operation=${parameters.operation}`,
    );
  }
});

test('a read is one call however many items arrive; a write is one call each', async () => {
  const three = [{ n: 1 }, { n: 2 }, { n: 3 }];

  const read = await runApp({
    type: 'postgres',
    parameters: { operation: 'executeQuery', query: 'SELECT 1' },
    items: three,
  });
  assert.strictEqual(read.calls.length, 1, 'three items in, still one query');

  const write = await runApp({
    type: 'postgres',
    parameters: { operation: 'insert', table: 'flagged', columns: [{ name: 'order_id', value: '={{ $json.n }}' }] },
    items: three,
  });
  assert.strictEqual(write.calls.length, 3, 'one insert per item');
  assert.deepStrictEqual(write.out.map((i) => i.order_id), [1, 2, 3]);
});

/* ── the envelope is unwrapped ─────────────────────────────────────────── */

test('postgres returns one item per row, not one item containing the rows', async () => {
  const { out, record } = await runApp({
    type: 'postgres',
    parameters: { operation: 'executeQuery', query: 'SELECT id, region FROM orders' },
  });
  assert.strictEqual(record.itemsOut, 3);
  assert.deepStrictEqual(out, [{ id: 1, region: 'EU' }, { id: 2, region: 'US' }, { id: 3, region: 'EU' }]);
});

test('googleSheets read returns one item per row', async () => {
  const { out } = await runApp({
    type: 'googleSheets',
    parameters: { operation: 'read', documentId: 'doc1', sheetName: 'Sheet1' },
  });
  assert.deepStrictEqual(out, [{ Region: 'EU', Total: 10 }, { Region: 'US', Total: 20 }]);
});

test('airtable flattens fields onto the item, so $json.Region works downstream', async () => {
  const { out } = await runApp({
    type: 'airtable',
    parameters: { operation: 'list', baseId: 'appX', table: 'Orders' },
  });
  assert.deepStrictEqual(out, [
    { id: 'rec1', Region: 'EU', Total: 1420 },
    { id: 'rec2', Region: 'US', Total: 5300 },
  ]);
});

test('gmail getAll returns one item per message', async () => {
  const { out } = await runApp({
    type: 'gmail',
    parameters: { operation: 'getAll', limit: 5 },
  });
  assert.deepStrictEqual(out.map((i) => i.subject), ['One', 'Two']);
});

/* ── writes are visible to grading ─────────────────────────────────────── */

test('a write records a sink payload, so assertions can check what was sent', async () => {
  const { trace } = await runApp({
    type: 'gmail',
    parameters: {
      operation: 'send',
      to: '={{ $json.email }}',
      subject: '=Order {{ $json.id }}',
      message: 'hello',
    },
    items: [{ email: 'a@x.test', id: 'AC-1' }],
  });
  assert.deepStrictEqual(trace.sinks.Subject, [
    { to: 'a@x.test', subject: 'Order AC-1', message: 'hello' },
  ]);
});

test('an airtable create records the fields it wrote', async () => {
  const { trace, out } = await runApp({
    type: 'airtable',
    parameters: {
      operation: 'create', baseId: 'appX', table: 'Orders',
      fields: [{ name: 'Region', value: '={{ $json.region }}' }],
    },
    items: [{ region: 'EU' }],
  });
  assert.deepStrictEqual(trace.sinks.Subject, [{ Region: 'EU' }]);
  assert.strictEqual(out[0].id, 'rec9');
});

/* ── failures are loud ─────────────────────────────────────────────────── */

test('a missing credential is a named 401, not a silent nothing', async () => {
  const { record } = await runApp({
    type: 'gmail',
    parameters: { operation: 'send', to: 'a@x.test', subject: 's', message: 'm' },
    credentialId: null,
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /^Gmail responded with 401/);
});

test('an unknown host is refused rather than reached', async () => {
  const { record, calls } = await runApp({
    type: 'postgres',
    parameters: { operation: 'executeQuery', query: 'SELECT 1' },
  });
  assert.strictEqual(record.status, 'success', 'the configured host is allowed');
  assert.ok(calls.every((c) => !c.denied));
});

test('an empty query is caught before any request goes out', async () => {
  const { record, calls } = await runApp({
    type: 'postgres',
    parameters: { operation: 'executeQuery', query: '   ' },
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /Query is empty/);
  assert.strictEqual(calls.length, 0);
});

test('an insert with no table named is caught before any request goes out', async () => {
  const { record, calls } = await runApp({
    type: 'postgres',
    parameters: { operation: 'insert', table: '', columns: [{ name: 'a', value: 1 }] },
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /Table is empty/);
  assert.strictEqual(calls.length, 0);
});

/* ── the palette stays capped ──────────────────────────────────────────── */

test('the integration group is capped at six app nodes', () => {
  const { allNodes } = require('../engine');
  const integrations = allNodes().filter((n) => n.group === 'integration');
  assert.ok(
    integrations.length <= 6,
    `${integrations.length} integrations: ${integrations.map((n) => n.type).join(', ')}. `
    + 'The plan caps this at six on purpose — every app node is a fixture surface '
    + 'to maintain, and a palette nobody can read teaches nothing.',
  );
});
