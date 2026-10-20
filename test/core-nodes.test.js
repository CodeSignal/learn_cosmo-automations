'use strict';

/**
 * The core-set nodes: Switch, Merge, Sort, Limit, Remove Duplicates.
 *
 * Same table-driven shape as `pipeline.test.js`. Two things here are not about
 * a single node and matter more than the rest:
 *
 *   - Switch's port list comes from its own rules, so the engine and the canvas
 *     must agree about how many ports exist and what they are called.
 *   - Merge has two inputs, which is the first time `itemsIn` has had to mean
 *     something other than "input 1". The report has to disclose both, or a
 *     correct join reads as an unexplained item increase.
 */

const test = require('node:test');
const assert = require('node:assert');
const { executeWorkflow } = require('../engine/scheduler');
const { effectiveOutputs } = require('../shared/node-ports.mjs');
const { getNode } = require('../engine/nodes');
const { formatReport } = require('../grading/format');

const BARE_SCENARIO = {
  triggerPayload: { manualTrigger: {} },
  mockApi: { hosts: {} },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
};

async function runNode({ type, parameters, items }) {
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'sut', name: 'Subject', type, position: [200, 0], parameters },
    ],
    connections: [{ from: 'src', fromOutput: 0, to: 'sut', toInput: 0 }],
  };
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: items } },
    graph,
  );
  const record = trace.nodes.find((n) => n.name === 'Subject');
  return { trace, record, out: (record.output || []).map((i) => i.json) };
}

/* ── Switch ────────────────────────────────────────────────────────────── */

const REGION_RULES = [
  { output: 'EU', left: '={{ $json.region }}', op: 'equals', right: 'EU' },
  { output: 'US', left: '={{ $json.region }}', op: 'equals', right: 'US' },
  { output: 'APAC', left: '={{ $json.region }}', op: 'equals', right: 'APAC' },
];

/** Wire every Switch port to its own collector so nothing is dropped. */
async function runSwitch(parameters, items) {
  const rules = parameters.rules || [];
  const ports = effectiveOutputs(getNode('switch'), { parameters });
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'sw', name: 'Route', type: 'switch', position: [200, 0], parameters },
      ...ports.map((port, index) => ({
        id: `sink${index}`,
        name: `Sink ${index}`,
        type: 'noOp',
        position: [400, index * 100],
        parameters: {},
      })),
    ],
    connections: [
      { from: 'src', fromOutput: 0, to: 'sw', toInput: 0 },
      ...ports.map((port, index) => ({
        from: 'sw', fromOutput: index, to: `sink${index}`, toInput: 0,
      })),
    ],
  };
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: items } },
    graph,
  );
  const record = trace.nodes.find((n) => n.name === 'Route');
  const byPort = {};
  record.outputsByPort.forEach((p) => { byPort[p.name] = p.count; });
  return { trace, record, byPort, ports, rules };
}

test('switch: one port per rule, named by the rule', () => {
  const ports = effectiveOutputs(getNode('switch'), { parameters: { rules: REGION_RULES } });
  assert.deepStrictEqual(ports.map((p) => p.name), ['EU', 'US', 'APAC']);
});

test('switch: an unnamed rule still gets a port, so the wire has somewhere to go', () => {
  const ports = effectiveOutputs(getNode('switch'), {
    parameters: { rules: [{ output: 'EU' }, { output: '' }] },
  });
  assert.deepStrictEqual(ports.map((p) => p.name), ['EU', 'rule 2']);
});

test('switch: the fallback output only exists when it is asked for', () => {
  const off = effectiveOutputs(getNode('switch'), { parameters: { rules: REGION_RULES } });
  const on = effectiveOutputs(getNode('switch'), {
    parameters: { rules: REGION_RULES, fallback: 'extra' },
  });
  assert.strictEqual(off.length, 3);
  assert.deepStrictEqual(on.map((p) => p.name), ['EU', 'US', 'APAC', 'fallback']);
});

