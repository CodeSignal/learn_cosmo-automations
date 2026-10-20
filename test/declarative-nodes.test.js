'use strict';

/**
 * Nodes defined in `scenario.json` rather than in code.
 *
 * Three things have to hold, in this order of importance:
 *
 *   1. a JSON node is INDISTINGUISHABLE from a built-in once it is running — same
 *      palette payload, same trace records, same assertion targeting, same report
 *      lines. Anything less and task authors get a second-class node type
 *   2. a built-in can never be redefined out from under the grader
 *   3. an author's mistake is caught by the validator, with a message that says
 *      what to do — because there is no reviewer between them and a candidate
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run, paletteFor, allNodes, getNode } = require('../engine');
const { executeWorkflow } = require('../engine/scheduler');
const { compileNodeSpec } = require('../engine/nodes/declarative');
const { fill } = require('../engine/template');
const { validateScenario } = require('../engine/validate');
const { effectiveMode } = require('../shared/node-mode.mjs');
const { ICON_NAMES } = require('../shared/node-icons.mjs');
const { evaluateAssertions } = require('../grading/assertions');
const { formatReport } = require('../grading/format');

const DIR = path.join(__dirname, '..', 'scenarios', 'helpdesk-escalation');
const scenario = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));
const reference = JSON.parse(fs.readFileSync(path.join(DIR, 'reference_solution.json'), 'utf8'));

/** A minimal scenario carrying one JSON node, for the unit-level cases. */
const withNode = (spec, extra = {}) => ({
  triggerPayload: { manualTrigger: [{}] },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
  credentials: [],
  mockApi: {
    hosts: {
      'api.example.test': {
        routes: [
          { method: 'GET', path: '/things', status: 200, body: { things: [{ a: 1 }, { a: 2 }] } },
          { method: 'GET', path: '/wrapped', status: 200, body: { records: [{ id: 'r1', fields: { x: 9 } }] } },
          { method: 'POST', path: '/things', status: 201, body: { ok: true } },
          { method: 'GET', path: '/boom', status: 500, body: { error: 'kaboom' } },
        ],
      },
    },
  },
  nodes: [spec],
  ...extra,
});

async function runWith(scenarioObj, parameters, items = [{}]) {
  const type = scenarioObj.nodes[0].type;
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'sut', name: 'Subject', type, position: [200, 0], parameters },
    ],
    connections: [{ from: 'src', fromOutput: 0, to: 'sut', toInput: 0 }],
  };
  const trace = await executeWorkflow(
    { ...scenarioObj, triggerPayload: { manualTrigger: items } }, graph,
  );
  const record = trace.nodes.find((n) => n.name === 'Subject');
  return { trace, record, out: (record.output || []).map((i) => i.json) };
}

/* ── 1. indistinguishable from a built-in ──────────────────────────────── */

test('a scenario node appears in the palette alongside the built-ins', () => {
  const types = paletteFor(scenario).map((n) => n.type);
  assert.ok(types.includes('zendesk'), 'the JSON-defined node is offered');
  assert.ok(types.includes('filter'), 'and so are the built-ins');
  assert.strictEqual(allNodes(scenario).length, allNodes().length + 1);
  assert.strictEqual(getNode('zendesk'), undefined, 'but only when a scenario asks for it');
});

test('its palette entry carries everything the canvas needs', () => {
  const entry = paletteFor(scenario).find((n) => n.type === 'zendesk');
  assert.strictEqual(entry.label, 'Zendesk');
  assert.strictEqual(entry.group, 'integration');
  assert.strictEqual(entry.inputs, 1);
  assert.deepStrictEqual(entry.outputs, [{ name: 'main' }]);
  assert.ok(entry.usesCredential);
  assert.ok(entry.docs && entry.docs.summary, 'a wiki page, like every other node');
  assert.ok(entry.declarative, 'flagged as scenario-defined');
  // The generated operation picker comes first, then the author's own fields.
  assert.deepStrictEqual(entry.params.map((p) => p.name),
    ['operation', 'status', 'ticketId', 'comment']);
});

test('its mode follows the operation, resolved the same way built-ins are', () => {
  const def = getNode('zendesk', scenario);
  assert.strictEqual(def.mode, 'dynamic');
  assert.strictEqual(
    effectiveMode(def, { parameters: { operation: 'listTickets' } }), 'runOnceForAllItems',
  );
  assert.strictEqual(
    effectiveMode(def, { parameters: { operation: 'addComment' } }), 'runOncePerItem',
  );
});

