'use strict';

/**
 * Grading tests.
 *
 * The 10 variants are a permanent regression fixture: any future
 * change to the STDOUT format or the assertion DSL has to keep classifying
 * all ten correctly.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run, hashGraph } = require('../engine');
const { evaluateAssertions } = require('../grading/assertions');
const { formatReport, redact } = require('../grading/format');

const DIR = path.join(__dirname, '..', 'scenarios', 'eu-orders');
const scenario = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));

async function grade(graph) {
  const trace = await run(scenario, graph);
  const assertions = evaluateAssertions(scenario, graph, trace);
  const signature = trace.graphHash === hashGraph(graph) ? 'VALID' : 'MISMATCH';
  const stdout = formatReport({ scenario, graph, trace, assertions, signature });
  const approved = assertions.every((a) => a.pass) && signature === 'VALID';
  return { trace, assertions, stdout, signature, approved };
}

function loadVariant(name) {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'variants', `${name}.json`), 'utf8'));
}

const VARIANTS = fs.readdirSync(path.join(DIR, 'variants'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

test('the fixture holds 5 correct and 5 plausibly-wrong variants', () => {
  assert.strictEqual(VARIANTS.filter((v) => v.startsWith('correct-')).length, 5);
  assert.strictEqual(VARIANTS.filter((v) => v.startsWith('wrong-')).length, 5);
});

test('every correct variant is approved', async () => {
  for (const name of VARIANTS.filter((v) => v.startsWith('correct-'))) {
    const { approved, assertions } = await grade(loadVariant(name));
    const failed = assertions.filter((a) => !a.pass).map((a) => `${a.id}: ${a.detail}`);
    assert.ok(approved, `${name} should be approved but failed:\n  ${failed.join('\n  ')}`);
  }
});

test('every wrong variant is rejected', async () => {
  for (const name of VARIANTS.filter((v) => v.startsWith('wrong-'))) {
    const { approved } = await grade(loadVariant(name));
    assert.ok(!approved, `${name} should be rejected but was approved`);
  }
});

test('each wrong variant fails for the intended reason, not by accident', async () => {
  const expectations = {
    'wrong-1-off-by-one': ['keeps-three-orders', 'posts-to-ops-channel'],
    'wrong-2-wrong-channel': ['posts-to-ops-channel'],
    'wrong-3-missing-aggregate': ['aggregates-to-one-item', 'slack-called-once'],
    'wrong-4-wrong-path': ['keeps-three-orders'],
    'wrong-5-no-credential': ['no-node-errors'],
  };
  for (const [name, mustFail] of Object.entries(expectations)) {
    const { assertions } = await grade(loadVariant(name));
    const failed = new Set(assertions.filter((a) => !a.pass).map((a) => a.id));
    for (const id of mustFail) {
      assert.ok(failed.has(id), `${name} should fail "${id}"; failed: ${[...failed].join(', ')}`);
    }
  }
});

test('STDOUT always carries both machine-readable sections', async () => {
  for (const name of VARIANTS) {
    const { stdout } = await grade(loadVariant(name));
    assert.match(stdout, /^## ASSERTIONS$/m, name);
    assert.match(stdout, /^## TRACE SIGNATURE$/m, name);
    assert.match(stdout, /^## WORKFLOW STRUCTURE$/m, name);
    assert.match(stdout, /^## EXECUTION$/m, name);

    // The block leads with a single RESULT line; every line after it begins
    // PASS or FAIL. The acceptance criteria reads both positionally.
    const block = stdout.split('## ASSERTIONS')[1].split('## TRACE SIGNATURE')[0]
      .split('\n').filter((l) => l.trim());
    assert.match(block[0], /^RESULT: (PASS|FAIL) \(\d+ PASS, \d+ FAIL\)$/, `${name}: "${block[0]}"`);
    for (const line of block.slice(1)) {
      assert.match(line, /^(PASS|FAIL)\s{2}/, `${name}: "${line}"`);
    }
  }
});

test('a hand-edited graph with a stale trace reports MISMATCH', async () => {
  const graph = loadVariant('correct-1-canonical');
  const trace = await run(scenario, graph);

  const tampered = JSON.parse(JSON.stringify(graph));
  tampered.nodes.find((n) => n.type === 'slack').parameters.channel = '#hacked';

  assert.notStrictEqual(trace.graphHash, hashGraph(tampered));
});

test('the graph hash ignores cosmetic changes but catches semantic ones', () => {
  const graph = loadVariant('correct-1-canonical');
  const moved = JSON.parse(JSON.stringify(graph));
  moved.nodes[0].position = [999, 999];
  assert.strictEqual(hashGraph(graph), hashGraph(moved), 'dragging a node is not a semantic change');

  const renamed = JSON.parse(JSON.stringify(graph));
  renamed.nodes[0].name = 'Different';
  assert.notStrictEqual(hashGraph(graph), hashGraph(renamed), 'a rename changes expression targets');
});

test('credential values never reach STDOUT', async () => {
  for (const name of VARIANTS) {
    const { stdout } = await grade(loadVariant(name));
    assert.ok(!stdout.includes('sk_test_FAKE_2f9a1c'), `${name} leaked the CRM key`);
    assert.ok(!stdout.includes('xoxb-FAKE-000000-000000'), `${name} leaked the Slack token`);
  }
  assert.strictEqual(redact('key sk_test_FAKE_2f9a1c here'), 'key sk_*** here');
  assert.strictEqual(redact('Authorization: Bearer abc.def-123'), 'Authorization: Bearer ***');
});

test('grading is deterministic across repeated runs', async () => {
  const graph = loadVariant('correct-1-canonical');
  const a = await grade(graph);
  const b = await grade(graph);
  // Timings legitimately differ; strip them before comparing.
  const strip = (s) => s.replace(/\d+ms/g, 'Nms');
  assert.strictEqual(strip(a.stdout), strip(b.stdout));
});

test('a missing execution trace fails closed, never open', async () => {
  const graph = loadVariant('correct-1-canonical');
  const emptyTrace = { status: 'not-run', nodes: [], httpCalls: [], sinks: {}, finalPayloads: {}, errors: [] };
  const assertions = evaluateAssertions(scenario, graph, emptyTrace);
  assert.ok(assertions.some((a) => !a.pass), 'a workflow that never ran must not pass');
});

test('an empty graph fails every structural assertion', async () => {
  const { approved, assertions } = await grade({ version: 1, nodes: [], connections: [] });
  assert.ok(!approved);
  assert.ok(assertions.every((a) => !a.pass), 'nothing should pass on an empty canvas');
});

/** The EXECUTION line for a node — node names also appear in WORKFLOW STRUCTURE. */
function executionLine(stdout, nodeName) {
  return stdout
    .split('## EXECUTION')[1]
    .split('## ASSERTIONS')[0]
    .split('\n')
    .find((l) => l.includes(nodeName));
}

