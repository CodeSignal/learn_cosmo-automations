'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const {
  evaluateExpressionString, resolveParameters, isExpression, UNDEFINED_DISPLAY,
  initSandbox,
} = require('../engine/expression');

// Evaluation is synchronous, but the isolate's WASM has to be loaded once first.
// `executeWorkflow` does this itself; tests calling the evaluator directly do it here.
before(() => initSandbox());

const CTX = {
  json: { region: 'EU', total: 1420, name: 'nordwind', nested: { deep: [10, 20] } },
  itemIndex: 2,
  items: [{ json: { a: 1 } }, { json: { a: 2 } }, { json: { a: 3 } }],
  nodeOutputs: {
    'Fetch Orders': [
      { json: { id: 'AC-1', total: 100 } },
      { json: { id: 'AC-2', total: 200 } },
      { json: { id: 'AC-3', total: 300 } },
    ],
  },
  vars: { threshold: 1000 },
  env: { STAGE: 'staging' },
  now: new Date('2026-07-31T09:00:00.000Z'),
};

test('a lone span passes the raw value through, preserving its type', () => {
  const cases = [
    ['={{ $json.total }}', 1420, 'number'],
    ['={{ $json.region }}', 'EU', 'string'],
    ['={{ $json.total > 1000 }}', true, 'boolean'],
    ['={{ $json.nested }}', { deep: [10, 20] }, 'object'],
    ['={{ $json.nested.deep[1] }}', 20, 'number'],
  ];
  for (const [expr, expected] of cases) {
    const res = evaluateExpressionString(expr, CTX);
    assert.deepStrictEqual(res.value, expected, expr);
    assert.strictEqual(res.ok, true, expr);
  }
});

test('a span mixed with literal text splices into a string', () => {
  const res = evaluateExpressionString('={{ $json.region }} order worth {{ $json.total }}', CTX);
  assert.strictEqual(res.value, 'EU order worth 1420');
});

test('plain JS methods work on resolved values', () => {
  assert.strictEqual(evaluateExpressionString('={{ $json.name.toUpperCase() }}', CTX).value, 'NORDWIND');
  assert.strictEqual(evaluateExpressionString('={{ $json.nested.deep.length }}', CTX).value, 2);
});

test('$node["Name"] reads the item at the same index', () => {
  assert.strictEqual(evaluateExpressionString('={{ $node["Fetch Orders"].json.id }}', CTX).value, 'AC-3');
  assert.strictEqual(evaluateExpressionString('={{ $("Fetch Orders").item.json.id }}', CTX).value, 'AC-3');
  assert.strictEqual(evaluateExpressionString('={{ $("Fetch Orders").first().json.id }}', CTX).value, 'AC-1');
  assert.strictEqual(evaluateExpressionString('={{ $("Fetch Orders").last().json.id }}', CTX).value, 'AC-3');
  assert.strictEqual(evaluateExpressionString('={{ $("Fetch Orders").all().length }}', CTX).value, 3);
});

test('$itemIndex, $items(), $vars, $env and the fixed clock', () => {
  assert.strictEqual(evaluateExpressionString('={{ $itemIndex }}', CTX).value, 2);
  assert.strictEqual(evaluateExpressionString('={{ $items().length }}', CTX).value, 3);
  assert.strictEqual(evaluateExpressionString('={{ $vars.threshold }}', CTX).value, 1000);
  assert.strictEqual(evaluateExpressionString('={{ $env.STAGE }}', CTX).value, 'staging');
  assert.strictEqual(evaluateExpressionString('={{ $today }}', CTX).value, '2026-07-31');
  assert.strictEqual(evaluateExpressionString('={{ $now }}', CTX).value, '2026-07-31T09:00:00.000Z');
});

test('$now is fixed, so two evaluations in one run never disagree', () => {
  const a = evaluateExpressionString('={{ $now }}', CTX).value;
  const b = evaluateExpressionString('={{ $now }}', CTX).value;
  assert.strictEqual(a, b);
});

test('a missing field resolves to undefined and displays as [undefined]', () => {
  const res = evaluateExpressionString('={{ $json.regionn }}', CTX);
  assert.strictEqual(res.value, undefined);
  assert.strictEqual(res.ok, true, 'reading a missing key is not itself an error');
  assert.strictEqual(res.spans[0].display, UNDEFINED_DISPLAY);
});

test('reading through undefined is an error with a message the learner can act on', () => {
  const res = evaluateExpressionString('={{ $json.missing.deeper }}', CTX);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /undefined/);
  assert.strictEqual(res.spans[0].error, res.error);
});

test('a syntax error is reported rather than thrown', () => {
  const res = evaluateExpressionString('={{ $json.total + }}', CTX);
  assert.strictEqual(res.ok, false);
  // The prefix is ours; the detail after it comes from QuickJS and is not pinned.
  assert.match(res.error, /^Syntax error in expression: /);
});

test('an undefined span inside literal text renders [undefined] in place', () => {
  const res = evaluateExpressionString('=total is {{ $json.nope.deeper }} today', CTX);
  assert.strictEqual(res.value, `total is ${UNDEFINED_DISPLAY} today`);
  assert.strictEqual(res.ok, false);
});

test('a string without "=" is a literal, and "=" with no span is literal text', () => {
  assert.strictEqual(isExpression('plain'), false);
  assert.strictEqual(isExpression('={{ x }}'), true);
  assert.strictEqual(evaluateExpressionString('=no spans here', CTX).value, 'no spans here');
});

test('resolveParameters walks nested params and reports diagnostics by path', () => {
  const { value, diagnostics } = resolveParameters({
    combinator: 'and',
    conditions: [
      { left: '={{ $json.region }}', op: 'equals', right: 'EU' },
      { left: '={{ $json.nope.deeper }}', op: 'gt', right: 1000 },
    ],
  }, CTX);

  assert.strictEqual(value.conditions[0].left, 'EU');
  assert.strictEqual(value.conditions[0].right, 'EU', 'non-expression strings pass through untouched');
  assert.strictEqual(value.conditions[1].left, undefined);
  assert.deepStrictEqual(diagnostics.map((d) => d.path), ['conditions[0].left', 'conditions[1].left']);
  assert.strictEqual(diagnostics[0].error, null);
  assert.match(diagnostics[1].error, /undefined/);
});

test('host globals are absent from the isolate', () => {
  // Not shadowing any more — there is no host realm inside the isolate to shadow.
  // The escape list lives in test/sandbox.test.js.
  for (const name of ['require', 'process', 'fetch', 'Buffer', 'module']) {
    const res = evaluateExpressionString(`={{ typeof ${name} }}`, CTX);
    assert.strictEqual(res.value, 'undefined', `${name} must not exist in the isolate`);
  }
});

// The sandbox-escape pin lives in test/security-regressions.test.js, alongside the
// other security regression guards, so there is one place to look.
