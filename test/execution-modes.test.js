'use strict';

/**
 * Partial runs ("Execute Node"), simulated latency, and progress reporting.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run } = require('../engine');
const { executeWorkflow, ancestorsOf } = require('../engine/scheduler');

const DIR = path.join(__dirname, '..', 'scenarios', 'eu-orders');
const scenario = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));
const graph = JSON.parse(fs.readFileSync(path.join(DIR, 'reference_solution.json'), 'utf8'));

/* ── Execute Node ──────────────────────────────────────────────────────── */

test('ancestorsOf walks the whole upstream, not just direct parents', () => {
  const connections = [
    { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' },
    { from: 'x', to: 'c' },
  ];
  assert.deepStrictEqual([...ancestorsOf('d', connections)].sort(), ['a', 'b', 'c', 'x']);
  assert.deepStrictEqual([...ancestorsOf('a', connections)], []);
});

test('untilNode runs that node and everything it depends on, and nothing else', async () => {
  const trace = await run(scenario, graph, { untilNode: 'n4' }); // Filter High Value EU
  const ran = trace.nodes.map((n) => n.name);

  assert.deepStrictEqual(ran, [
    'When clicking Execute', 'Fetch Orders', 'Split Out Orders', 'Filter High Value EU',
  ]);
  assert.ok(!ran.includes('Aggregate Totals'), 'downstream nodes must not run');
  assert.ok(!ran.includes('Notify Ops'));

  // The work it did do is identical to the full run's.
  const filter = trace.nodes.find((n) => n.name === 'Filter High Value EU');
  assert.strictEqual(filter.itemsIn, 12);
  assert.strictEqual(filter.itemsOut, 3);
});

test('a partial run is flagged, so it can never be mistaken for the graded run', async () => {
  const partial = await run(scenario, graph, { untilNode: 'n4' });
  assert.strictEqual(partial.partial, true);
  assert.strictEqual(partial.untilNode, 'n4');

  const full = await run(scenario, graph);
  assert.strictEqual(full.partial, undefined, 'a full run must not be flagged partial');
});

test('a partial run treats the requested node as the leaf', async () => {
  const trace = await run(scenario, graph, { untilNode: 'n3' }); // Split Out Orders
  assert.deepStrictEqual(Object.keys(trace.finalPayloads), ['Split Out Orders']);
  assert.strictEqual(trace.finalPayloads['Split Out Orders'].length, 12);
});

test('untilNode on a trigger runs just the trigger', async () => {
  const trace = await run(scenario, graph, { untilNode: 'n1' });
  assert.deepStrictEqual(trace.nodes.map((n) => n.name), ['When clicking Execute']);
});

test('untilNode pointing at a deleted node fails cleanly', async () => {
  const trace = await run(scenario, graph, { untilNode: 'does-not-exist' });
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /no longer part of the workflow/);
});

test('a partial run still carries the graph hash of the whole graph', async () => {
  const partial = await run(scenario, graph, { untilNode: 'n4' });
  const full = await run(scenario, graph);
  assert.strictEqual(partial.graphHash, full.graphHash);
});

/* ── simulated latency ─────────────────────────────────────────────────── */

test('latency is off by default, so grading and tests stay fast', async () => {
  const started = Date.now();
  const trace = await run(scenario, graph);
  assert.ok(Date.now() - started < 400, `expected a fast run, took ${Date.now() - started}ms`);
  assert.strictEqual(trace.simulatedMs, 0);
});

test('latency, when enabled, changes only the clock — never the result', async () => {
  const instant = await run(scenario, graph);
  const slow = await run(scenario, graph, { simulateLatency: true });

  assert.ok(slow.simulatedMs > 300, `expected simulated waiting, got ${slow.simulatedMs}ms`);

  // Everything except timing must be byte-identical.
  const strip = (trace) => JSON.stringify(
    trace,
    (key, value) => (['durationMs', 'ms', 'simulatedMs'].includes(key) ? 0 : value),
  );
  assert.strictEqual(strip(instant), strip(slow));
});

