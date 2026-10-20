'use strict';

/**
 * Loop Over Items — the only node in the engine that can send items back to a
 * node that already ran.
 *
 * Everywhere else the graph is a DAG and the walk is single-pass. A loop breaks
 * that, so the things worth pinning are not "does it iterate" but the four places
 * a bounded back-edge can go wrong:
 *
 *   1. the back-edge must be removed before ordering, and a cycle that is NOT a
 *      back-edge must still be rejected
 *   2. a body node runs once per batch but appears once in the trace, with the
 *      passes summed and counted — grading looks nodes up by name
 *   3. what leaves on `done` depends on whether the loop was closed, and both
 *      answers are legitimate
 *   4. it terminates: on a failing pass, on the iteration cap, and on the
 *      execution budget
 */

const test = require('node:test');
const assert = require('node:assert');
const { executeWorkflow, loopStructure } = require('../engine/scheduler');

const BARE_SCENARIO = {
  triggerPayload: { manualTrigger: {} },
  mockApi: { hosts: {} },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
};

const N = (id, name, type, parameters = {}) => ({ id, name, type, position: [0, 0], parameters });
const C = (from, to, fromOutput = 0, toInput = 0) => ({ from, fromOutput, to, toInput });

const DONE = 0;
const LOOP = 1;

/**
 * Trigger → Loop ═loop═> Tag ──┐   (back-edge wired unless closed:false)
 *                └═done═> After │
 *                 ▲─────────────┘
 */
async function runLoopGraph({
  items, batchSize = 1, closed = true, scenario = {}, untilNode = null,
} = {}) {
  const nodes = [
    N('t', 'Trigger', 'manualTrigger'),
    N('L', 'Loop', 'loopOverItems', { batchSize }),
    N('tag', 'Tag', 'set', {
      keepOnlySet: false,
      fields: [{ name: 'seen', value: '=yes' }],
    }),
    N('after', 'After', 'noOp'),
  ];
  const connections = [
    C('t', 'L'),
    C('L', 'tag', LOOP),
    C('L', 'after', DONE),
    ...(closed ? [C('tag', 'L')] : []),
  ];
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, ...scenario, triggerPayload: { manualTrigger: items } },
    { nodes, connections },
    untilNode ? { untilNode } : {},
  );
  const by = (name) => trace.nodes.find((n) => n.name === name);
  return { trace, by };
}

/* ── 1. the graph is a DAG again once the back-edge is out ──────────────── */

test('loopStructure finds the body and the back-edge', () => {
  const nodes = [
    N('t', 'Trigger', 'manualTrigger'),
    N('L', 'Loop', 'loopOverItems'),
    N('a', 'A', 'noOp'),
    N('b', 'B', 'noOp'),
    N('after', 'After', 'noOp'),
  ];
  const connections = [
    C('t', 'L'), C('L', 'a', LOOP), C('a', 'b'), C('b', 'L'), C('L', 'after', DONE),
  ];
  const { bodies, backEdges, nested } = loopStructure(nodes, connections);

  assert.deepStrictEqual([...bodies.get('L')].sort(), ['a', 'b']);
  assert.strictEqual(backEdges.size, 1);
  assert.strictEqual([...backEdges][0].from, 'b');
  assert.strictEqual(nested, null, 'one loop is not nested');
  assert.ok(!bodies.get('L').has('after'), 'the done branch is not the body');
});

test('a loop workflow runs; a cycle that is not a back-edge is still refused', async () => {
  const ok = await runLoopGraph({ items: [{ n: 1 }] });
  assert.strictEqual(ok.trace.status, 'completed');

  const cycle = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: [{}] } },
    {
      nodes: [N('t', 'Trigger', 'manualTrigger'), N('a', 'A', 'noOp'), N('b', 'B', 'noOp')],
      connections: [C('t', 'a'), C('a', 'b'), C('b', 'a')],
    },
  );
  assert.strictEqual(cycle.status, 'error');
  assert.match(cycle.errors[0].message, /cycle/);
  assert.match(cycle.errors[0].message, /Loop Over Items/);
});