test('a read is one call; a write is one call per item', async () => {
  const trace = await run(scenario, reference);
  const list = trace.nodes.find((n) => n.name === 'List Open Tickets');
  const comment = trace.nodes.find((n) => n.name === 'Escalate');

  assert.strictEqual(list.itemsIn, 1);
  assert.strictEqual(list.itemsOut, 6, 'one item per ticket, envelope unwrapped');
  assert.strictEqual(comment.itemsIn, 3);
  assert.strictEqual(
    trace.httpCalls.filter((c) => c.path.includes('/comments')).length, 3,
    'three urgent tickets, three comments',
  );
});

test('assertions target it by type, and its FAIL prose uses its label', async () => {
  const trace = await run(scenario, reference);
  const results = evaluateAssertions(scenario, reference, trace);
  assert.ok(results.every((r) => r.pass), 'the reference solution passes');

  // Point an assertion at a node the workflow does not have, and the message must
  // read as English using the author's label — not the raw type.
  const missing = evaluateAssertions(
    { ...scenario, assertions: [{ id: 'x', type: 'nodeExists', nodeType: 'zendesk' }] },
    { nodes: [], connections: [] },
    { nodes: [] },
  );
  assert.match(missing[0].detail, /Zendesk/);
});

test('the graded report treats it exactly like a built-in', async () => {
  const trace = await run(scenario, reference);
  const report = formatReport({
    scenario, graph: reference, trace, graphHash: trace.graphHash,
    assertions: evaluateAssertions(scenario, reference, trace),
  });
  assert.match(report, /- "List Open Tickets" \(zendesk\)/);
  assert.match(report, /List Open Tickets\s+in=1\s+out=6/);
  assert.match(report, /RESULT: PASS \(8 PASS, 0 FAIL\)/);
});

/* ── the template language ─────────────────────────────────────────────── */

test('{param} alone keeps the value type; inside a string it interpolates', () => {
  assert.strictEqual(fill('{n}', { n: 42 }), 42);
  assert.strictEqual(fill('{b}', { b: false }), false);
  assert.strictEqual(fill('/v1/x/{n}/y', { n: 42 }), '/v1/x/42/y');
  assert.strictEqual(fill('{unknown}', {}), undefined);
  assert.strictEqual(fill('a{unknown}b', {}), 'a{unknown}b', 'an unknown name is left visible');
});

test('an expression the candidate typed is resolved before the node sees it', async () => {
  const spec = {
    type: 'thing',
    label: 'Thing',
    credential: false,
    operations: {
      create: {
        mode: 'runOncePerItem',
        request: { method: 'POST', url: 'https://api.example.test/things', body: { name: '{title}' } },
        sink: true,
      },
    },
    params: [{ name: 'title', label: 'Title', type: 'string' }],
  };
  const { trace } = await runWith(
    withNode(spec), { operation: 'create', title: '=item {{ $json.n }}' },
    [{ n: 1 }, { n: 2 }],
  );
  assert.deepStrictEqual(trace.sinks.Subject, [{ name: 'item 1' }, { name: 'item 2' }]);
});

test('a placeholder may not choose the host — only the path, query, headers and body', async () => {
  const report = await validateScenario(withNode({
    type: 'thing',
    label: 'Thing',
    operations: { go: { request: { url: 'https://{host}/things' } } },
    params: [{ name: 'host', label: 'Host', type: 'string' }],
  }));
  assert.ok(!report.ok);
  assert.ok(report.errors.some((e) => /placeholder.*HOST/i.test(e)),
    `expected a host-templating error, got: ${report.errors.join(' | ')}`);
});

/* ── response shapes ───────────────────────────────────────────────────── */

test('itemsFrom unwraps an envelope into one item per element', async () => {
  const { out } = await runWith(withNode({
    type: 'thing', label: 'Thing', credential: false,
    operations: { list: { request: { url: 'https://api.example.test/things' }, itemsFrom: 'things' } },
  }), { operation: 'list' });
  assert.deepStrictEqual(out, [{ a: 1 }, { a: 2 }]);
});