test('simulated waiting does not consume the execution time budget', async () => {
  // A budget far below the simulated wait must still complete: the limit guards
  // real compute, not theatre.
  const tight = { ...scenario, limits: { ...scenario.limits, maxExecutionMs: 200 } };
  const trace = await run(tight, graph, { simulateLatency: true });
  assert.strictEqual(trace.status, 'completed');
  assert.ok(trace.simulatedMs > 200);
});

test('total simulated waiting is capped', async () => {
  const capped = { ...scenario, limits: { ...scenario.limits, maxSimulatedMs: 120 } };
  const trace = await run(capped, graph, { simulateLatency: true });
  assert.ok(trace.simulatedMs <= 120, `expected ≤120ms, got ${trace.simulatedMs}`);
});

test('a node handling more items waits longer than one handling few', async () => {
  const perItemNode = {
    nodes: [
      { id: 't', name: 'T', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'f', name: 'F', type: 'filter', position: [200, 0],
        parameters: { combinator: 'and', conditions: [{ left: '={{ $json.n }}', op: 'gt', right: 0 }] },
      },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'f', toInput: 0 }],
  };
  const few = { ...scenario, triggerPayload: { manualTrigger: [{ n: 1 }] } };
  const many = { ...scenario, triggerPayload: { manualTrigger: Array.from({ length: 20 }, (_, i) => ({ n: i + 1 })) } };

  const a = await executeWorkflow(few, perItemNode, { simulateLatency: true });
  const b = await executeWorkflow(many, perItemNode, { simulateLatency: true });
  assert.ok(b.simulatedMs > a.simulatedMs,
    `20 items (${b.simulatedMs}ms) should cost more than 1 (${a.simulatedMs}ms)`);
});

/* ── progress reporting ────────────────────────────────────────────────── */

test('every node reports a start and a matching end', async () => {
  const events = [];
  const trace = await run(scenario, graph, { onProgress: (e) => events.push(e) });

  const starts = events.filter((e) => e.type === 'nodeStart').map((e) => e.id);
  const ends = events.filter((e) => e.type === 'nodeEnd').map((e) => e.id);

  assert.deepStrictEqual(starts, ends, 'a node that lights up must also light down');
  assert.strictEqual(starts.length, trace.nodes.length);
});

test('start always precedes the matching end', async () => {
  const events = [];
  await run(scenario, graph, { onProgress: (e) => events.push(e) });

  const open = new Set();
  for (const event of events) {
    if (event.type === 'nodeStart') {
      assert.ok(!open.has(event.id), `${event.name} started twice`);
      open.add(event.id);
    } else if (event.type === 'nodeEnd') {
      assert.ok(open.has(event.id), `${event.name} ended without starting`);
      open.delete(event.id);
    }
  }
  assert.strictEqual(open.size, 0, 'a node was left running');
});

test('a failing node still reports its end, so the UI cannot hang', async () => {
  const noCredential = JSON.parse(JSON.stringify(graph));
  delete noCredential.nodes.find((n) => n.type === 'httpRequest').credentialId;

  const events = [];
  await run(scenario, noCredential, { onProgress: (e) => events.push(e) });

  const ends = events.filter((e) => e.type === 'nodeEnd');
  const starts = events.filter((e) => e.type === 'nodeStart');
  assert.strictEqual(starts.length, ends.length);
  assert.ok(ends.some((e) => e.status === 'error'), 'the failure should be reported');
  assert.ok(ends.some((e) => e.status === 'skipped'), 'skips should be reported too');
});

test('end events carry the item counts the canvas needs', async () => {
  const events = [];
  await run(scenario, graph, { onProgress: (e) => events.push(e) });
  const split = events.find((e) => e.type === 'nodeEnd' && e.name === 'Split Out Orders');
  assert.strictEqual(split.itemsIn, 1);
  assert.strictEqual(split.itemsOut, 12);
  assert.strictEqual(split.status, 'success');
});
