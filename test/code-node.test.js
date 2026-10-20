'use strict';

/**
 * The Code node.
 *
 * Its job is to run candidate-authored JavaScript over the item list, so the
 * things worth testing are: does it see the right data in each mode, does it
 * accept the shapes people actually write, and does it fail with a message that
 * tells them what to change.
 *
 * The security boundary itself is tested in test/sandbox.test.js.
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run } = require('../engine');
const { initSandbox } = require('../engine/sandbox');

before(() => initSandbox());

const scenario = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'scenarios', 'eu-orders', 'scenario.json'), 'utf8',
));

/** Run a Code node over a fixed item list. */
async function runCode(jsCode, mode, items = [{ n: 1 }, { n: 2 }, { n: 3 }]) {
  const graph = {
    version: 1,
    nodes: [
      { id: 't', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'c', name: 'Code', type: 'code', position: [200, 0], parameters: { mode, jsCode } },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'c', toInput: 0 }],
  };
  const trace = await run({ ...scenario, triggerPayload: { manualTrigger: items } }, graph);
  const record = trace.nodes.find((n) => n.name === 'Code');
  return { record, out: (record.output || []).map((i) => i.json) };
}

/* ── modes ─────────────────────────────────────────────────────────────── */

test('all-items mode sees the whole list and returns a list', async () => {
  const { record, out } = await runCode(
    'let t = 0; for (const i of items) t += i.json.n; return [{ json: { total: t, count: items.length } }];',
    'runOnceForAllItems',
  );
  assert.strictEqual(record.status, 'success', record.error);
  assert.strictEqual(record.itemsIn, 3);
  assert.deepStrictEqual(out, [{ total: 6, count: 3 }]);
});

test('per-item mode runs once for each item', async () => {
  const { record, out } = await runCode(
    'return { json: { doubled: item.json.n * 2 } };',
    'runOncePerItem',
  );
  assert.strictEqual(record.status, 'success', record.error);
  assert.strictEqual(record.itemsOut, 3, 'three items in, three out');
  assert.deepStrictEqual(out, [{ doubled: 2 }, { doubled: 4 }, { doubled: 6 }]);
});

test('per-item mode exposes the right item each time, not just the first', async () => {
  const { out } = await runCode('return { json: { i: $itemIndex, n: item.json.n } };', 'runOncePerItem');
  assert.deepStrictEqual(out, [{ i: 0, n: 1 }, { i: 1, n: 2 }, { i: 2, n: 3 }]);
});

test('the mode is a parameter, so changing it changes the item count', async () => {
  const code = 'return [{ json: { seen: items.length } }];';
  const all = await runCode(code, 'runOnceForAllItems');
  const per = await runCode(code, 'runOncePerItem');
  assert.strictEqual(all.record.itemsOut, 1, 'one run over the list');
  assert.strictEqual(per.record.itemsOut, 3, 'one run per item');
});

test('$input is available as another spelling of the list', async () => {
  const { out } = await runCode(
    'return [{ json: { all: $input.all().length, first: $input.first().json.n } }];',
    'runOnceForAllItems',
  );
  assert.deepStrictEqual(out, [{ all: 3, first: 1 }]);
});

/* ── accepted and rejected result shapes ───────────────────────────────── */

test('a bare object is accepted as well as a { json } wrapper', async () => {
  // Returning bare objects is the most common thing people write, and failing on
  // it would teach nothing useful.
  const wrapped = await runCode('return [{ json: { a: 1 } }];', 'runOnceForAllItems');
  const bare = await runCode('return [{ a: 1 }];', 'runOnceForAllItems');
  assert.deepStrictEqual(wrapped.out, [{ a: 1 }]);
  assert.deepStrictEqual(bare.out, [{ a: 1 }]);
});

test('a single object is accepted where a list would do', async () => {
  const { out } = await runCode('return { json: { a: 1 } };', 'runOnceForAllItems');
  assert.deepStrictEqual(out, [{ a: 1 }]);
});

test('returning nothing is an error that says what to do', async () => {
  const { record } = await runCode('const x = 1;', 'runOnceForAllItems');
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /returned nothing/i);
});

test('returning a scalar is an error, because an item must be an object', async () => {
  for (const code of ['return 42;', 'return "hello";', 'return [1, 2];']) {
    const { record } = await runCode(code, 'runOnceForAllItems');
    assert.strictEqual(record.status, 'error', code);
    assert.match(record.error, /not an object|list of items/i, code);
  }
});

test('returning several items in per-item mode is an error, not a silent fan-out', async () => {
  const { record } = await runCode('return [{ a: 1 }, { a: 2 }];', 'runOncePerItem');
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /single item/i);
  assert.match(record.error, /runOnceForAllItems/, 'and it names the fix');
});

test('empty code is an error rather than a silent no-op', async () => {
  const { record } = await runCode('   ', 'runOnceForAllItems');
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /no JavaScript/i);
});

/* ── failure surfacing ─────────────────────────────────────────────────── */

test('a thrown error reaches the run log with its message', async () => {
  const { record } = await runCode('throw new Error("my own message");', 'runOnceForAllItems');
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /my own message/);
});

test('a runaway loop fails the node without taking the run down', async () => {
  const { record } = await runCode('while (true) {}', 'runOnceForAllItems');
  assert.strictEqual(record.status, 'error');

  // And the engine is still healthy.
  const after = await runCode('return [{ ok: true }];', 'runOnceForAllItems');
  assert.strictEqual(after.record.status, 'success');
});

test('downstream nodes are skipped when the Code node fails', async () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 't', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'c', name: 'Code', type: 'code', position: [200, 0],
        parameters: { mode: 'runOnceForAllItems', jsCode: 'throw new Error("nope");' },
      },
      { id: 'n', name: 'After', type: 'noOp', position: [400, 0], parameters: {} },
    ],
    connections: [
      { from: 't', fromOutput: 0, to: 'c', toInput: 0 },
      { from: 'c', fromOutput: 0, to: 'n', toInput: 0 },
    ],
  };
  const trace = await run(scenario, graph);
  assert.strictEqual(trace.status, 'error');
  assert.strictEqual(trace.nodes.find((n) => n.name === 'After').status, 'skipped');
});

/* ── determinism ───────────────────────────────────────────────────────── */

test('two runs of the same Code node agree, even using Date and Math.random', async () => {
  const code = 'return [{ json: { t: Date.now(), r: Math.random() } }];';
  const a = await runCode(code, 'runOnceForAllItems');
  const b = await runCode(code, 'runOnceForAllItems');
  assert.deepStrictEqual(a.out, b.out, 'grading requires reproducibility');
});

test('the Code node can read another node by name, like an expression can', async () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 't', name: 'Source', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 's', name: 'Stamp', type: 'set', position: [200, 0],
        parameters: { keepOnlySet: true, fields: [{ name: 'tag', value: 'from-set' }] },
      },
      {
        id: 'c', name: 'Code', type: 'code', position: [400, 0],
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: 'return [{ json: { seen: $node["Stamp"].json.tag } }];',
        },
      },
    ],
    connections: [
      { from: 't', fromOutput: 0, to: 's', toInput: 0 },
      { from: 's', fromOutput: 0, to: 'c', toInput: 0 },
    ],
  };
  const trace = await run(scenario, graph);
  const record = trace.nodes.find((n) => n.name === 'Code');
  assert.strictEqual(record.status, 'success', record.error);
  assert.deepStrictEqual(record.output[0].json, { seen: 'from-set' });
});