test('flatten lifts a nested object onto the item, so $json.x works downstream', async () => {
  const { out } = await runWith(withNode({
    type: 'thing', label: 'Thing', credential: false,
    operations: {
      list: {
        request: { url: 'https://api.example.test/wrapped' },
        itemsFrom: 'records',
        flatten: 'fields',
      },
    },
  }), { operation: 'list' });
  assert.deepStrictEqual(out, [{ id: 'r1', x: 9 }]);
});

test('an itemsFrom path the response does not have is a named error', async () => {
  const { record } = await runWith(withNode({
    type: 'thing', label: 'Thing', credential: false,
    operations: { list: { request: { url: 'https://api.example.test/things' }, itemsFrom: 'nope' } },
  }), { operation: 'list' });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /"nope"/);
  assert.match(record.error, /things/, 'and it lists what IS there');
});

test('a failing status names the service, like the built-in integrations do', async () => {
  const { record } = await runWith(withNode({
    type: 'thing', label: 'Widget Service', credential: false,
    operations: { boom: { request: { url: 'https://api.example.test/boom' } } },
  }), { operation: 'boom' });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /^Widget Service responded with 500 — kaboom/);
});

/* ── 2. what may and may not be replaced ───────────────────────────────── */

test('a scenario CAN replace a library node — that is what the library is for', async () => {
  const swap = withNode({
    type: 'slack', label: 'Mattermost',
    description: 'Our Slack is not Slack.',
    operations: {
      post: {
        mode: 'runOncePerItem',
        request: { method: 'POST', url: 'https://api.example.test/things', body: { text: '{text}' } },
        sink: true,
      },
    },
    params: [{ name: 'text', label: 'Message', type: 'string' }],
    docs: { summary: 'Posts to our own chat service, which is not Slack at all.' },
  });

  assert.strictEqual(getNode('slack', swap).label, 'Mattermost', "the scenario's version wins");
  assert.strictEqual(getNode('slack').label, 'Slack', 'and the library one is untouched elsewhere');

  // It appears once, not twice.
  assert.strictEqual(allNodes(swap).filter((n) => n.type === 'slack').length, 1);
  assert.strictEqual(allNodes(swap).length, allNodes().length);

  const report = await validateScenario(swap);
  assert.ok(report.ok, `should be allowed: ${report.errors.join(' | ')}`);
  assert.ok(report.notes.some((n) => /replaces the library node "slack"/.test(n)),
    'and it should say so, so nobody does it by accident');
});

test('a scenario CANNOT replace a coded node, and is told why', async () => {
  const hijack = withNode({
    type: 'filter', label: 'Not Filter',
    operations: { go: { request: { url: 'https://api.example.test/things' } } },
  });
  assert.strictEqual(getNode('filter', hijack).label, 'Filter', 'the coded node wins');

  const report = await validateScenario(hijack);
  assert.ok(!report.ok);
  assert.ok(report.errors.some((e) => /built into the engine/.test(e)),
    `expected a refusal, got: ${report.errors.join(' | ')}`);
});

test('the library is JSON, and every entry is a complete example', () => {
  const library = allNodes().filter((n) => n.declarative);
  assert.deepStrictEqual(
    library.map((n) => n.type).sort(),
    ['airtable', 'gmail', 'googleSheets', 'postgres', 'slack'],
  );
  for (const node of library) {
    assert.ok(node.docs && node.docs.summary, `${node.type} carries its own docs`);
    assert.ok(node.params.length, `${node.type} has parameters`);
    assert.ok(node.operationModes && Object.keys(node.operationModes).length,
      `${node.type} declares its operations`);
  }
});

/* ── 3. authoring mistakes are caught before a candidate sees them ─────── */

/** validateScenario is async: it runs the reference solution to prove solvability. */
const firstError = async (spec, extra) => {
  const report = await validateScenario(withNode(spec, extra));
  return report.errors.join(' | ');
};

test('a call to a host mockApi does not declare is refused at authoring time', async () => {
  const errors = await firstError({
    type: 'thing', label: 'Thing',
    operations: { go: { request: { url: 'https://not-declared.test/x' } } },
  });
  assert.match(errors, /not-declared\.test/);
  assert.match(errors, /default-deny/);
});

test('a {placeholder} naming no parameter is refused', async () => {
  const errors = await firstError({
    type: 'thing', label: 'Thing',
    operations: { go: { request: { url: 'https://api.example.test/things/{missing}' } } },
  });
  assert.match(errors, /\{missing\}/);
  assert.match(errors, /not a parameter/);
});