/* ── STDOUT readability ────────────────────────────────────────────────
 * Cosmo is instructed to turn FAIL details into feedback for the learner, and
 * to read EXECUTION to explain what went wrong. Both therefore have to be
 * comprehensible English, and neither may make a correct solution look broken.
 */

test('FAIL details read as English and never leak DSL syntax', async () => {
  const offences = [];
  for (const name of VARIANTS) {
    const { assertions } = await grade(loadVariant(name));
    for (const a of assertions.filter((x) => !x.pass)) {
      // `nodeType: "filter|if"` used to surface verbatim as "no a filter|if node".
      if (a.detail.includes('|')) offences.push(`${name}/${a.id}: alternation leaked — ${a.detail}`);
      if (/\ba (a|e|i|o|u)/i.test(a.detail)) offences.push(`${name}/${a.id}: wrong article — ${a.detail}`);
      if (/\bno a\b/.test(a.detail)) offences.push(`${name}/${a.id}: "no a …" — ${a.detail}`);
      if (/\b(filter|aggregate|slack|splitOut|httpRequest)\b node/.test(a.detail)) {
        offences.push(`${name}/${a.id}: raw node type instead of a label — ${a.detail}`);
      }
    }
  }
  assert.deepStrictEqual(offences, []);
});

test('a branch node spells out its ports, so a correct IF solution cannot look broken', async () => {
  // Is High Value EU emits 3 on `true` and 9 on `false`; only `true` is wired.
  // Reported as out=12, the next node's in=3 looks like items vanished.
  const { stdout } = await grade(loadVariant('correct-3-if-branch'));
  // Scoped to EXECUTION: the node is also named in WORKFLOW STRUCTURE above.
  const line = executionLine(stdout, 'Is High Value EU');

  assert.match(line, /true=3/, 'the true port count must be visible');
  assert.match(line, /false=9/, 'the false port count must be visible');
  assert.match(line, /not connected, dropped/, 'the drop must be explained, not left implicit');
});

test('a single-output node stays uncluttered', async () => {
  const { stdout } = await grade(loadVariant('correct-1-canonical'));
  const line = executionLine(stdout, 'Split Out Orders');
  assert.ok(!line.includes('('), `single-output nodes need no port breakdown: ${line}`);
});

