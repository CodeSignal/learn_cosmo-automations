'use strict';

/**
 * Canvas state transitions.
 *
 * These are the mutations every mouse gesture funnels through, so testing them
 * headlessly covers the canvas's correctness without driving a browser.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  addConnection, addNode, moveNode, removeConnection, removeNodes,
  renameNode, setNodeParameter, uniqueName, wouldCycle,
} = require('../client/lib/graph.js');

const FILTER = {
  type: 'filter', label: 'Filter', usesCredential: false,
  defaults: { combinator: 'and', conditions: [{ left: '={{ $json.field }}', op: 'equals', right: '' }] },
};
const HTTP = { type: 'httpRequest', label: 'HTTP Request', usesCredential: true, defaults: { method: 'GET' } };

const empty = () => ({ version: 1, nodes: [], connections: [] });

test('adding a node gives it a unique id, a unique name and cloned defaults', () => {
  let graph = empty();
  ({ graph } = addNode(graph, FILTER, { x: 100, y: 200 }));
  ({ graph } = addNode(graph, FILTER, { x: 300, y: 200 }));

  assert.strictEqual(graph.nodes.length, 2);
  assert.notStrictEqual(graph.nodes[0].id, graph.nodes[1].id);
  assert.deepStrictEqual(graph.nodes.map((n) => n.name), ['Filter', 'Filter 1']);

  // Defaults must be cloned, or two nodes would share one conditions array.
  graph.nodes[0].parameters.conditions[0].right = 'EU';
  assert.strictEqual(graph.nodes[1].parameters.conditions[0].right, '');
  assert.strictEqual(FILTER.defaults.conditions[0].right, '', 'the palette entry was mutated');
});

test('only credential-using nodes get a credentialId slot', () => {
  let graph = empty();
  ({ graph } = addNode(graph, HTTP, { x: 0, y: 0 }));
  assert.strictEqual(graph.nodes[0].credentialId, null);

  let other = empty();
  ({ graph: other } = addNode(other, FILTER, { x: 0, y: 0 }));
  assert.ok(!('credentialId' in other.nodes[0]));
});

test('uniqueName never collides', () => {
  const graph = { nodes: [{ name: 'Filter' }, { name: 'Filter 1' }, { name: 'Filter 2' }] };
  assert.strictEqual(uniqueName(graph, 'Filter'), 'Filter 3');
  assert.strictEqual(uniqueName(graph, 'Slack'), 'Slack');
});

test('fan-in: many nodes may feed one input port, and their items concatenate', () => {
  let graph = {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    connections: [],
  };
  graph = addConnection(graph, { from: 'a', to: 'c' });
  graph = addConnection(graph, { from: 'b', to: 'c' });

  assert.strictEqual(graph.connections.length, 2, 'the second wire must not replace the first');
  assert.deepStrictEqual(graph.connections.map((x) => x.from), ['a', 'b']);
});

test('fan-out: one output may feed many nodes', () => {
  let graph = {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    connections: [],
  };
  graph = addConnection(graph, { from: 'a', to: 'b' });
  graph = addConnection(graph, { from: 'a', to: 'c' });

  assert.strictEqual(graph.connections.length, 2);
  assert.deepStrictEqual(graph.connections.map((x) => x.to), ['b', 'c']);
});

test('distinct input ports coexist, and duplicates are idempotent', () => {
  let graph = { version: 1, nodes: [{ id: 'a' }, { id: 'b' }], connections: [] };
  graph = addConnection(graph, { from: 'a', to: 'b', toInput: 0 });
  graph = addConnection(graph, { from: 'a', to: 'b', toInput: 1 });
  assert.strictEqual(graph.connections.length, 2);

  graph = addConnection(graph, { from: 'a', to: 'b', toInput: 1 });
  assert.strictEqual(graph.connections.length, 2, 'adding the same connection twice');
});

test('a node cannot connect to itself', () => {
  const graph = { version: 1, nodes: [{ id: 'a' }], connections: [] };
  assert.strictEqual(addConnection(graph, { from: 'a', to: 'a' }).connections.length, 0);
});

test('wouldCycle catches direct and transitive loops', () => {
  const graph = {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    connections: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  };
  assert.strictEqual(wouldCycle(graph, 'c', 'a'), true, 'c → a closes the loop');
  assert.strictEqual(wouldCycle(graph, 'b', 'a'), true, 'b → a closes a shorter loop');
  assert.strictEqual(wouldCycle(graph, 'a', 'c'), false, 'a → c is a legal shortcut');
});

test('deleting a node also deletes every connection touching it', () => {
  let graph = {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    connections: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  };
  graph = removeNodes(graph, ['b']);
  assert.deepStrictEqual(graph.nodes.map((n) => n.id), ['a', 'c']);
  assert.strictEqual(graph.connections.length, 0);
});

test('removeConnection only removes the matching port pair', () => {
  let graph = {
    version: 1,
    nodes: [{ id: 'a' }, { id: 'b' }],
    connections: [
      { from: 'a', fromOutput: 0, to: 'b', toInput: 0 },
      { from: 'a', fromOutput: 1, to: 'b', toInput: 1 },
    ],
  };
  graph = removeConnection(graph, { from: 'a', fromOutput: 0, to: 'b', toInput: 0 });
  assert.strictEqual(graph.connections.length, 1);
  assert.strictEqual(graph.connections[0].fromOutput, 1);
});

test('renaming a node rewrites expressions that reference it by name', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'a', name: 'Fetch Orders', parameters: {} },
      {
        id: 'b',
        name: 'Notify',
        parameters: {
          text: '=Order {{ $node["Fetch Orders"].json.id }} / {{ $("Fetch Orders").item.json.total }}',
          nested: { deep: ["={{ $node['Fetch Orders'].json.x }}"] },
        },
      },
    ],
    connections: [],
  };

  const renamed = renameNode(graph, 'a', 'Get Orders');
  assert.strictEqual(renamed.nodes[0].name, 'Get Orders');
  assert.strictEqual(
    renamed.nodes[1].parameters.text,
    '=Order {{ $node["Get Orders"].json.id }} / {{ $("Get Orders").item.json.total }}',
  );
  assert.strictEqual(
    renamed.nodes[1].parameters.nested.deep[0],
    "={{ $node['Get Orders'].json.x }}",
    'single-quoted references are rewritten too',
  );
});

test('a rename to an existing name or to blank is rejected', () => {
  const graph = {
    version: 1,
    nodes: [{ id: 'a', name: 'One', parameters: {} }, { id: 'b', name: 'Two', parameters: {} }],
    connections: [],
  };
  assert.strictEqual(renameNode(graph, 'a', 'Two').nodes[0].name, 'One', 'duplicate rejected');
  assert.strictEqual(renameNode(graph, 'a', '   ').nodes[0].name, 'One', 'blank rejected');
  assert.strictEqual(renameNode(graph, 'a', 'Three').nodes[0].name, 'Three', 'valid accepted');
});

test('setNodeParameter and moveNode do not mutate the previous graph', () => {
  const graph = {
    version: 1,
    nodes: [{ id: 'a', name: 'A', position: [0, 0], parameters: { x: 1 } }],
    connections: [],
  };
  const changed = setNodeParameter(graph, 'a', 'x', 2);
  assert.strictEqual(graph.nodes[0].parameters.x, 1, 'original mutated');
  assert.strictEqual(changed.nodes[0].parameters.x, 2);

  const moved = moveNode(graph, 'a', { x: 12.6, y: 30.2 });
  assert.deepStrictEqual(graph.nodes[0].position, [0, 0], 'original mutated');
  assert.deepStrictEqual(moved.nodes[0].position, [13, 30], 'positions are rounded');
});