test('a node with no operations, or an operation with no URL, is refused', async () => {
  assert.match(await firstError({ type: 'a', label: 'A' }), /declares no `operations`/);
  assert.match(
    await firstError({ type: 'b', label: 'B', operations: { go: { request: {} } } }),
    /has no `request\.url`/,
  );
});

test('an invalid mode is refused rather than silently defaulted', async () => {
  assert.match(
    await firstError({
      type: 'c', label: 'C',
      operations: { go: { mode: 'sometimes', request: { url: 'https://api.example.test/things' } } },
    }),
    /must be runOncePerItem or runOnceForAllItems/,
  );
});

test('a missing docs summary is a warning, not a build failure', async () => {
  const report = await validateScenario(withNode({
    type: 'thing', label: 'Thing', description: 'x',
    operations: { go: { mode: 'runOnceForAllItems', request: { url: 'https://api.example.test/things' } } },
  }));
  assert.ok(report.ok, `should still be valid: ${report.errors.join(' | ')}`);
  assert.ok(report.warnings.some((w) => /docs\.summary/.test(w)));
});

test('an unknown icon warns and falls back, rather than breaking the palette', async () => {
  const report = await validateScenario(withNode({
    type: 'thing', label: 'Thing', icon: 'unicorn',
    operations: { go: { mode: 'runOnceForAllItems', request: { url: 'https://api.example.test/things' } } },
  }));
  assert.ok(report.ok);
  assert.ok(report.warnings.some((w) => /unicorn/.test(w)));
});

/* ── the icon list cannot drift from the drawings ──────────────────────── */

test('every built-in node asks for an icon that exists', () => {
  const missing = allNodes()
    .map((n) => n.icon)
    .filter((icon) => icon && !ICON_NAMES.includes(icon));
  assert.deepStrictEqual([...new Set(missing)], [],
    'shared/node-icons.mjs is out of step with the node definitions');
});

/* ── compiling is total: a broken spec never takes the scenario down ───── */

test('compiling a nonsense spec yields a node that fails loudly when run, not at load', () => {
  assert.doesNotThrow(() => compileNodeSpec({}));
  assert.doesNotThrow(() => compileNodeSpec({ type: 'x', operations: null }));
  const def = compileNodeSpec({ type: 'x', label: 'X' });
  assert.strictEqual(def.type, 'x');
  assert.rejects(
    () => def.run({ params: {} }, [[]]),
    /declares no operations/,
  );
});

/* ── the client payload is an allowlist ────────────────────────────────── */

test('the browser is never handed the fixtures or the expected secret', () => {
  // Reaches into server.js rather than booting it: the point is the shape of the
  // payload, and a leak here is a silent one — nothing fails, the answer is just
  // available in devtools.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const CLIENT_SCENARIO_FIELDS = \[/,
    'scenarioForClient must build from an allowlist, not strip from a spread');
  assert.ok(!/const \{ assertions, instructions, \.\.\.rest \} = scenario/.test(src),
    'the denylist is how mockApi leaked once already');

  const allowlist = /const CLIENT_SCENARIO_FIELDS = \[([\s\S]*?)\];/.exec(src)[1];
  for (const forbidden of ['mockApi', 'assertions', 'triggerPayload', 'instructions']) {
    assert.ok(!allowlist.includes(`'${forbidden}'`), `${forbidden} must never reach the browser`);
  }
});

test('every shipped scenario keeps its expected secrets out of the client payload', async () => {
  const { listScenarios, readJson } = require('../engine/scenarios');
  const { paletteFor } = require('../engine');
  const fields = ['version', 'bespokeIdentifier', 'title', 'credentialTypes'];

  for (const entry of listScenarios()) {
    const scenario = readJson(entry.scenarioPath);
    const out = {};
    for (const f of fields) if (scenario[f] !== undefined) out[f] = scenario[f];
    out.credentials = (scenario.credentials || []).map((c) => ({ id: c.id, name: c.name, type: c.type }));
    out.palette = paletteFor(scenario);
    const sent = JSON.stringify(out);

    for (const host of Object.values((scenario.mockApi || {}).hosts || {})) {
      const secret = host.requireAuth && host.requireAuth.equals;
      if (!secret) continue;
      assert.ok(!sent.includes(secret),
        `${entry.name} leaks the expected credential value to the browser`);
    }
  }
});
