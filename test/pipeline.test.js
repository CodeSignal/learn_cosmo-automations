'use strict';

/**
 * Table-driven item-pipeline tests: input items → node config → expected
 * output items. This is the suite that has to be right before any UI exists.
 */

const test = require('node:test');
const assert = require('node:assert');
const { executeWorkflow } = require('../engine/scheduler');

const BARE_SCENARIO = {
  triggerPayload: { manualTrigger: {} },
  mockApi: { hosts: {} },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
};

/**
 * Run a single node against a fixed list of input items by feeding them through
 * a Manual Trigger that emits them directly.
 */
async function runNode({ type, parameters, items, scenario = {} }) {
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'sut', name: 'Subject', type, position: [200, 0], parameters },
    ],
    connections: [{ from: 'src', fromOutput: 0, to: 'sut', toInput: 0 }],
  };
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, ...scenario, triggerPayload: { manualTrigger: items } },
    graph,
  );
  const record = trace.nodes.find((n) => n.name === 'Subject');
  return { trace, record, out: (record.output || []).map((i) => i.json) };
}

test('splitOut: one item fans out to one item per array element', async () => {
  const cases = [
    { field: 'orders', items: [{ orders: [{ id: 1 }, { id: 2 }, { id: 3 }] }], expect: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    { field: 'orders', items: [{ orders: [] }], expect: [] },
    { field: 'body.rows', items: [{ body: { rows: [{ a: 1 }] } }], expect: [{ a: 1 }] },
    { field: 'tags', items: [{ tags: ['x', 'y'] }], expect: [{ tags: 'x' }, { tags: 'y' }] },
  ];
  for (const c of cases) {
    const { out } = await runNode({
      type: 'splitOut', parameters: { field: c.field, include: 'noOtherFields' }, items: c.items,
    });
    assert.deepStrictEqual(out, c.expect, `field=${c.field}`);
  }
});

test('splitOut: fans out across every input item, not just the first', async () => {
  const { record } = await runNode({
    type: 'splitOut',
    parameters: { field: 'v', include: 'noOtherFields' },
    items: [{ v: [{ n: 1 }, { n: 2 }] }, { v: [{ n: 3 }] }],
  });
  assert.strictEqual(record.itemsIn, 2);
  assert.strictEqual(record.itemsOut, 3);
});

test('splitOut: keeps sibling fields when include=allOtherFields', async () => {
  const { out } = await runNode({
    type: 'splitOut',
    parameters: { field: 'orders', include: 'allOtherFields' },
    items: [{ since: '2026-07-30', orders: [{ id: 1 }, { id: 2 }] }],
  });
  assert.deepStrictEqual(out, [
    { since: '2026-07-30', id: 1 },
    { since: '2026-07-30', id: 2 },
  ]);
});

test('splitOut: a missing or non-array field is a node error, not silence', async () => {
  const missing = await runNode({
    type: 'splitOut', parameters: { field: 'nope' }, items: [{ orders: [] }],
  });
  assert.strictEqual(missing.record.status, 'error');
  assert.match(missing.record.error, /does not exist/);
  assert.match(missing.record.error, /orders/, 'names the fields that do exist');

  const scalar = await runNode({
    type: 'splitOut', parameters: { field: 'total' }, items: [{ total: 12 }],
  });
  assert.strictEqual(scalar.record.status, 'error');
  assert.match(scalar.record.error, /not an array/);
});

test('filter: keeps matching items and drops the rest', async () => {
  const items = [
    { region: 'EU', total: 1420 },
    { region: 'US', total: 5300 },
    { region: 'EU', total: 640 },
    { region: 'EU', total: 1000 },
  ];
  const cases = [
    {
      name: 'gt is strict',
      conditions: [
        { left: '={{ $json.region }}', op: 'equals', right: 'EU' },
        { left: '={{ $json.total }}', op: 'gt', right: 1000 },
      ],
      expect: 1,
    },
    {
      name: 'gte includes the boundary',
      conditions: [
        { left: '={{ $json.region }}', op: 'equals', right: 'EU' },
        { left: '={{ $json.total }}', op: 'gte', right: 1000 },
      ],
      expect: 2,
    },
    {
      name: 'or combinator',
      combinator: 'or',
      conditions: [
        { left: '={{ $json.region }}', op: 'equals', right: 'US' },
        { left: '={{ $json.total }}', op: 'gt', right: 1300 },
      ],
      expect: 2,
    },
    {
      name: 'undefined never matches',
      conditions: [{ left: '={{ $json.missing }}', op: 'equals', right: 'EU' }],
      expect: 0,
    },
  ];
  for (const c of cases) {
    const { record } = await runNode({
      type: 'filter',
      parameters: { combinator: c.combinator || 'and', conditions: c.conditions },
      items,
    });
    assert.strictEqual(record.itemsOut, c.expect, c.name);
  }
});

test('if: routes to the true and false ports independently', async () => {
  const { record } = await runNode({
    type: 'if',
    parameters: { combinator: 'and', conditions: [{ left: '={{ $json.region }}', op: 'equals', right: 'EU' }] },
    items: [{ region: 'EU' }, { region: 'US' }, { region: 'EU' }],
  });
  assert.deepStrictEqual(
    record.outputsByPort.map((p) => [p.name, p.count]),
    [['true', 2], ['false', 1]],
  );
});

test('items on an unconnected output port are dropped', async () => {
  // Only the false port is wired, so the two EU items vanish.
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'iff', name: 'Branch', type: 'if', position: [200, 0],
        parameters: { combinator: 'and', conditions: [{ left: '={{ $json.region }}', op: 'equals', right: 'EU' }] },
      },
      { id: 'sink', name: 'Sink', type: 'noOp', position: [400, 0], parameters: {} },
    ],
    connections: [
      { from: 'src', fromOutput: 0, to: 'iff', toInput: 0 },
      { from: 'iff', fromOutput: 1, to: 'sink', toInput: 0 },
    ],
  };
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: [{ region: 'EU' }, { region: 'US' }, { region: 'EU' }] } },
    graph,
  );
  assert.strictEqual(trace.nodes.find((n) => n.name === 'Sink').itemsIn, 1);
});

