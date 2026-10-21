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

/* ── Execute previous nodes ────────────────────────────────────────────── */

test('inputOnly runs the nodes before the target and records its input without running it', async () => {
  const trace = await run(scenario, graph, { untilNode: 'n4', inputOnly: true });
  assert.deepStrictEqual(trace.nodes.map((n) => n.name), [
    'When clicking Execute', 'Fetch Orders', 'Split Out Orders', 'Filter High Value EU',
  ]);
  const filter = trace.nodes.find((n) => n.id === 'n4');
  assert.strictEqual(filter.status, 'notRun');
  assert.strictEqual(filter.itemsIn, 12);
  assert.strictEqual(filter.inputSample.length, 12);
  assert.strictEqual(filter.itemsOut, 0);
  assert.strictEqual(filter.output, undefined, 'the target produced nothing, because it did not run');
  assert.deepStrictEqual([trace.partial, trace.inputOnly], [true, true]);
  assert.deepStrictEqual(Object.keys(trace.finalPayloads), ['Split Out Orders']);
});

test('inputOnly never performs the target node\'s side effect', async () => {
  const trace = await run(scenario, graph, { untilNode: 'n6', inputOnly: true }); // Notify Ops
  assert.ok(!trace.httpCalls.some((c) => /slack/.test(c.path)), 'Slack must not be called');
  const slack = trace.nodes.find((n) => n.id === 'n6');
  assert.deepStrictEqual([slack.status, slack.itemsIn], ['notRun', 1]);
});

test('inputOnly without a target node is an ordinary full run', async () => {
  const trace = await run(scenario, graph, { inputOnly: true });
  assert.strictEqual(trace.partial, undefined);
  assert.strictEqual(trace.inputOnly, undefined);
  assert.ok(trace.nodes.every((n) => n.status === 'success'));
});

test('every record keeps a sample of each output port, not just the first', async () => {
  const ifGraph = JSON.parse(fs.readFileSync(path.join(DIR, 'variants', 'correct-3-if-branch.json'), 'utf8'));
  const trace = await run(scenario, ifGraph);
  const branch = trace.nodes.find((n) => n.id === 'n4');
  assert.strictEqual(branch.outputSamples.length, 2);
  assert.strictEqual(branch.outputSamples[0].length, 3);
  assert.strictEqual(branch.outputSamples[1].length, 9, 'the false branch is sampled too');
  assert.deepStrictEqual(branch.outputSamples[0], branch.output);
});

/* ── what is shown running ─────────────────────────────────────────────── */

/** Node ids that announced a start, in order. */
async function startsOf(scn, g, options) {
  const starts = [];
  const trace = await run(scn, g, { ...options, onProgress: (e) => { if (e.type === 'nodeStart') starts.push(e.id); } });
  return { starts, trace };
}

test('Execute Node shows only that node running; what feeds it replays silently', async () => {
  const { starts, trace } = await startsOf(scenario, graph, { untilNode: 'n4' });
  assert.deepStrictEqual(starts, ['n4']);
  assert.strictEqual(trace.nodes.length, 4, 'the upstream still ran — its output is what n4 worked on');
});

test('Execute previous nodes shows only the node directly before the target running', async () => {
  const { starts, trace } = await startsOf(scenario, graph, { untilNode: 'n5', inputOnly: true });
  assert.deepStrictEqual(starts, ['n4']);
  assert.strictEqual(trace.nodes.find((n) => n.id === 'n5').status, 'notRun');
});

test('answering an approval carries on from it, and the run is still a faithful replay', async () => {
  const dir = path.join(__dirname, '..', 'scenarios', 'ticket-triage-ai');
  const ai = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference_solution.json'), 'utf8'));
  const decisions = { 'Confirm Escalation': 'approve' };
  const options = { interactive: true, decisions };

  const { starts, trace: resumed } = await startsOf(ai, ref, { ...options, resumeFrom: 'Confirm Escalation' });
  const shown = starts.map((id) => ref.nodes.find((n) => n.id === id).name);
  assert.deepStrictEqual(shown.slice(0, 1), ['Confirm Escalation'], 'nothing before the approval is shown again');
  assert.ok(!shown.includes('Classify Ticket'));

  // Grading compares the saved run with a fresh one, timings aside.
  const fresh = await run(ai, ref, options);
  const comparable = (t) => JSON.stringify(t, (k, v) => (['ms', 'durationMs', 'simulatedMs'].includes(k) ? undefined : v));
  assert.strictEqual(comparable(resumed), comparable(fresh));
});

/* ── reusing the last run ──────────────────────────────────────────────── */

const clone = (v) => JSON.parse(JSON.stringify(v));
/** Ids of the nodes that actually ran, in order. */
const ranIds = (trace) => trace.nodes.filter((n) => !n.reused && n.status !== 'notRun').map((n) => n.id);

test('after a full run, Execute Node runs only that node, on its parents\' last output', async () => {
  const cache = new Map();
  await run(scenario, graph, { cache });
  const trace = await run(scenario, graph, { untilNode: 'n4', cache });
  assert.deepStrictEqual(ranIds(trace), ['n4']);
  assert.ok(!trace.httpCalls.length, 'the fetch was not repeated');
  const filter = trace.nodes.find((n) => n.id === 'n4');
  assert.deepStrictEqual([filter.itemsIn, filter.itemsOut], [12, 3]);
  assert.ok(trace.nodes.find((n) => n.id === 'n3').reused, 'the parent shows, from the last run');
});

test('Execute previous nodes runs only the node directly before, on cached output', async () => {
  const cache = new Map();
  await run(scenario, graph, { cache });
  const trace = await run(scenario, graph, { untilNode: 'n5', inputOnly: true, cache });
  assert.deepStrictEqual(ranIds(trace), ['n4']);
  assert.strictEqual(trace.nodes.find((n) => n.id === 'n5').inputSample.length, 3);
});

test('a changed parent is run again instead of reused', async () => {
  const cache = new Map();
  await run(scenario, graph, { cache });
  const edited = clone(graph);
  edited.nodes.find((n) => n.id === 'n2').parameters.url += '&page=1';
  const trace = await run(scenario, edited, { untilNode: 'n4', cache });
  assert.deepStrictEqual(ranIds(trace), ['n2', 'n3', 'n4'], 'the fetch changed, so it and everything after it run');
});

test('with nothing cached yet, Execute Node runs what it needs', async () => {
  const trace = await run(scenario, graph, { untilNode: 'n4', cache: new Map() });
  assert.deepStrictEqual(ranIds(trace), ['n1', 'n2', 'n3', 'n4']);
});

test('a full run never reuses, so the graded trace is unaffected by the cache', async () => {
  const cache = new Map();
  await run(scenario, graph, { cache });
  const again = await run(scenario, graph, { cache });
  const plain = await run(scenario, graph);
  const comparable = (t) => JSON.stringify(t, (k, v) => (['ms', 'durationMs', 'simulatedMs'].includes(k) ? undefined : v));
  assert.strictEqual(comparable(again), comparable(plain));
});

test('nothing in or after a loop is reused', async () => {
  const dir = path.join(__dirname, '..', 'scenarios', 'payment-recovery');
  const pr = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(dir, 'reference_solution.json'), 'utf8'));
  const cache = new Map();
  await run(pr, ref, { cache });
  assert.ok(!cache.has('n11') && !cache.has('n12'), 'the loop and its body are not cached');
  const trace = await run(pr, ref, { untilNode: 'n12', cache });
  assert.ok(ranIds(trace).includes('n11'), 'a node inside the loop still runs its loop');
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
