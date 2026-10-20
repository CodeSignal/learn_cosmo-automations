'use strict';

/**
 * The QuickJS-WASM isolate.
 *
 * This is the security boundary for candidate-authored code, so it is tested by
 * *attempting escapes* rather than by asserting isolation in the abstract. Each
 * case below is a real technique; several of them defeated the `new Function`
 * evaluator this replaced.
 *
 * If you change the sandbox, this file is the one that has to stay green.
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const { initSandbox, evaluateInIsolate } = require('../engine/sandbox');

before(() => initSandbox());

const DATA = {
  json: { region: 'EU', total: 1420 },
  itemIndex: 0,
  items: [],
  nodeOutputs: {},
  vars: {},
  env: {},
  now: '2026-07-31T09:00:00.000Z',
  today: '2026-07-31',
  seedMs: Date.parse('2026-07-31T09:00:00.000Z'),
};

const evaluate = (source, options) => evaluateInIsolate(source, DATA, options);

/* ── escapes ───────────────────────────────────────────────────────────── */

test('ESCAPE: host globals do not exist inside the isolate', () => {
  const hostOnly = [
    'require', 'process', 'module', 'exports', '__dirname', '__filename',
    'Buffer', 'fetch', 'setTimeout', 'setInterval', 'queueMicrotask',
    'WebAssembly', 'XMLHttpRequest',
  ];
  for (const name of hostOnly) {
    const res = evaluate(`typeof ${name}`);
    assert.strictEqual(res.ok, true, `${name}: ${res.error}`);
    assert.strictEqual(res.value, 'undefined', `${name} must not exist in the isolate`);
  }
});

test('ESCAPE: the Function constructor cannot reach the host realm', () => {
  // THIS IS THE ONE THAT DEFEATED `new Function`. Shadowing `require`/`process`
  // as parameters did nothing, because a fresh Function body was compiled in the
  // host realm where the real globals were in scope.
  const attempts = [
    '(()=>{}).constructor("return typeof process")()',
    '(function(){}).constructor("return typeof require")()',
    'Object.getPrototypeOf(function(){}).constructor("return typeof globalThis.process")()',
    '[].constructor.constructor("return typeof process")()',
  ];
  for (const source of attempts) {
    const res = evaluate(source);
    assert.strictEqual(res.value, 'undefined', `reached the host via: ${source}`);
  }
});

test('ESCAPE: eval cannot reach the host realm', () => {
  // `eval` could not be shadowed at all under `new Function` — it is not a legal
  // strict-mode parameter name. Inside the isolate it is simply harmless.
  const res = evaluate('eval("typeof process")');
  assert.strictEqual(res.value, 'undefined');
});

test('ESCAPE: no path from a value back to a host object', () => {
  const probes = [
    'typeof this.process',
    'typeof globalThis.process',
    'typeof Object.constructor("return process")()',
    'Object.keys(globalThis).filter(k => /process|require|Buffer/.test(k)).length',
  ];
  for (const source of probes) {
    const res = evaluate(source);
    // Either outcome is a pass, and the second is the stronger one: a bare
    // reference to a host global is not merely undefined, it does not resolve.
    const harmless = res.ok
      ? (res.value === 'undefined' || res.value === 0)
      : /is not defined/.test(res.error);
    assert.ok(harmless, `${source} -> ok=${res.ok} value=${JSON.stringify(res.value)} err=${res.error}`);
  }
});

test('ESCAPE: the injected data is a copy, not a live host reference', () => {
  // Only JSON crosses the boundary, so mutating `$json` inside the isolate cannot
  // affect the host's item — which also protects the engine's own item model.
  const mutation = evaluate('(function(){ __d.json.region = "HACKED"; return __d.json.region; })()');
  assert.strictEqual(mutation.value, 'HACKED', 'mutation inside the isolate is allowed');
  assert.strictEqual(DATA.json.region, 'EU', 'but must not reach the host object');
});

/* ── termination ───────────────────────────────────────────────────────── */

test('TERMINATION: an infinite loop is interrupted at the deadline', () => {
  const started = Date.now();
  const res = evaluate('(function(){ while (true) {} })()', { timeoutMs: 60 });
  const elapsed = Date.now() - started;

  assert.strictEqual(res.ok, false, 'an infinite loop must not be allowed to return');
  assert.ok(elapsed < 1500, `took ${elapsed}ms — the interrupt handler did not fire`);
});