test('aggregate: fans in to exactly one item', async () => {
  const items = [{ total: 1420 }, { total: 2100 }, { total: 1180 }];

  const summarize = await runNode({
    type: 'aggregate',
    parameters: {
      mode: 'summarize',
      outputs: [{ as: 'count', op: 'count' }, { as: 'total', op: 'sum', field: 'total' }],
    },
    items,
  });
  assert.strictEqual(summarize.record.itemsOut, 1);
  assert.deepStrictEqual(summarize.out, [{ count: 3, total: 4700 }]);

  const individual = await runNode({
    type: 'aggregate',
    parameters: { mode: 'individualFields', fields: ['total'] },
    items,
  });
  assert.deepStrictEqual(individual.out, [{ total: [1420, 2100, 1180] }]);

  const all = await runNode({
    type: 'aggregate', parameters: { mode: 'allItemData', field: 'rows' }, items,
  });
  assert.deepStrictEqual(all.out, [{ rows: items }]);
});

test('aggregate: min/max/avg/concat', async () => {
  const { out } = await runNode({
    type: 'aggregate',
    parameters: {
      mode: 'summarize',
      outputs: [
        { as: 'lo', op: 'min', field: 'n' }, { as: 'hi', op: 'max', field: 'n' },
        { as: 'mean', op: 'avg', field: 'n' }, { as: 'all', op: 'concat', field: 'n' },
      ],
    },
    items: [{ n: 2 }, { n: 4 }, { n: 6 }],
  });
  assert.deepStrictEqual(out, [{ lo: 2, hi: 6, mean: 4, all: '2, 4, 6' }]);
});

test('set: keepOnlySet decides whether incoming fields survive', async () => {
  const keep = await runNode({
    type: 'set',
    parameters: { keepOnlySet: false, fields: [{ name: 'status', value: 'flagged' }] },
    items: [{ id: 'AC-1', region: 'EU' }],
  });
  assert.deepStrictEqual(keep.out, [{ id: 'AC-1', region: 'EU', status: 'flagged' }]);

  const drop = await runNode({
    type: 'set',
    parameters: { keepOnlySet: true, fields: [{ name: 'status', value: 'flagged' }] },
    items: [{ id: 'AC-1', region: 'EU' }],
  });
  assert.deepStrictEqual(drop.out, [{ status: 'flagged' }]);
});

test('set: writes dotted paths and resolves expressions per item', async () => {
  const { out } = await runNode({
    type: 'set',
    parameters: {
      keepOnlySet: true,
      fields: [{ name: 'meta.label', value: '=order {{ $json.id }} / {{ $itemIndex }}' }],
    },
    items: [{ id: 'A' }, { id: 'B' }],
  });
  assert.deepStrictEqual(out, [
    { meta: { label: 'order A / 0' } },
    { meta: { label: 'order B / 1' } },
  ]);
});

test('a node never mutates its input items', async () => {
  const items = [{ id: 'A', nested: { keep: true } }];
  await runNode({
    type: 'set',
    parameters: { keepOnlySet: false, fields: [{ name: 'nested.keep', value: false }] },
    items,
  });
  assert.deepStrictEqual(items[0].nested, { keep: true }, 'caller-owned input was mutated');
});

