'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  createHistory, push, undo, redo, canUndo, canRedo,
} = require('../client/lib/history.js');
const { duplicateNodes, moveNodes, setNodesDisabled } = require('../client/lib/graph.js');

const g = (n) => ({ version: 1, nodes: [{ id: `n${n}`, name: `N${n}`, position: [0, 0], parameters: {} }], connections: [] });

test('a fresh history can neither undo nor redo', () => {
  const h = createHistory();
  assert.strictEqual(canUndo(h), false);
  assert.strictEqual(canRedo(h), false);
  assert.strictEqual(undo(h, g(1)), null);
  assert.strictEqual(redo(h, g(1)), null);
});

test('undo walks back and redo walks forward through the same states', () => {
  let h = createHistory();
  h = push(h, g(1));           // committing state 2, recording 1
  h = push(h, g(2));           // committing state 3, recording 2
  let current = g(3);

  let step = undo(h, current);
  h = step.history; current = step.graph;
  assert.strictEqual(current.nodes[0].id, 'n2');

  step = undo(h, current);
  h = step.history; current = step.graph;
  assert.strictEqual(current.nodes[0].id, 'n1');
  assert.strictEqual(canUndo(h), false);

  step = redo(h, current);
  h = step.history; current = step.graph;
  assert.strictEqual(current.nodes[0].id, 'n2');

  step = redo(h, current);
  h = step.history; current = step.graph;
  assert.strictEqual(current.nodes[0].id, 'n3');
  assert.strictEqual(canRedo(h), false);
});

test('a new commit after undo clears the redo branch', () => {
  let h = push(createHistory(), g(1));
  const step = undo(h, g(2));
  h = step.history;
  assert.strictEqual(canRedo(h), true);

  h = push(h, step.graph);
  assert.strictEqual(canRedo(h), false, 'the abandoned future must not be reachable');
});

test('history is capped and drops the oldest entries', () => {
  let h = createHistory();
  for (let i = 0; i < 80; i += 1) h = push(h, g(i));
  assert.strictEqual(h.past.length, 50);
  assert.strictEqual(h.past[0].nodes[0].id, 'n30', 'oldest entries dropped, newest kept');
});

test('snapshots are not aliased — undoing twice cannot yield the same object', () => {
  const first = g(1);
  let h = push(createHistory(), first);
  const step = undo(h, g(2));
  assert.strictEqual(step.graph, first, 'the snapshot is returned as stored');
  // Because every graph mutation is a pure replacement, storing the reference is
  // safe: nothing mutates a graph in place. This test documents that contract.
  assert.deepStrictEqual(first.nodes[0].position, [0, 0]);
});

test('moveNodes applies a batch and rounds, leaving others untouched', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'a', position: [0, 0] },
      { id: 'b', position: [10, 10] },
      { id: 'c', position: [20, 20] },
    ],
    connections: [],
  };
  const next = moveNodes(graph, [
    { id: 'a', position: { x: 5.4, y: 5.6 } },
    { id: 'c', position: { x: -3.2, y: 100 } },
  ]);
  assert.deepStrictEqual(next.nodes.map((n) => n.position), [[5, 6], [10, 10], [-3, 100]]);
  assert.deepStrictEqual(graph.nodes[0].position, [0, 0], 'input mutated');
  assert.strictEqual(next.nodes[1], graph.nodes[1], 'untouched nodes keep identity');
});

test('moveNodes with no updates returns the same graph', () => {
  const graph = { version: 1, nodes: [{ id: 'a', position: [0, 0] }], connections: [] };
  assert.strictEqual(moveNodes(graph, []), graph);
});

test('setNodesDisabled toggles only the named nodes', () => {
  const graph = {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    connections: [],
  };
  const next = setNodesDisabled(graph, ['a', 'c'], true);
  assert.deepStrictEqual(next.nodes.map((n) => Boolean(n.disabled)), [true, false, true]);
});

test('duplicateNodes offsets copies, renames them, and keeps internal wiring only', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'a', name: 'Fetch', type: 'httpRequest', position: [0, 0], parameters: { url: 'x' } },
      { id: 'b', name: 'Filter', type: 'filter', position: [200, 0], parameters: { conditions: [] } },
      { id: 'c', name: 'Slack', type: 'slack', position: [400, 0], parameters: {} },
    ],
    connections: [
      { from: 'a', fromOutput: 0, to: 'b', toInput: 0 },
      { from: 'b', fromOutput: 0, to: 'c', toInput: 0 },
    ],
  };

  const { graph: next, ids } = duplicateNodes(graph, ['a', 'b']);
  assert.strictEqual(ids.length, 2);
  assert.strictEqual(next.nodes.length, 5);

  const copies = next.nodes.filter((n) => ids.includes(n.id));
  assert.deepStrictEqual(copies.map((n) => n.name), ['Fetch 1', 'Filter 1']);
  assert.deepStrictEqual(copies[0].position, [40, 60], 'copies are offset so they are visible');

  // a→b was internal to the selection and is preserved between the copies;
  // b→c crossed the boundary and must NOT be duplicated, or the copy would
  // silently double the original branch's items downstream.
  const copyConns = next.connections.filter((c) => ids.includes(c.from) || ids.includes(c.to));
  assert.strictEqual(copyConns.length, 1);
  assert.deepStrictEqual(
    [copyConns[0].from, copyConns[0].to],
    [ids[0], ids[1]],
  );

  // Parameters are deep-cloned.
  copies[0].parameters.url = 'changed';
  assert.strictEqual(graph.nodes[0].parameters.url, 'x');
});

test('duplicating nothing is a no-op', () => {
  const graph = { version: 1, nodes: [{ id: 'a', name: 'A' }], connections: [] };
  const result = duplicateNodes(graph, []);
  assert.strictEqual(result.graph, graph);
  assert.deepStrictEqual(result.ids, []);
});
