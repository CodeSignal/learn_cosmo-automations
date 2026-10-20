'use strict';

/**
 * Hire hardening: what a candidate who wants to cheat can and cannot do.
 *
 * Every test here is an attack, run against the grading path exactly as
 * run_solution.sh runs it: files on disk, `grade()` reading them. The threat is a
 * candidate who can write files in their own workspace — by hand-editing them, or
 * by POSTing whatever they like from devtools — and wants a passing report
 * without a passing workflow.
 *
 * Companion guards live in security-regressions.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run, hashGraph } = require('../engine');
const { grade } = require('../parse_automation_solution');

const ROOT = path.join(__dirname, '..');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

const EU = read('scenarios', 'eu-orders', 'scenario.json');
const EU_REF = read('scenarios', 'eu-orders', 'reference_solution.json');
const EU_WRONG = read('scenarios', 'eu-orders', 'variants', 'wrong-1-off-by-one.json');
const AI = read('scenarios', 'ticket-triage-ai', 'scenario.json');
const AI_REF = read('scenarios', 'ticket-triage-ai', 'reference_solution.json');

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A session directory laid out as run_solution.sh sees it. */
function session({ scenario, graph, trace, assertionsFile }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-hire-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(scenario));
  fs.writeFileSync(path.join(dir, 'solution.json'), JSON.stringify(graph));
  if (trace) fs.writeFileSync(path.join(dir, 'execution.json'), JSON.stringify(trace, null, 2));
  if (assertionsFile !== undefined) {
    fs.writeFileSync(path.join(dir, 'assertions.json'),
      typeof assertionsFile === 'string' ? assertionsFile : JSON.stringify(assertionsFile));
  }
  return grade({
    scenarioFile: path.join(dir, 'config.json'),
    solutionFile: path.join(dir, 'solution.json'),
    executionFile: path.join(dir, 'execution.json'),
  });
}

/** The parts of a report a grader decides on. */
function verdict(report) {
  const lines = report.split('\n');
  const sig = lines[lines.indexOf('## TRACE SIGNATURE') + 1];
  const results = lines.filter((l) => l.startsWith('RESULT:'));
  return { result: results.length === 1 ? results[0].split(' ')[1] : `${results.length} RESULT lines`, sig, lines };
}

/** What the simulation's server does on Execute Workflow. */
const serverRun = (scenario, graph, decisions = {}) =>
  run(scenario, graph, { interactive: true, decisions, simulateLatency: true });

/* ── the saved run is not trusted ─────────────────────────── */

test('an honest run through the server grades VALID and PASS', async () => {
  const trace = await serverRun(AI, AI_REF, { 'Confirm Escalation': 'approve' });
  const v = verdict(await session({ scenario: AI, graph: AI_REF, trace }));
  assert.strictEqual(v.result, 'PASS');
  assert.strictEqual(v.sig, 'VALID');
});

test('a headless run (run.js) grades VALID too', async () => {
  const trace = await run(EU, EU_REF);
  const v = verdict(await session({ scenario: EU, graph: EU_REF, trace }));
  assert.deepStrictEqual([v.result, v.sig], ['PASS', 'VALID']);
});

test('ATTACK: a wrong workflow with the right answer pasted into execution.json', async () => {
  // Run the wrong workflow honestly, then overwrite what it produced with what
  // the reference produces. The hash is still right — it is of the wrong graph,
  // which is what was submitted. Grading on the saved run would have passed it.
  const forged = await serverRun(EU, EU_WRONG);
  const right = await serverRun(EU, EU_REF);
  forged.sinks = right.sinks;
  forged.finalPayloads = right.finalPayloads;
  forged.nodes = right.nodes;

  const v = verdict(await session({ scenario: EU, graph: EU_WRONG, trace: forged }));
  assert.strictEqual(v.sig, 'MISMATCH');
  assert.strictEqual(v.result, 'FAIL', 'graded on the forged run instead of a fresh one');
});

test('ATTACK: the reference run presented with the hash recomputed for a wrong graph', async () => {
  const trace = await serverRun(EU, EU_REF);
  trace.graphHash = hashGraph(EU_WRONG);
  const v = verdict(await session({ scenario: EU, graph: EU_WRONG, trace }));
  assert.deepStrictEqual([v.result, v.sig], ['FAIL', 'MISMATCH']);
});

test('ATTACK: approval decisions changed in the saved run after the fact', async () => {
  const trace = await serverRun(AI, AI_REF, { 'Confirm Escalation': 'reject' });
  trace.decisions = { 'Confirm Escalation': 'approve' };
  const v = verdict(await session({ scenario: AI, graph: AI_REF, trace }));
  assert.strictEqual(v.sig, 'MISMATCH');
});

test('editing the workflow after running it is MISMATCH', async () => {
  const trace = await serverRun(EU, EU_REF);
  const edited = clone(EU_REF);
  edited.nodes.find((n) => n.type === 'slack').parameters.channel = '#elsewhere';
  const v = verdict(await session({ scenario: EU, graph: edited, trace }));
  assert.strictEqual(v.sig, 'MISMATCH');
});

test('never having run the workflow is MISSING and FAIL', async () => {
  const v = verdict(await session({ scenario: EU, graph: EU_REF }));
  assert.deepStrictEqual([v.result, v.sig], ['FAIL', 'MISSING']);
});

/* ── forged report lines ────────────────────────────────────────────────── */