test('switch: each item leaves on the port its rule names', async () => {
  const { byPort, record } = await runSwitch(
    { rules: REGION_RULES, fallback: 'none', allMatches: false },
    [{ region: 'EU' }, { region: 'US' }, { region: 'EU' }, { region: 'APAC' }],
  );
  assert.deepStrictEqual(byPort, { EU: 2, US: 1, APAC: 1 });
  assert.strictEqual(record.itemsIn, 4);
  assert.strictEqual(record.itemsOut, 4);
});

test('switch: without a fallback, an item matching nothing is dropped', async () => {
  const { record, byPort } = await runSwitch(
    { rules: REGION_RULES, fallback: 'none' },
    [{ region: 'EU' }, { region: 'LATAM' }],
  );
  assert.strictEqual(record.itemsIn, 2);
  assert.strictEqual(record.itemsOut, 1, 'the unmatched item is gone');
  assert.deepStrictEqual(byPort, { EU: 1, US: 0, APAC: 0 });
});

test('switch: with a fallback, nothing vanishes silently', async () => {
  const { record, byPort } = await runSwitch(
    { rules: REGION_RULES, fallback: 'extra' },
    [{ region: 'EU' }, { region: 'LATAM' }],
  );
  assert.strictEqual(record.itemsOut, 2);
  assert.strictEqual(byPort.fallback, 1);
});

test('switch: the first matching rule wins, so rule order decides', async () => {
  const rules = [
    { output: 'large', left: '={{ $json.total }}', op: 'gt', right: 1000 },
    { output: 'huge', left: '={{ $json.total }}', op: 'gt', right: 4000 },
  ];
  const { byPort } = await runSwitch({ rules, allMatches: false }, [{ total: 5000 }]);
  assert.deepStrictEqual(byPort, { large: 1, huge: 0 });
});

test('switch: allMatches copies the item to every rule it matches', async () => {
  const rules = [
    { output: 'large', left: '={{ $json.total }}', op: 'gt', right: 1000 },
    { output: 'huge', left: '={{ $json.total }}', op: 'gt', right: 4000 },
  ];
  const { byPort, record } = await runSwitch({ rules, allMatches: true }, [{ total: 5000 }]);
  assert.deepStrictEqual(byPort, { large: 1, huge: 1 });
  assert.strictEqual(record.itemsOut, 2, 'one item in, two out — it was copied');
});

test('switch: two rules may share a name and are still two ports', async () => {
  const rules = [
    { output: 'flagged', left: '={{ $json.region }}', op: 'equals', right: 'EU' },
    { output: 'flagged', left: '={{ $json.region }}', op: 'equals', right: 'US' },
  ];
  const ports = effectiveOutputs(getNode('switch'), { parameters: { rules } });
  assert.strictEqual(ports.length, 2);

  const { record } = await runSwitch({ rules }, [{ region: 'EU' }, { region: 'US' }]);
  assert.deepStrictEqual(record.outputsByPort.map((p) => p.count), [1, 1]);
});

/* ── Merge ─────────────────────────────────────────────────────────────── */

/**
 * Merge's two inputs, each fed by a real upstream node rather than a hand-made
 * item array — the numbering of the inputs is part of what is under test.
 *
 * One item list is split by two Limit nodes: Left takes the first N, Right the
 * last M, so each branch carries exactly the items the caller asked for.
 */