test('TERMINATION: unbounded recursion fails without taking the process down', () => {
  // Regression guard for a real bug: without a bounded interpreter stack this
  // exhausted the HOST stack, aborted the WASM module inside JS_FreeRuntime, and
  // killed the Node process. Candidate code must never be able to do that.
  const res = evaluate('(function f(){ return f(); })()', { timeoutMs: 200 });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /stack/i);
  assert.strictEqual(evaluate('1 + 1').value, 2, 'the sandbox still works afterwards');
});

test('TERMINATION: unbounded allocation fails without taking the process down', () => {
  const res = evaluate('(function(){ const a = []; while (true) a.push("x".repeat(1e5)); })()',
    { timeoutMs: 400 });
  assert.strictEqual(res.ok, false);
  // The process is still healthy afterwards.
  assert.strictEqual(evaluate('1 + 1').value, 2);
});

test('TERMINATION: a slow expression does not affect the next one', () => {
  evaluate('(function(){ while (true) {} })()', { timeoutMs: 40 });
  const after = evaluate('$json.total');
  assert.strictEqual(after.value, 1420, 'a fresh context per evaluation, so no contamination');
});

/* ── determinism ───────────────────────────────────────────────────────── */

test('DETERMINISM: Date is pinned to the run clock', () => {
  assert.strictEqual(evaluate('new Date().toISOString()').value, '2026-07-31T09:00:00.000Z');
  assert.strictEqual(evaluate('Date.now()').value, DATA.seedMs);
  // An explicit argument still works — only the argument-less form is pinned.
  assert.strictEqual(evaluate('new Date(0).toISOString()').value, '1970-01-01T00:00:00.000Z');
});

test('DETERMINISM: Math.random is seeded, so two runs agree', () => {
  const a = evaluate('Math.random()').value;
  const b = evaluate('Math.random()').value;
  assert.strictEqual(a, b, 'same seed, same first value — grading must be reproducible');
  assert.ok(a > 0 && a < 1, `expected a plausible random value, got ${a}`);
});

test('DETERMINISM: a different run clock gives a different seed', () => {
  const other = { ...DATA, seedMs: DATA.seedMs + 86400000 };
  const a = evaluateInIsolate('Math.random()', DATA).value;
  const b = evaluateInIsolate('Math.random()', other).value;
  assert.notStrictEqual(a, b);
});

/* ── value marshalling ─────────────────────────────────────────────────── */

test('values round-trip with their types intact', () => {
  const cases = [
    ['$json.total', 1420], ['$json.region', 'EU'], ['$json.total > 1000', true],
    ['null', null], ['[1,2,3]', [1, 2, 3]], ['({a:{b:1}})', { a: { b: 1 } }],
    ['"x".repeat(3)', 'xxx'], ['0.1 + 0.2', 0.30000000000000004],
  ];
  for (const [source, expected] of cases) {
    const res = evaluate(source);
    assert.deepStrictEqual(res.value, expected, source);
  }
});

test('undefined is distinguishable from a missing result', () => {
  const res = evaluate('$json.nope');
  assert.strictEqual(res.ok, true, 'reading a missing key is not an error');
  assert.strictEqual(res.value, undefined);
});

test('an unserialisable result is an error, not a crash', () => {
  const circular = evaluate('(function(){ const a = {}; a.self = a; return a; })()');
  assert.strictEqual(circular.ok, false);
  assert.strictEqual(evaluate('1 + 1').value, 2, 'and the sandbox still works after');
});

test('a syntax error is labelled as one', () => {
  const res = evaluate('$json.total +');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.syntax, true);
  assert.match(res.error, /^Syntax error in expression: /);
});

test('a thrown value is reported rather than escaping', () => {
  const res = evaluate('(function(){ throw new Error("boom"); })()');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /boom/);
});

/* ── cost ──────────────────────────────────────────────────────────────── */

test('a fresh context per evaluation stays cheap enough for a per-item loop', () => {
  const started = Date.now();
  for (let i = 0; i < 100; i += 1) evaluate('$json.total > 1000');
  const per = (Date.now() - started) / 100;
  // Measured around 0.15ms; the bound is loose so this fails on a real regression
  // rather than on a noisy CI box.
  assert.ok(per < 5, `${per.toFixed(2)}ms per evaluation is too slow for the item loop`);
});