test('a loop inside a loop is refused rather than half-supported', async () => {
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: [{}] } },
    {
      nodes: [
        N('t', 'Trigger', 'manualTrigger'),
        N('L1', 'Outer', 'loopOverItems', { batchSize: 1 }),
        N('L2', 'Inner', 'loopOverItems', { batchSize: 1 }),
        N('x', 'X', 'noOp'),
      ],
      connections: [C('t', 'L1'), C('L1', 'L2', LOOP), C('L2', 'x', LOOP), C('x', 'L2')],
    },
  );
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /"Inner"/);
  assert.match(trace.errors[0].message, /Nested loops are not supported/);
});

/* ── 2. one record per node, passes summed and counted ─────────────────── */

test('a body node runs once per batch but appears once, with the passes summed', async () => {
  const { by, trace } = await runLoopGraph({
    items: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
    batchSize: 1,
  });

  const named = trace.nodes.filter((n) => n.name === 'Tag');
  assert.strictEqual(named.length, 1, 'one record, not four');

  const tag = by('Tag');
  assert.strictEqual(tag.runs, 4, 'four passes');
  assert.strictEqual(tag.itemsIn, 4, 'one item per pass, summed');
  assert.strictEqual(tag.itemsOut, 4);
});

test('the batch size decides how many passes there are', async () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ n: i }));

  const ones = await runLoopGraph({ items, batchSize: 1 });
  assert.strictEqual(ones.by('Loop').batches, 6);
  assert.strictEqual(ones.by('Tag').runs, 6);

  const twos = await runLoopGraph({ items, batchSize: 2 });
  assert.strictEqual(twos.by('Loop').batches, 3);
  assert.strictEqual(twos.by('Tag').runs, 3);
  assert.strictEqual(twos.by('Tag').itemsIn, 6, 'every item still went through');

  const all = await runLoopGraph({ items, batchSize: 100 });
  assert.strictEqual(all.by('Loop').batches, 1, 'a batch larger than the list is one pass');
});

test('an uneven last batch is still a batch, and no item is lost', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ n: i }));
  const { by } = await runLoopGraph({ items, batchSize: 2 });
  assert.strictEqual(by('Loop').batches, 3, '2 + 2 + 1');
  assert.strictEqual(by('Tag').itemsIn, 5);
});

test('a nonsense batch size falls back to one rather than looping forever', async () => {
  for (const batchSize of [0, -3, 'ten', null]) {
    const { by, trace } = await runLoopGraph({ items: [{ n: 1 }, { n: 2 }], batchSize });
    assert.strictEqual(trace.status, 'completed', `batchSize=${JSON.stringify(batchSize)}`);
    assert.strictEqual(by('Loop').batches, 2);
  }
});

/* ── 3. what leaves on `done` ──────────────────────────────────────────── */

test('closed loop: done carries what came back, changed by the body', async () => {
  const { by } = await runLoopGraph({ items: [{ n: 1 }, { n: 2 }], batchSize: 1 });
  const loop = by('Loop');

  assert.strictEqual(loop.itemsOut, 2);
  assert.deepStrictEqual(
    loop.output.map((i) => i.json),
    [{ n: 1, seen: 'yes' }, { n: 2, seen: 'yes' }],
    'the body\'s change is visible on done',
  );
  assert.deepStrictEqual(by('After').itemsIn, 2);
});

test('open loop: done passes the original items through, body unchanged', async () => {
  const { by } = await runLoopGraph({
    items: [{ n: 1 }, { n: 2 }], batchSize: 1, closed: false,
  });
  const loop = by('Loop');

  assert.strictEqual(by('Tag').runs, 2, 'the body still ran for each batch');
  assert.deepStrictEqual(
    loop.output.map((i) => i.json),
    [{ n: 1 }, { n: 2 }],
    'nothing came back, so done is the input — untouched',
  );
});