async function runMerge(parameters, left, right, options = {}) {
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'a', name: 'Left', type: 'limit', position: [150, -80],
        parameters: { maxItems: left.length, keep: 'firstItems' },
      },
      {
        id: 'b', name: 'Right', type: 'limit', position: [150, 80],
        parameters: { maxItems: right.length, keep: 'lastItems' },
      },
      { id: 'm', name: 'Combined', type: 'merge', position: [350, 0], parameters },
    ],
    connections: [
      { from: 'src', fromOutput: 0, to: 'a', toInput: 0 },
      { from: 'src', fromOutput: 0, to: 'b', toInput: 0 },
      { from: 'a', fromOutput: 0, to: 'm', toInput: 0 },
      ...(options.omitInput2
        ? []
        : [{ from: 'b', fromOutput: 0, to: 'm', toInput: 1 }]),
    ],
  };
  // Left takes the first N, Right takes the last M, of one combined list.
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: [...left, ...right] } },
    graph,
  );
  const record = trace.nodes.find((n) => n.name === 'Combined');
  return { trace, graph, record, out: (record.output || []).map((i) => i.json) };
}

test('merge: append puts input 2 after input 1', async () => {
  const { out, record } = await runMerge(
    { mode: 'append' },
    [{ id: 'a1' }, { id: 'a2' }],
    [{ id: 'b1' }],
  );
  assert.deepStrictEqual(out, [{ id: 'a1' }, { id: 'a2' }, { id: 'b1' }]);
  assert.strictEqual(record.itemsIn, 3, 'itemsIn counts BOTH inputs');
  assert.strictEqual(record.itemsOut, 3);
});

test('merge: itemsIn is attributed per input, not silently summed', async () => {
  const { record } = await runMerge(
    { mode: 'append' },
    [{ id: 'a1' }, { id: 'a2' }],
    [{ id: 'b1' }],
  );
  assert.deepStrictEqual(record.inputsByPort, [{ port: 0, count: 2 }, { port: 1, count: 1 }]);
});

test('merge: combineByPosition pairs 1st with 1st and drops the leftovers', async () => {
  const { out } = await runMerge(
    { mode: 'combineByPosition', includeUnpaired: false },
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ note: 'x' }, { note: 'y' }],
  );
  assert.deepStrictEqual(out, [{ id: 1, note: 'x' }, { id: 2, note: 'y' }]);
});

test('merge: includeUnpaired passes the leftovers through unchanged', async () => {
  const { out } = await runMerge(
    { mode: 'combineByPosition', includeUnpaired: true },
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ note: 'x' }],
  );
  assert.deepStrictEqual(out, [{ id: 1, note: 'x' }, { id: 2 }, { id: 3 }]);
});

test('merge: combineByFields joins on a shared field', async () => {
  const { out } = await runMerge(
    { mode: 'combineByFields', matchField: 'cid', joinMode: 'keepMatches' },
    [{ cid: 'c1', total: 10 }, { cid: 'c2', total: 20 }],
    [{ cid: 'c2', name: 'Bea' }, { cid: 'c9', name: 'Zed' }],
  );
  assert.deepStrictEqual(out, [{ cid: 'c2', total: 20, name: 'Bea' }]);
});

test('merge: enrichInput1 keeps every input 1 item, matched or not', async () => {
  const { out } = await runMerge(
    { mode: 'combineByFields', matchField: 'cid', joinMode: 'enrichInput1' },
    [{ cid: 'c1', total: 10 }, { cid: 'c2', total: 20 }],
    [{ cid: 'c2', name: 'Bea' }],
  );
  assert.deepStrictEqual(out, [{ cid: 'c1', total: 10 }, { cid: 'c2', total: 20, name: 'Bea' }]);
});

test('merge: a field name on neither side is an error, not a silent empty result', async () => {
  const { record } = await runMerge(
    { mode: 'combineByFields', matchField: 'customerID', joinMode: 'keepMatches' },
    [{ cid: 'c1' }],
    [{ cid: 'c1' }],
  );
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /customerID/);
  assert.match(record.error, /nothing could ever match/);
});

test('merge: chooseBranch waits for both, then continues with the one you picked', async () => {
  const { out } = await runMerge(
    { mode: 'chooseBranch', useDataOf: 'input2' },
    [{ id: 'a1' }],
    [{ id: 'b1' }, { id: 'b2' }],
  );
  assert.deepStrictEqual(out, [{ id: 'b1' }, { id: 'b2' }]);
});

