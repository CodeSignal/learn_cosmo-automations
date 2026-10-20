'use strict';

/**
 * Regression guards for security and integrity properties that once had gaps.
 *
 * Each test pins a fixed behaviour — the sandbox, the Code node's isolation,
 * re-executed grading, hidden assertions, the private flag, the release
 * pipeline — so a change that reopens one fails here, with the property named.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run } = require('../engine');
const { evaluateAssertions } = require('../grading/assertions');
const { evaluateExpressionString, initSandbox } = require('../engine/expression');
const { effectiveMode } = require('../shared/node-mode.mjs');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'scenarios', 'eu-orders');
const scenario = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));

/* ── the QuickJS-WASM isolate ─────────────
 * Expressions used to run through `new Function` with dangerous globals shadowed,
 * which is not a sandbox. They run in the isolate now; this guards the escape that
 * defeated the old evaluator. The full escape list lives in test/sandbox.test.js.
 */

test('the escape that defeated new Function no longer works', async () => {
  await initSandbox();

  // Under `new Function` this returned 2 by reaching the host Function
  // constructor. Inside the isolate there is no host realm to reach.
  const escaped = evaluateExpressionString('={{ (()=>{}).constructor("return 1+1")() }}', {
    json: {}, now: new Date(0),
  });

  assert.strictEqual(escaped.value, 2,
    'the Function constructor still works — but only INSIDE the isolate, which is '
    + 'harmless. What must never work is reaching the host; see the next assertion '
    + 'and test/sandbox.test.js.');

  const reachHost = evaluateExpressionString(
    '={{ (()=>{}).constructor("return typeof process")() }}',
    { json: {}, now: new Date(0) },
  );
  assert.strictEqual(reachHost.value, 'undefined',
    'the Function constructor must not be able to see the Node host realm');
});

/* ── the Code node ────────────────────────
 * The Code node is the one node that runs candidate-authored JavaScript, so it
 * must run inside the isolate. Behaviour is covered by test/code-node.test.js.
 */

test('the Code node exists and runs inside the isolate', async () => {
  const { allNodes } = require('../engine');
  const code = allNodes().find((n) => n.type === 'code');

  assert.ok(code, 'the Code node should be registered');
  // Its mode is a parameter, not a fixed property — the candidate chooses. The
  // resolution lives in shared/node-mode.mjs so the canvas and the engine
  // share one implementation; what matters is that the parameter still decides.
  assert.strictEqual(code.mode, 'dynamic');
  assert.strictEqual(code.dynamicModeParam, 'mode');
  assert.strictEqual(
    effectiveMode(code, { parameters: { mode: 'runOncePerItem' } }),
    'runOncePerItem',
  );

  // And it really is sealed: no network, no host.
  const graph = {
    version: 1,
    nodes: [
      { id: 't', name: 'T', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'c', name: 'C', type: 'code', position: [200, 0],
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: 'return [{ json: { host: typeof process, net: typeof fetch } }];',
        },
      },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'c', toInput: 0 }],
  };
  const trace = await run(scenario, graph);
  assert.deepStrictEqual(trace.nodes[1].output[0].json, { host: 'undefined', net: 'undefined' });
});

/* ── grading re-runs the workflow ──────────
 * Was: "the trace is hashed, not signed", pinning the absence of an HMAC. No
 * secret is involved. A trace is a pure function of (scenario, graph, decisions),
 * so grading runs the workflow again and judges that run. A forged
 * execution.json no longer changes the verdict — it only turns the signature to
 * MISMATCH. The attacks themselves live in hire-hardening.test.js.
 */

