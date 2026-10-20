'use strict';

/**
 * The QuickJS-WASM isolate.
 *
 * This replaced an earlier `new Function` evaluation. The
 * difference is not incremental: `new Function` shadowed the dangerous globals as
 * `undefined` parameters, which stopped the obvious reaches and nothing else —
 * `(()=>{}).constructor("return process")()` walked straight past it, and `eval`
 * could not be shadowed at all because it is not a legal strict-mode parameter
 * name. Inside QuickJS there is no host realm to reach: the isolate is a separate
 * VM with no bindings back into Node.
 *
 * Three properties this buys, in order of importance:
 *
 *   1. **Isolation.** Candidate code cannot touch the host. `test/sandbox.test.js`
 *      works through an escape list rather than asserting it in the abstract.
 *   2. **Termination.** An interrupt handler enforces a wall-clock deadline, so
 *      `while(true){}` costs a few milliseconds instead of the process.
 *   3. **Determinism.** `Date` and `Math.random` are replaced inside the isolate
 *      with the run's fixed clock and a seeded generator, so a candidate who
 *      reaches for either still gets a reproducible run — which grading requires.
 *
 * ── Design notes ────────────────────────────────────────────────────────────
 *
 * **Loading is async, evaluation is not.** `getQuickJS()` has to be awaited once
 * to load the WASM; after that `getQuickJSSync()` returns the module and every
 * evaluation is synchronous. That is what lets the expression evaluator keep its
 * synchronous signature, which matters because it is called from inside a
 * per-item loop in the scheduler.
 *
 * **A fresh context per evaluation.** Measured at ~0.15ms, so a 24-expression run
 * costs about 4ms. Worth it: a reused context would let one expression leave state
 * behind for the next, which is an order-dependence bug waiting to happen even
 * though it is not a security problem.
 *
 * **Data crosses as JSON, helpers are defined inside.** Nothing but strings moves
 * between the realms, so no host object can be reachable by construction rather
 * than by care. `$json`, `$node`, `$()` and friends are defined by a prelude
 * *inside* the isolate, operating on the injected data.
 */

const { getQuickJS, getQuickJSSync } = require('quickjs-emscripten');

const DEFAULT_TIMEOUT_MS = 100;

let loaded = false;

/** Load the WASM module. Idempotent; must be awaited once before evaluating. */
async function initSandbox() {
  if (loaded) return;
  await getQuickJS();
  loaded = true;
}

function isSandboxReady() {
  return loaded;
}

/**
 * Runs inside the isolate before the expression. `__d` is the injected data and
 * `__seed` the deterministic clock.
 */
const PRELUDE = `
  var $json = __d.json;
  var $itemIndex = __d.itemIndex;
  var $now = __d.now;
  var $today = __d.today;
  var $vars = __d.vars;
  var $env = __d.env;

  var $items = function () {
    return __d.items.map(function (j) { return { json: j }; });
  };

  var $node = (function () {
    var out = {};
    Object.keys(__d.nodeOutputs).forEach(function (name) {
      var all = __d.nodeOutputs[name];
      var at = all[__d.itemIndex] !== undefined ? all[__d.itemIndex] : all[0];
      out[name] = { json: at, all: all };
    });
    return out;
  })();

  var $ = function (name) {
    var all = __d.nodeOutputs[name] || [];
    var at = all[__d.itemIndex] !== undefined ? all[__d.itemIndex] : all[0];
    return {
      item: at === undefined ? undefined : { json: at },
      first: function () { return all[0] === undefined ? undefined : { json: all[0] }; },
      last: function () { return all.length ? { json: all[all.length - 1] } : undefined; },
      all: function () { return all.map(function (j) { return { json: j }; }); }
    };
  };

  // Determinism: two expressions in one run must never disagree, and two runs of
  // the same workflow must produce the same trace.
  var __RealDate = Date;
  Date = class extends __RealDate {
    constructor(...args) { super(...(args.length ? args : [__seed])); }
    static now() { return __seed; }
  };

  // A seeded generator rather than a constant, so a candidate reaching for
  // randomness gets plausible-looking values that are still reproducible.
  Math.random = (function () {
    var s = __seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  })();
`;

/**
 * Extra bindings for the Code node, which sees the item list rather than a single
 * value. Mirrors what the tools candidates know: `items` / `$input.all()` in
 * all-items mode, `$json` / `item` in per-item mode.
 */
const CODE_PRELUDE = `
  var items = __d.items.map(function (j) { return { json: j }; });
  var item = items[__d.itemIndex] || (__d.json === null ? undefined : { json: __d.json });
  var $input = {
    all: function () { return items; },
    first: function () { return items[0]; },
    last: function () { return items[items.length - 1]; },
    item: item
  };
`;