test('merge: items on only one input is still work to do, not noItems', async () => {
  const { record, out } = await runMerge(
    { mode: 'append' },
    [{ id: 'a1' }, { id: 'a2' }],
    [],
    { omitInput2: true },
  );
  assert.strictEqual(record.status, 'success');
  assert.deepStrictEqual(out, [{ id: 'a1' }, { id: 'a2' }]);
});

test('the report attributes every Merge input, so a join is never an unexplained increase', async () => {
  const { trace, graph } = await runMerge(
    { mode: 'append' },
    [{ id: 'a1' }, { id: 'a2' }],
    [{ id: 'b1' }],
  );
  const report = formatReport({
    scenario: BARE_SCENARIO, graph, trace, assertions: [], graphHash: trace.graphHash,
  });
  const line = report.split('\n').find((l) => l.includes('Combined') && l.includes('in='));

  assert.match(line, /in=3/);
  assert.match(line, /input 1=2 ← 2 from "Left"/);
  assert.match(line, /input 2=1 ← 1 from "Right"/);
});

test('the report says so when a Merge input has nothing wired to it', async () => {
  const { trace, graph } = await runMerge(
    { mode: 'append' },
    [{ id: 'a1' }],
    [],
    { omitInput2: true },
  );
  const report = formatReport({
    scenario: BARE_SCENARIO, graph, trace, assertions: [], graphHash: trace.graphHash,
  });
  const line = report.split('\n').find((l) => l.includes('Combined') && l.includes('in='));
  assert.match(line, /input 2=0 ← nothing connected/);
});

/* ── Sort ──────────────────────────────────────────────────────────────── */

test('sort: orders by one field, both directions', async () => {
  const items = [{ total: 20 }, { total: 5 }, { total: 12 }];

  const up = await runNode({
    type: 'sort', parameters: { type: 'fields', fields: [{ field: 'total', order: 'ascending' }] }, items,
  });
  assert.deepStrictEqual(up.out.map((i) => i.total), [5, 12, 20]);

  const down = await runNode({
    type: 'sort', parameters: { type: 'fields', fields: [{ field: 'total', order: 'descending' }] }, items,
  });
  assert.deepStrictEqual(down.out.map((i) => i.total), [20, 12, 5]);
});

test('sort: later fields break ties in the earlier ones', async () => {
  const { out } = await runNode({
    type: 'sort',
    parameters: {
      type: 'fields',
      fields: [{ field: 'region', order: 'ascending' }, { field: 'total', order: 'descending' }],
    },
    items: [
      { region: 'US', total: 5 }, { region: 'EU', total: 10 },
      { region: 'US', total: 50 }, { region: 'EU', total: 90 },
    ],
  });
  assert.deepStrictEqual(out, [
    { region: 'EU', total: 90 }, { region: 'EU', total: 10 },
    { region: 'US', total: 50 }, { region: 'US', total: 5 },
  ]);
});

test('sort: equal items keep their input order, so the result is stable', async () => {
  const { out } = await runNode({
    type: 'sort',
    parameters: { type: 'fields', fields: [{ field: 'k', order: 'ascending' }] },
    items: [{ k: 1, seq: 'a' }, { k: 1, seq: 'b' }, { k: 1, seq: 'c' }],
  });
  assert.deepStrictEqual(out.map((i) => i.seq), ['a', 'b', 'c']);
});

test('sort: a field no item has is an error, not an arbitrary order', async () => {
  const { record } = await runNode({
    type: 'sort',
    parameters: { type: 'fields', fields: [{ field: 'nope', order: 'ascending' }] },
    items: [{ total: 1 }],
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /"nope"/);
});

test('sort: random is seeded, so two runs of the same input agree', async () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ n: i }));
  const first = await runNode({ type: 'sort', parameters: { type: 'random' }, items });
  const second = await runNode({ type: 'sort', parameters: { type: 'random' }, items });
  assert.deepStrictEqual(first.out, second.out);
  assert.strictEqual(first.out.length, 8, 'a shuffle keeps every item');
});