test('every correct variant is free of anything that reads as a fault', async () => {
  for (const name of VARIANTS.filter((v) => v.startsWith('correct-'))) {
    const { stdout } = await grade(loadVariant(name));
    const execution = stdout.split('## EXECUTION')[1].split('## ASSERTIONS')[0];
    for (const alarming of ['[error]', '[skipped]', '[noItems]', '[disabled]']) {
      assert.ok(!execution.includes(alarming),
        `${name} shows "${alarming}" in EXECUTION — a grader may reject a correct solution`);
    }
    assert.match(execution, /Errors: none/, `${name} should report no errors`);
  }
});

/**
 * The RESULT line is what the acceptance criteria checks first, so it must never
 * be able to disagree with the lines beneath it. A RESULT of PASS above a FAIL
 * line would be a grading hole, not a cosmetic defect.
 */
test('RESULT always agrees with the lines beneath it', async () => {
  for (const name of VARIANTS) {
    const { stdout, approved } = await grade(loadVariant(name));
    const block = stdout.split('## ASSERTIONS')[1].split('## TRACE SIGNATURE')[0]
      .split('\n').filter((l) => l.trim());

    const [, verdict, passClaim, failClaim] = /^RESULT: (PASS|FAIL) \((\d+) PASS, (\d+) FAIL\)$/
      .exec(block[0]);
    const actualPass = block.slice(1).filter((l) => l.startsWith('PASS')).length;
    const actualFail = block.slice(1).filter((l) => l.startsWith('FAIL')).length;

    assert.strictEqual(Number(passClaim), actualPass, `${name}: PASS count`);
    assert.strictEqual(Number(failClaim), actualFail, `${name}: FAIL count`);
    assert.strictEqual(verdict, actualFail > 0 ? 'FAIL' : 'PASS', `${name}: verdict`);
    // And it must agree with the verdict the checker itself reached.
    assert.strictEqual(verdict === 'PASS', approved, `${name}: RESULT vs approved`);
  }
});

test('a scenario with no assertions reports RESULT: FAIL, not a vacuous pass', () => {
  const stdout = formatReport({
    scenario: {}, graph: { nodes: [], connections: [] },
    trace: { status: 'completed', nodes: [], httpCalls: [], sinks: {}, finalPayloads: {}, errors: [] },
    assertions: [], signature: 'VALID',
  });
  assert.match(stdout, /RESULT: FAIL \(0 PASS, 0 FAIL\)/);
});

test('fan-out and fan-in disclose where items went and came from', async () => {
  // No grading variant exercises these shapes, but the product supports them, so
  // the disclosure needs its own fixture — this is the same class of defect as the
  // branch-node one: arithmetic that does not visibly add up.
  const graph = {
    version: 1,
    nodes: [
      { id: 't', name: 'Trigger', type: 'manualTrigger', position: [0, 0], parameters: {} },
      {
        id: 'eu', name: 'EU only', type: 'filter', position: [200, -80],
        parameters: { combinator: 'and', conditions: [{ left: '={{ $json.region }}', op: 'equals', right: 'EU' }] },
      },
      {
        id: 'us', name: 'US only', type: 'filter', position: [200, 80],
        parameters: { combinator: 'and', conditions: [{ left: '={{ $json.region }}', op: 'equals', right: 'US' }] },
      },
      {
        id: 'agg', name: 'Combined', type: 'aggregate', position: [400, 0],
        parameters: { mode: 'summarize', outputs: [{ as: 'count', op: 'count' }] },
      },
    ],
    connections: [
      { from: 't', fromOutput: 0, to: 'eu', toInput: 0 },
      { from: 't', fromOutput: 0, to: 'us', toInput: 0 },
      { from: 'eu', fromOutput: 0, to: 'agg', toInput: 0 },
      { from: 'us', fromOutput: 0, to: 'agg', toInput: 0 },
    ],
  };
  const local = {
    ...scenario,
    triggerPayload: { manualTrigger: [{ region: 'EU' }, { region: 'US' }, { region: 'EU' }] },
  };
  const trace = await run(local, graph);
  const assertions = evaluateAssertions({ assertions: [] }, graph, trace);
  const stdout = formatReport({ scenario: local, graph, trace, assertions, signature: 'VALID' });

  // Fan-out: both branches receive all 3, so downstream totals exceed out=3.
  assert.match(executionLine(stdout, 'Trigger'), /2 branches, each receives all 3/);
  // Fan-in: the receiver's in=3 is the sum of 2 + 1, and says so.
  assert.match(executionLine(stdout, 'Combined'), /in=3 \(2 from "EU only" \+ 1 from "US only"\)/);
});