test('the loop reports both ports, so `done` and `loop` are never conflated', async () => {
  const { by } = await runLoopGraph({ items: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  assert.deepStrictEqual(by('Loop').outputsByPort, [
    { port: 0, name: 'done', count: 3 },
    { port: 1, name: 'loop', count: 3 },
  ]);
});

test('nodes after the loop run once, after every batch has been through', async () => {
  const { by, trace } = await runLoopGraph({ items: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  assert.strictEqual(trace.nodes.filter((n) => n.name === 'After').length, 1);
  assert.strictEqual(by('After').runs, undefined, 'it did not repeat');
  assert.strictEqual(by('After').itemsIn, 3);
});

/* ── 4. it terminates ──────────────────────────────────────────────────── */

test('a failing pass stops the loop instead of repeating the error', async () => {
  // Ten items, so a loop that did not stop would report ten identical failures
  // and bury the first one.
  const trace = await executeWorkflow(
    {
      ...BARE_SCENARIO,
      triggerPayload: { manualTrigger: Array.from({ length: 10 }, (_, i) => ({ n: i })) },
    },
    {
      nodes: [
        N('t', 'Trigger', 'manualTrigger'),
        N('L', 'Loop', 'loopOverItems', { batchSize: 1 }),
        // Sorting on a field no item has is an error, every pass.
        N('boom', 'Boom', 'sort', { type: 'fields', fields: [{ field: 'nope', order: 'ascending' }] }),
      ],
      connections: [C('t', 'L'), C('L', 'boom', LOOP), C('boom', 'L')],
    },
  );
  const boom = trace.nodes.find((n) => n.name === 'Boom');
  const loop = trace.nodes.find((n) => n.name === 'Loop');

  assert.strictEqual(trace.status, 'error');
  assert.strictEqual(boom.runs, undefined, 'it failed on the first pass and was not retried');
  assert.match(loop.error, /Stopped on pass 1/);
  assert.match(loop.error, /"Boom"/);
});

test('the iteration cap fails loudly rather than silently running out of time', async () => {
  const { by, trace } = await runLoopGraph({
    items: Array.from({ length: 50 }, (_, i) => ({ n: i })),
    batchSize: 1,
    scenario: { limits: { ...BARE_SCENARIO.limits, maxLoopIterations: 5 } },
  });

  assert.strictEqual(trace.status, 'error');
  assert.match(by('Loop').error, /ran 5 times without finishing/);
  assert.match(by('Loop').error, /batch size/);
});

/* ── the passes are visible, not implied ───────────────────────────────── */

test('the loop reports before its own body, so the run log reads in order', async () => {
  const { trace } = await runLoopGraph({ items: [{ n: 1 }, { n: 2 }] });
  const names = trace.nodes.map((n) => n.name);
  assert.deepStrictEqual(names, ['Trigger', 'Loop', 'Tag', 'After'],
    'the loop must not appear below the nodes it drove');
});

test('the graded report names the pass count, or three passes look like one', async () => {
  const { formatReport } = require('../grading/format');
  const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const nodes = [
    N('t', 'Trigger', 'manualTrigger'),
    N('L', 'Loop', 'loopOverItems', { batchSize: 1 }),
    N('tag', 'Tag', 'set', { keepOnlySet: false, fields: [{ name: 'seen', value: '=yes' }] }),
  ];
  const connections = [C('t', 'L'), C('L', 'tag', LOOP), C('tag', 'L')];
  const graph = { nodes, connections };
  const trace = await executeWorkflow(
    { ...BARE_SCENARIO, triggerPayload: { manualTrigger: items } }, graph,
  );

  const report = formatReport({
    scenario: BARE_SCENARIO, graph, trace, assertions: [], graphHash: trace.graphHash,
  });
  const line = report.split('\n').find((l) => l.includes('Tag') && l.includes('in='));
  assert.match(line, /×3 passes/);
});

/* ── Execute Node inside a loop ────────────────────────────────────────── */

test('running one node inside a loop runs the loop that feeds it, for one pass', async () => {
  const { by, trace } = await runLoopGraph({
    items: [{ n: 1 }, { n: 2 }, { n: 3 }],
    batchSize: 1,
    untilNode: 'tag',
  });

  assert.strictEqual(trace.partial, true);
  assert.ok(by('Loop'), 'the loop had to run — a body node has no input without it');
  assert.strictEqual(by('Tag').runs, undefined, 'one pass only');
  assert.strictEqual(by('Tag').itemsIn, 1);
  assert.ok(!by('After'), 'nothing after the loop ran');
});