/* ── Limit ─────────────────────────────────────────────────────────────── */

test('limit: keeps the first or the last N', async () => {
  const items = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];

  const first = await runNode({
    type: 'limit', parameters: { maxItems: 2, keep: 'firstItems' }, items,
  });
  assert.deepStrictEqual(first.out.map((i) => i.n), [1, 2]);

  const last = await runNode({
    type: 'limit', parameters: { maxItems: 2, keep: 'lastItems' }, items,
  });
  assert.deepStrictEqual(last.out.map((i) => i.n), [3, 4]);
});

test('limit: fewer items than the cap pass through untouched', async () => {
  const { out } = await runNode({
    type: 'limit', parameters: { maxItems: 10, keep: 'firstItems' }, items: [{ n: 1 }],
  });
  assert.deepStrictEqual(out, [{ n: 1 }]);
});

test('limit: a non-numeric cap is an error rather than an accidental zero', async () => {
  const { record } = await runNode({
    type: 'limit', parameters: { maxItems: 'ten', keep: 'firstItems' }, items: [{ n: 1 }],
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /Max Items/);
});

/* ── Remove Duplicates ─────────────────────────────────────────────────── */

test('removeDuplicates: allFields needs every field to match', async () => {
  const { out, record } = await runNode({
    type: 'removeDuplicates',
    parameters: { compare: 'allFields' },
    items: [{ id: 1, at: 'x' }, { id: 1, at: 'x' }, { id: 1, at: 'y' }],
  });
  assert.deepStrictEqual(out, [{ id: 1, at: 'x' }, { id: 1, at: 'y' }]);
  assert.strictEqual(record.itemsOut, 2);
});

test('removeDuplicates: allFields ignores key order', async () => {
  const { out } = await runNode({
    type: 'removeDuplicates',
    parameters: { compare: 'allFields' },
    items: [{ a: 1, b: 2 }, { b: 2, a: 1 }],
  });
  assert.strictEqual(out.length, 1, 'the same fields in another order is the same item');
});

test('removeDuplicates: selectedFields compares only what you listed', async () => {
  const { out } = await runNode({
    type: 'removeDuplicates',
    parameters: { compare: 'selectedFields', fields: ['id'] },
    items: [{ id: 1, at: 'x' }, { id: 1, at: 'y' }, { id: 2, at: 'z' }],
  });
  assert.deepStrictEqual(out, [{ id: 1, at: 'x' }, { id: 2, at: 'z' }]);
});

test('removeDuplicates: allFieldsExcept ignores the noisy field', async () => {
  const { out } = await runNode({
    type: 'removeDuplicates',
    parameters: { compare: 'allFieldsExcept', fields: ['fetchedAt'] },
    items: [{ id: 1, fetchedAt: 'a' }, { id: 1, fetchedAt: 'b' }, { id: 2, fetchedAt: 'c' }],
  });
  assert.deepStrictEqual(out.map((i) => i.id), [1, 2]);
});

test('removeDuplicates: the FIRST occurrence is the one kept', async () => {
  const { out } = await runNode({
    type: 'removeDuplicates',
    parameters: { compare: 'selectedFields', fields: ['id'] },
    items: [{ id: 1, seq: 'first' }, { id: 1, seq: 'second' }],
  });
  assert.deepStrictEqual(out, [{ id: 1, seq: 'first' }]);
});

test('removeDuplicates: a compare mode with no fields listed is an error', async () => {
  const { record } = await runNode({
    type: 'removeDuplicates',
    parameters: { compare: 'selectedFields', fields: [] },
    items: [{ id: 1 }],
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /no fields are listed/);
});