/**
 * Run candidate-authored statements in a fresh isolate.
 *
 * Same boundary as an expression — the code is a function body, so it may declare
 * variables, loop and return early. The return value crosses as JSON like any
 * other, so it can only be data.
 *
 * @param {string} code    the candidate's JavaScript
 * @returns {{ok: true, value: *} | {ok: false, error: string, syntax?: boolean}}
 */
function runCodeInIsolate(code, data, options = {}) {
  // Wrapped as an IIFE body so `return` works and declarations stay scoped.
  return evaluateInIsolate(`(function () {\n${code}\n})()`, data, {
    ...options,
    extraPrelude: CODE_PRELUDE,
  });
}

/**
 * Evaluate one expression source in a fresh isolate.
 *
 * @param {string} source        the inner text of a `{{ }}` span
 * @param {object} data          { json, itemIndex, items, nodeOutputs, vars, env, now, today, seedMs }
 * @param {object} [options]     { timeoutMs }
 * @returns {{ok: true, value: *} | {ok: false, error: string, syntax?: boolean}}
 */
function evaluateInIsolate(source, data, options = {}) {
  if (!loaded) {
    return { ok: false, error: 'Expression sandbox is not initialised (await initSandbox()).' };
  }

  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const QuickJS = getQuickJSSync();
  const runtime = QuickJS.newRuntime();

  // Hard stop. Checked by the interpreter between operations, so it interrupts
  // loops that would otherwise never yield.
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  runtime.setMemoryLimit(16 * 1024 * 1024);

  /*
   * Bound the interpreter's stack.
   *
   * Without this, `(function f(){ return f(); })()` exhausts the *host* stack
   * rather than QuickJS's own: the WASM module aborts with a failed assertion in
   * JS_FreeRuntime and takes the whole Node process with it. A candidate writing
   * accidental infinite recursion would have killed the server — worse in
   * availability terms than the evaluator this replaced.
   *
   * With a bound, QuickJS raises an ordinary "stack overflow" error the caller can
   * report. 256KB is far more than any legitimate expression needs.
   */
  runtime.setMaxStackSize(256 * 1024);

  const context = runtime.newContext();
  try {
    // The result is wrapped so `undefined` is distinguishable from "no value":
    // JSON.stringify({v: undefined}) omits the key entirely.
    const program = `${PRELUDE}${options.extraPrelude || ''}\nJSON.stringify({ v: (${source}) })`;

    const injected = JSON.stringify({
      json: data.json === undefined ? null : data.json,
      itemIndex: data.itemIndex || 0,
      items: data.items || [],
      nodeOutputs: data.nodeOutputs || {},
      vars: data.vars || {},
      env: data.env || {},
      now: data.now,
      today: data.today,
    });

    const setup = context.evalCode(
      `globalThis.__d = ${injected}; globalThis.__seed = ${Number(data.seedMs) || 0};`,
    );
    if (setup.error) {
      const message = describeError(context, setup.error);
      setup.error.dispose();
      return { ok: false, error: message };
    }
    setup.value.dispose();

    const result = context.evalCode(program);
    if (result.error) {
      const detail = errorDetail(context, result.error);
      result.error.dispose();
      return {
        ok: false,
        error: detail.name === 'SyntaxError'
          ? `Syntax error in expression: ${detail.message}`
          : detail.message,
        syntax: detail.name === 'SyntaxError',
      };
    }

    const raw = context.getString(result.value);
    result.value.dispose();

    const parsed = JSON.parse(raw);
    return { ok: true, value: 'v' in parsed ? parsed.v : undefined };
  } catch (err) {
    // A throw here is our bug or an unserialisable result, not candidate code.
    return { ok: false, error: err.message };
  } finally {
    /*
     * Backstop. Disposal should not be able to throw now that the stack is
     * bounded, but if some future case does poison the runtime, that must surface
     * as a failed expression rather than as a dead process.
     */
    try {
      context.dispose();
      runtime.dispose();
    } catch {
      loaded = false; // force a fresh module load on the next evaluation
    }
  }
}

function errorDetail(context, handle) {
  try {
    const dumped = context.dump(handle);
    if (dumped && typeof dumped === 'object') {
      return {
        name: dumped.name || '',
        message: dumped.message || String(dumped.name || 'Error'),
      };
    }
    return { name: '', message: String(dumped) };
  } catch {
    return { name: '', message: 'Expression failed' };
  }
}

function describeError(context, handle) {
  return errorDetail(context, handle).message;
}

module.exports = {
  initSandbox, isSandboxReady, evaluateInIsolate, runCodeInIsolate, DEFAULT_TIMEOUT_MS,
};