test('disabled nodes pass items straight through', async () => {
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'f', name: 'Filter', type: 'filter', position: [200, 0], disabled: true,
        parameters: { combinator: 'and', conditions: [{ left: '={{ $json.region }}', op: 'equals', right: 'NOPE' }] },
      },
    ],
    connections: [{ from: 'src', fromOutput: 0, to: 'f', toInput: 0 }],
  };
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: [{ region: 'EU' }, { region: 'US' }] } },
    graph,
  );
  const rec = trace.nodes.find((n) => n.name === 'Filter');
  assert.strictEqual(rec.status, 'disabled');
  assert.strictEqual(rec.itemsOut, 2);
});

test('fan-out: one output feeding two nodes sends every item down both branches', async () => {
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'eu', name: 'EU', type: 'filter', position: [200, -100],
        parameters: { combinator: 'and', conditions: [{ left: '={{ $json.region }}', op: 'equals', right: 'EU' }] },
      },
      {
        id: 'us', name: 'US', type: 'filter', position: [200, 100],
        parameters: { combinator: 'and', conditions: [{ left: '={{ $json.region }}', op: 'equals', right: 'US' }] },
      },
    ],
    connections: [
      { from: 'src', fromOutput: 0, to: 'eu', toInput: 0 },
      { from: 'src', fromOutput: 0, to: 'us', toInput: 0 },
    ],
  };
  const trace = await executeWorkflow(
    {
      ...BARE_SCENARIO,
      triggerPayload: { manualTrigger: [{ region: 'EU' }, { region: 'US' }, { region: 'EU' }] },
    },
    graph,
  );
  const at = (name) => trace.nodes.find((n) => n.name === name);
  assert.strictEqual(at('EU').itemsIn, 3, 'both branches see the full item set');
  assert.strictEqual(at('US').itemsIn, 3);
  assert.strictEqual(at('EU').itemsOut, 2);
  assert.strictEqual(at('US').itemsOut, 1);
});

test('two upstream nodes wired into one input port concatenate', async () => {
  const graph = {
    nodes: [
      { id: 'a', name: 'A', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'b', name: 'B', type: 'scheduleTrigger', position: [0, 100], parameters: {} },
      { id: 'sink', name: 'Sink', type: 'noOp', position: [200, 50], parameters: {} },
    ],
    connections: [
      { from: 'a', fromOutput: 0, to: 'sink', toInput: 0 },
      { from: 'b', fromOutput: 0, to: 'sink', toInput: 0 },
    ],
  };
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: [{ x: 1 }, { x: 2 }] } },
    graph,
  );
  assert.strictEqual(trace.nodes.find((n) => n.name === 'Sink').itemsIn, 3);
});

test('a cycle is rejected before anything executes', async () => {
  const graph = {
    nodes: [
      { id: 'a', name: 'A', type: 'noOp', position: [0, 0], parameters: {} },
      { id: 'b', name: 'B', type: 'noOp', position: [100, 0], parameters: {} },
    ],
    connections: [
      { from: 'a', fromOutput: 0, to: 'b', toInput: 0 },
      { from: 'b', fromOutput: 0, to: 'a', toInput: 0 },
    ],
  };
  const trace = await executeWorkflow(BARE_SCENARIO, graph);
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /cycle/i);
});

test('duplicate node names are rejected — expressions address nodes by name', async () => {
  const graph = {
    nodes: [
      { id: 'a', name: 'Same', type: 'noOp', position: [0, 0], parameters: {} },
      { id: 'b', name: 'Same', type: 'noOp', position: [100, 0], parameters: {} },
    ],
    connections: [],
  };
  const trace = await executeWorkflow(BARE_SCENARIO, graph);
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /unique/i);
});

test('failures propagate as skipped, not as misleading noItems', async () => {
  const graph = {
    nodes: [
      { id: 'src', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'boom', name: 'Boom', type: 'stopAndError', position: [200, 0], parameters: { message: 'nope' } },
      { id: 'a', name: 'After', type: 'noOp', position: [400, 0], parameters: {} },
      { id: 'b', name: 'Further', type: 'noOp', position: [600, 0], parameters: {} },
    ],
    connections: [
      { from: 'src', fromOutput: 0, to: 'boom', toInput: 0 },
      { from: 'boom', fromOutput: 0, to: 'a', toInput: 0 },
      { from: 'a', fromOutput: 0, to: 'b', toInput: 0 },
    ],
  };
  const trace = await executeWorkflow(BARE_SCENARIO, graph);
  const status = (n) => trace.nodes.find((t) => t.name === n).status;
  assert.strictEqual(status('Boom'), 'error');
  assert.strictEqual(status('After'), 'skipped');
  assert.strictEqual(status('Further'), 'skipped');
});

test('the maxItems limit stops a runaway fan-out', async () => {
  const { record } = await runNode({
    type: 'splitOut',
    parameters: { field: 'v', include: 'noOtherFields' },
    items: [{ v: new Array(50).fill({ n: 1 }) }],
    scenario: { limits: { maxNodes: 40, maxItems: 10, maxExecutionMs: 5000 } },
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /more than 10 items/);
});
