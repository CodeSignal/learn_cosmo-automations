'use strict';

/**
 * The input panel of a node that has not run yet, rebuilt from the last run of
 * the nodes feeding it — so wiring up a new node after a run shows its input.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run } = require('../engine');
const { lastRunInput } = require('../shared/last-run-input.mjs');

const DIR = path.join(__dirname, '..', 'scenarios', 'eu-orders');
const scenario = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

/** The graph after the run, with a node added and wired to `from` on `fromOutput`. */
const withNewNode = (graph, from, fromOutput = 0) => ({
  ...graph,
  nodes: [...graph.nodes, { id: 'new', name: 'New Node', type: 'noOp', parameters: {}, position: [0, 0] }],
  connections: [...graph.connections, { from, fromOutput, to: 'new', toInput: 0 }],
});

test('a node wired up after the run shows what its parent produced', async () => {
  const graph = read('reference_solution.json');
  const trace = await run(scenario, graph);
  const items = lastRunInput(withNewNode(graph, 'n4'), trace, 'new'); // after the Filter
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items, trace.nodes.find((n) => n.id === 'n4').output);
});

test('it reads the port the connection leaves from, such as an If\'s false branch', async () => {
  const graph = read('variants/correct-3-if-branch.json');
  const trace = await run(scenario, graph);
  const items = lastRunInput(withNewNode(graph, 'n4', 1), trace, 'new');
  assert.strictEqual(items.length, 9);
  assert.ok(items.every((i) => !(i.json.region === 'EU' && i.json.total > 1000)));
});

test('several connections into one input are combined, as the engine does', async () => {
  const graph = read('reference_solution.json');
  const trace = await run(scenario, graph);
  const wired = withNewNode(graph, 'n4');
  wired.connections.push({ from: 'n5', fromOutput: 0, to: 'new', toInput: 0 });
  assert.strictEqual(lastRunInput(wired, trace, 'new').length, 3 + 1);
});

test('it says nothing when it cannot know', async () => {
  const graph = read('reference_solution.json');
  const trace = await run(scenario, graph, { untilNode: 'n3' });
  assert.strictEqual(lastRunInput(withNewNode(graph, 'n5'), trace, 'new'), null, 'the parent never ran');
  assert.strictEqual(lastRunInput(graph, trace, 'n1'), null, 'nothing is connected');
  assert.strictEqual(lastRunInput(graph, null, 'n2'), null, 'nothing has run');
});