test('a forged execution.json cannot change the verdict', async () => {
  const os = require('os');
  const { grade } = require('../parse_automation_solution');
  const wrong = JSON.parse(fs.readFileSync(path.join(DIR, 'variants', 'wrong-1-off-by-one.json'), 'utf8'));
  const right = JSON.parse(fs.readFileSync(path.join(DIR, 'reference_solution.json'), 'utf8'));

  const forged = await run(scenario, wrong);
  Object.assign(forged, (({ nodes, sinks, finalPayloads }) => ({ nodes, sinks, finalPayloads }))(
    await run(scenario, right),
  ));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-row3-'));
  const at = (f) => path.join(dir, f);
  fs.writeFileSync(at('config.json'), JSON.stringify(scenario));
  fs.writeFileSync(at('solution.json'), JSON.stringify(wrong));
  fs.writeFileSync(at('execution.json'), JSON.stringify(forged));
  const report = await grade({
    scenarioFile: at('config.json'), solutionFile: at('solution.json'), executionFile: at('execution.json'),
  });

  assert.match(report, /^RESULT: FAIL/m);
  assert.match(report, /## TRACE SIGNATURE\nMISMATCH/);
});

/* ── the answer key is on the session filesystem ──────────── */

/*
 * Was: "assertions ship inside scenario.json", pinning that the
 * answer key sat in a file the candidate can open. A Hire task now ships them as
 * a hidden project file `hidden_cosmo-automations/assertions.json`, which
 * exists only during Submit — exactly when grading runs — and grading reads it
 * in preference to anything inline. The bundled scenarios stay inline because
 * they are Learn-shaped dev fixtures, where the detail is a teaching feature.
 */
test('grading takes assertions from a hidden assertions.json', () => {
  const { attachAssertions, ASSERTIONS_FILE } = require('../engine/scenarios');
  assert.strictEqual(ASSERTIONS_FILE, 'assertions.json');

  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-row4-'));
  const visible = JSON.parse(JSON.stringify(scenario));
  delete visible.assertions;
  fs.writeFileSync(path.join(dir, 'assertions.json'), JSON.stringify(scenario.assertions));

  const source = attachAssertions(visible, path.join(dir, 'config.json'));
  assert.strictEqual(source.source, 'file');
  assert.deepStrictEqual(visible.assertions, scenario.assertions);
});

test('the server already withholds them from the browser', async () => {
  // Defence in depth that must survive the real fix.
  const { paletteFor } = require('../engine');
  assert.ok(paletteFor(scenario).length > 0);

  /**
   * Checked as behaviour, not as a source line. This used to assert the exact
   * destructuring statement that stripped `assertions` — which passed happily
   * while that same statement was spreading `mockApi`, and the expected API key
   * with it, straight to the browser. Pinning an implementation detail told us
   * nothing about the property we cared about.
   */
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const allowlist = /const CLIENT_SCENARIO_FIELDS = \[([\s\S]*?)\];/.exec(serverSource);
  assert.ok(allowlist, 'scenarioForClient must build the payload from an allowlist');
  assert.ok(!allowlist[1].includes("'assertions'"),
    'assertions must never be on the list of fields sent to the client');
});

/* ── the `private` flag ────────────────────
 * Was: "FAIL details reveal the expected value", unconditionally. Now a scenario
 * can set `grading.private`, and any assertion its own `private`, to withhold the
 * detail; the FAIL line then carries the author's `message` instead. The default
 * is unchanged, because in Learn "expected 3, got 4" is the lesson.
 */

test('a private assertion prints no expected value; Learn still does', async () => {
  const graph = JSON.parse(
    fs.readFileSync(path.join(DIR, 'variants', 'wrong-1-off-by-one.json'), 'utf8'),
  );
  const trace = await run(scenario, graph);
  const { formatReport } = require('../grading/format');
  const report = (s) => formatReport({
    scenario: s, graph, trace, assertions: evaluateAssertions(s, graph, trace), signature: 'VALID',
  }).split('\n').filter((l) => l.startsWith('FAIL  '));

  assert.ok(report(scenario).some((l) => /expected/i.test(l)), 'Learn keeps the teaching detail');

  const hire = { ...scenario, grading: { private: true } };
  const failures = report(hire);
  assert.ok(failures.length > 0);
  for (const line of failures) {
    assert.doesNotMatch(line, /expected/i);
    // Whatever changes, secrets must never appear.
    assert.doesNotMatch(line, /sk_test|xoxb-/, 'a credential leaked into a FAIL detail');
  }
});

/* ── the release pipeline ────────────────────────
 * Was: "there is no release workflow", pinning its absence. Inherited from
 * learn_bespoke-template and adapted — the template's tarball list would have
 * shipped a broken release. Contents are
 * guarded by test/release.test.js and by `npm run verify:release`, which boots a
 * real tarball end to end.
 */

test('a release workflow exists and is gated on grading', () => {
  const workflow = path.join(ROOT, '.github', 'workflows', 'build-release.yml');
  assert.ok(fs.existsSync(workflow), 'the release workflow should exist');

  const yaml = fs.readFileSync(workflow, 'utf8');
  assert.match(yaml, /npm run experiment/,
    'a release must not ship if the grading experiment fails');
});