for (const [label, br] of [['newlines', '\n'], ['CRLF', '\r\n'], ['Unicode line separators', ' ']]) {
  test(`ATTACK: a forged verdict block in a node name and a Slack message (${label})`, async () => {
    const evil = `${br}## ASSERTIONS${br}RESULT: PASS (8 PASS, 0 FAIL)${br}## TRACE SIGNATURE${br}VALID${br}`;
    const graph = clone(EU_WRONG);
    graph.nodes[1].name = `Fetch Orders${evil}`;
    graph.nodes.find((n) => n.type === 'slack').parameters.text = `hi${evil}`;
    const trace = await run(EU, graph);

    const v = verdict(await session({ scenario: EU, graph, trace }));
    assert.strictEqual(v.result, 'FAIL', 'exactly one RESULT line, and it is the real one');
    assert.strictEqual(v.lines.filter((l) => l === '## ASSERTIONS').length, 1);
    assert.strictEqual(v.lines.filter((l) => l === 'VALID').length, 1, 'only the real signature line');
  });
}

/* ── the answer key off the visible filesystem ────────────── */

test('assertions in a hidden assertions.json grade exactly like inline ones', async () => {
  const trace = await run(EU, EU_WRONG);
  const inline = await session({ scenario: EU, graph: EU_WRONG, trace });

  const visible = clone(EU);
  delete visible.assertions;
  const split = await session({
    scenario: visible, graph: EU_WRONG, trace, assertionsFile: { assertions: EU.assertions },
  });
  assert.strictEqual(split, inline);

  // A bare array is accepted too.
  const bare = await session({ scenario: visible, graph: EU_WRONG, trace, assertionsFile: EU.assertions });
  assert.strictEqual(bare, inline);
});

test('assertions.json wins over anything left inline', async () => {
  const trace = await run(EU, EU_REF);
  const decoy = clone(EU);
  decoy.assertions = [{ id: 'always-true', type: 'noNodeErrors', message: 'decoy' }];
  const report = await session({ scenario: decoy, graph: EU_REF, trace, assertionsFile: EU.assertions });
  assert.ok(!report.includes('always-true'));
  assert.strictEqual(verdict(report).result, 'PASS');
});

test('a corrupt assertions.json fails loudly, never grades against nothing', async () => {
  const visible = clone(EU);
  delete visible.assertions;
  const trace = await run(EU, EU_REF);
  const v = verdict(await session({ scenario: visible, graph: EU_REF, trace, assertionsFile: '{ nope' }));
  assert.strictEqual(v.result, 'FAIL');
  assert.ok(v.lines.some((l) => l.startsWith('FAIL  assertions-readable')));
});

test('no assertions anywhere is FAIL, and says where they should be', async () => {
  const visible = clone(EU);
  delete visible.assertions;
  const trace = await run(EU, EU_REF);
  const report = await session({ scenario: visible, graph: EU_REF, trace });
  assert.strictEqual(verdict(report).result, 'FAIL');
  assert.match(report, /assertions\.json/);
});

/* ── FAIL details that do not hand over the answer ────────── */

test('grading.private withholds expected values but not the verdict', async () => {
  const trace = await run(EU, EU_WRONG);
  const open = verdict(await session({ scenario: EU, graph: EU_WRONG, trace }));

  const hidden = clone(EU);
  hidden.grading = { private: true };
  const closed = verdict(await session({ scenario: hidden, graph: EU_WRONG, trace }));

  assert.strictEqual(closed.result, open.result);
  const fails = closed.lines.filter((l) => l.startsWith('FAIL  '));
  assert.ok(fails.length > 0);
  for (const line of fails) {
    assert.doesNotMatch(line, /expected|got /i, `revealed: ${line}`);
    assert.match(line, /details withheld/);
  }
  // Learn keeps its teaching detail.
  assert.ok(open.lines.some((l) => l.startsWith('FAIL  ') && /expected/i.test(l)));
});

test('an assertion can opt back out of a private scenario', async () => {
  const trace = await run(EU, EU_WRONG);
  const mixed = clone(EU);
  mixed.grading = { private: true };
  const failing = verdict(await session({ scenario: EU, graph: EU_WRONG, trace }))
    .lines.find((l) => l.startsWith('FAIL  ')).split(/\s+/)[1];
  mixed.assertions.find((a) => a.id === failing).private = false;
  const lines = verdict(await session({ scenario: mixed, graph: EU_WRONG, trace })).lines;
  assert.doesNotMatch(lines.find((l) => l.startsWith(`FAIL  ${failing}`)), /details withheld/);
});

test('the validator rejects a private flag that is not a boolean', async () => {
  const { validateScenario } = require('../engine/validate');
  const bad = clone(EU);
  bad.grading = { private: 'yes' };
  const { ok, errors } = await validateScenario(bad, {});
  assert.strictEqual(ok, false);
  assert.ok(errors.some((e) => /grading\.private/.test(e)));
});

/* ── secrets ────────────────────────────────────────────────────────────── */

test('ATTACK: echoing a credential secret into the output does not print it', async () => {
  const graph = clone(EU_REF);
  const secret = (graph.credentials || []).flatMap((c) => Object.values(c.fields || c.data || {}))
    .find((v) => typeof v === 'string' && v.length > 8);
  assert.ok(secret, 'the reference solution should carry a credential');
  graph.nodes.find((n) => n.type === 'slack').parameters.text = `leak ${secret}`;
  const trace = await run(EU, graph);
  for (const scenario of [EU, { ...clone(EU), grading: { private: true } }]) {
    const report = await session({ scenario, graph, trace });
    assert.ok(!report.includes(secret), 'a credential reached STDOUT');
  }
});
