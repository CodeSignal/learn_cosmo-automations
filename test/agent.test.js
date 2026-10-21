'use strict';

/**
 * The Agent node, and why a replayed model call is still worth grading.
 *
 * The objection to agents in an assessment is that a model is non-deterministic,
 * so nothing it says can be asserted on. The answer is that the model's prose was
 * never the interesting part. Three things are, and all three are deterministic:
 *
 *   1. the PROMPT — static text in the graph
 *   2. the OUTPUT CONTRACT — text, or the fields a Structured Output Parser asks
 *      for, and whether the rest of their workflow can read them
 *   3. the CALL PATTERN — how many calls, on which model, which is the bill
 *
 * The tests below are organised around those three, plus the property that makes
 * them possible: the engine can only replay, and a fixture is keyed to the input
 * rather than to the prompt.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run } = require('../engine');
const { executeWorkflow } = require('../engine/scheduler');
const { resolveAgentCall } = require('../engine/ai/resolver');
const { evaluateAssertions } = require('../grading/assertions');
const { formatReport } = require('../grading/format');
const { validateScenario } = require('../engine/validate');

const DIR = path.join(__dirname, '..', 'scenarios', 'ticket-triage-ai');
const scenario = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));
const reference = JSON.parse(fs.readFileSync(path.join(DIR, 'reference_solution.json'), 'utf8'));

const BARE = {
  triggerPayload: { manualTrigger: [{}] },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
  mockApi: { hosts: {} },
  ai: {
    mode: 'replay',
    models: ['m1'],
    fixtures: [
      { id: 'hot', when: { input: { topic: 'outage' } }, respond: { label: 'urgent', score: 5 } },
      { id: 'default', when: {}, respond: { label: 'normal', score: 1 } },
    ],
  },
};

/** Run one agent; `fields` attaches a Structured Output Parser, null leaves it answering in text. */
async function runAgent(parameters, items = [{ topic: 'outage' }], scenarioOverride = {}, fields = FIELDS) {
  const graph = {
    nodes: [
      { id: 't', name: 'T', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'a', name: 'Classify', type: 'agent', position: [1, 0], parameters },
      ...(fields ? [{ id: 'p', name: 'Parser', type: 'outputParser', position: [1, 1], parameters: { fields } }] : []),
    ],
    connections: [
      { from: 't', fromOutput: 0, to: 'a', toInput: 0 },
      ...(fields ? [{ from: 'p', fromOutput: 0, to: 'a', toInput: 2 }] : []),
    ],
  };
  const trace = await executeWorkflow(
    { ...BARE, ...scenarioOverride, triggerPayload: { manualTrigger: items } }, graph,
  );
  const record = trace.nodes.find((n) => n.name === 'Classify');
  return { trace, record, out: (record.output || []).map((i) => i.json) };
}

const PARAMS = {
  mode: 'runOncePerItem',
  model: 'm1',
  systemPrompt: 'You are a classifier.',
  userPrompt: '=Classify {{ $json.topic }}',
};
const FIELDS = ['label', 'score'];

/* ── the property everything else rests on ─────────────────────────────── */

test('the engine replays and cannot go live, whatever the scenario asks for', () => {
  for (const mode of ['live', 'record']) {
    const res = resolveAgentCall({ ai: { mode, fixtures: [{ when: {}, respond: {} }] } },
      { nodeName: 'A', input: {} });
    assert.strictEqual(res.ok, false);
    assert.ok(res.denied);
    assert.match(res.explanation, /only replays/);
  }
});

test('a fixture is keyed to the INPUT, so rewording the prompt cannot change the answer', async () => {
  const terse = await runAgent({ ...PARAMS, userPrompt: '=Classify {{ $json.topic }}' });
  const verbose = await runAgent({
    ...PARAMS,
    systemPrompt: 'You are a meticulous senior triage analyst. Think step by step.',
    userPrompt: '=Please classify the following topic carefully: {{ $json.topic }}. '
      + 'Return a label and a score from 1 to 5.',
  });

  assert.deepStrictEqual(terse.out, verbose.out,
    'a candidate who writes a BETTER prompt must not get a different fixture — keying on '
    + 'prompt text would fail them for improving');
  assert.strictEqual(terse.out[0].output.label, 'urgent');
});

test('two runs of the same workflow are identical', async () => {
  const a = await run(scenario, reference);
  const b = await run(scenario, reference);
  assert.deepStrictEqual(
    a.nodes.map((n) => [n.name, n.itemsIn, n.itemsOut, JSON.stringify(n.output)]),
    b.nodes.map((n) => [n.name, n.itemsIn, n.itemsOut, JSON.stringify(n.output)]),
  );
  assert.deepStrictEqual(a.aiCalls, b.aiCalls);
});

test('an unmatched call is refused loudly, naming what it tried', async () => {
  const { record } = await runAgent(PARAMS, [{ topic: 'outage' }], {
    ai: { mode: 'replay', models: ['m1'], fixtures: [{ id: 'x', when: { input: { topic: 'nope' } }, respond: {} }] },
  });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /No AI fixture matches/);
  assert.match(record.error, /topic="outage"/);
});

test('a task with no fixtures says so, and blames the task rather than the candidate', async () => {
  const { record } = await runAgent(PARAMS, [{ topic: 'x' }], { ai: { mode: 'replay' } });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /task-authoring gap/);
});

/* ── 1. the prompt ─────────────────────────────────────────────────────── */

test('an empty prompt is an error, not an empty call', async () => {
  const { record } = await runAgent({ ...PARAMS, userPrompt: '' });
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /user prompt is empty/);
});

test('the prompt is graded from the graph, with no model involved', () => {
  const hardcoded = JSON.parse(JSON.stringify(reference));
  hardcoded.nodes.find((n) => n.type === 'agent').parameters.userPrompt =
    'Classify this ticket. Subject: Card declined at checkout';

  const results = evaluateAssertions(scenario, hardcoded, { nodes: [], aiCalls: [], httpCalls: [], sinks: {} });
  const prompt = results.find((r) => r.id === 'prompt-includes-the-ticket');
  assert.strictEqual(prompt.pass, false);
  assert.match(prompt.detail, /\$json\./);
});

/* ── 2. the output contract ────────────────────────────────────────────── */

test('with an output parser, the fields go on the item as output, so downstream reads them', async () => {
  const { out } = await runAgent(PARAMS, [{ topic: 'outage', ticket: 'T-9' }]);
  assert.deepStrictEqual(out, [{ topic: 'outage', ticket: 'T-9', output: { label: 'urgent', score: 5 } }]);
});

test('without an output parser, the agent answers in text', async () => {
  const textual = {
    ai: { mode: 'replay', models: ['m1'], fixtures: [{ id: 'say', when: {}, respond: 'Urgent: an outage.' }] },
  };
  const { out, record } = await runAgent(PARAMS, [{ topic: 'outage' }], textual, null);
  assert.strictEqual(record.status, 'success');
  assert.deepStrictEqual(out, [{ topic: 'outage', output: 'Urgent: an outage.' }]);
});

test('an answer recorded as fields still reads as text when no parser asks for fields', async () => {
  const { out } = await runAgent(PARAMS, [{ topic: 'outage' }], {}, null);
  assert.strictEqual(out[0].output, JSON.stringify({ label: 'urgent', score: 5 }));
});

test('a text answer where the parser asks for fields is named', async () => {
  const textual = {
    ai: { mode: 'replay', models: ['m1'], fixtures: [{ id: 'say', when: {}, respond: 'Urgent.' }] },
  };
  const { record } = await runAgent(PARAMS, [{ topic: 'outage' }], textual);
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /answered in text, not in the fields the output parser asks for/);
});

test('a parser that names no fields is an error, and says how to fix it', async () => {
  const { record } = await runAgent(PARAMS, [{ topic: 'outage' }], {}, []);
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /names no fields/);
});

test('asking for fields the model did not return is named, not left undefined', async () => {
  const { record } = await runAgent(PARAMS, [{ topic: 'outage' }], {}, ['sentiment', 'urgency']);
  assert.strictEqual(record.status, 'error');
  assert.match(record.error, /none of the fields the output parser asks for/);
  assert.match(record.error, /sentiment, urgency/);
  assert.match(record.error, /It returned: label, score/);
});

test('a partially-honoured schema still flows, with the missing field visible as undefined', async () => {
  const { out, record } = await runAgent(PARAMS, [{ topic: 'outage' }], {}, ['label', 'confidence']);
  assert.strictEqual(record.status, 'success');
  assert.strictEqual(out[0].output.label, 'urgent');
  assert.ok('confidence' in out[0].output && out[0].output.confidence === undefined,
    'the field the model ignored is present and empty, which is what happens in production');
});

test('a parser can only go into an Output Parser port, and an agent takes one', async () => {
  const graph = {
    nodes: [
      { id: 't', name: 'T', type: 'manualTrigger', position: [0, 0], parameters: {} },
      { id: 'a', name: 'Classify', type: 'agent', position: [1, 0], parameters: PARAMS },
      { id: 'p', name: 'Parser', type: 'outputParser', position: [1, 1], parameters: { fields: FIELDS } },
      { id: 'q', name: 'Parser 2', type: 'outputParser', position: [1, 2], parameters: { fields: FIELDS } },
    ],
    connections: [{ from: 't', fromOutput: 0, to: 'a', toInput: 0 }],
  };
  const intoData = await executeWorkflow(BARE, {
    ...graph, connections: [...graph.connections, { from: 'p', fromOutput: 0, to: 'a', toInput: 0 }],
  });
  assert.match(intoData.errors[0].message, /can only connect to the Output Parser port/);
  const two = await executeWorkflow(BARE, {
    ...graph,
    connections: [...graph.connections,
      { from: 'p', fromOutput: 0, to: 'a', toInput: 2 }, { from: 'q', fromOutput: 0, to: 'a', toInput: 2 }],
  });
  assert.match(two.errors[0].message, /more than one output parser/);
});

/* ── 3. the call pattern, which is the bill ────────────────────────────── */

test('once per item is one call per item; once for all items is one call', async () => {
  const three = [{ topic: 'outage' }, { topic: 'other' }, { topic: 'outage' }];

  const perItem = await runAgent({ ...PARAMS, mode: 'runOncePerItem' }, three);
  assert.strictEqual(perItem.trace.aiCalls.length, 3);
  assert.strictEqual(perItem.record.itemsOut, 3);

  const allItems = await runAgent({ ...PARAMS, mode: 'runOnceForAllItems' }, three);
  assert.strictEqual(allItems.trace.aiCalls.length, 1);
  assert.strictEqual(allItems.record.itemsOut, 1, 'one call, one answer');
});

test('aiCalled asserts the count and the model', async () => {
  const trace = await run(scenario, reference);
  const check = (a) => evaluateAssertions({ ...scenario, assertions: [{ id: 'x', type: 'aiCalled', ...a }] },
    reference, trace)[0];

  assert.ok(check({ model: 'gpt-5-mini', times: 6 }).pass);
  assert.ok(!check({ model: 'gpt-5', times: 6 }).pass, 'the expensive model was not used');
  assert.ok(check({ times: 6 }).pass, 'model is optional');
  assert.ok(check({ node: 'Classify Ticket', times: 6 }).pass, 'and it can target one node');
  assert.match(check({ model: 'gpt-5', times: 6 }).detail, /models used: gpt-5-mini/);
});

test('the report shows the calls and the model on the node line', async () => {
  const trace = await run(scenario, reference);
  const report = formatReport({
    scenario, graph: reference, trace, graphHash: trace.graphHash,
    assertions: evaluateAssertions(scenario, reference, trace),
  });
  const line = report.split('\n').find((l) => l.includes('Classify Ticket') && l.includes('in='));
  assert.match(line, /6× gpt-5-mini/,
    'in=6 out=6 looks like a Set node; six model calls is the expensive fact');
});

/* ── the scenario discriminates ────────────────────────────────────────── */

test('the task rejects each realistic wrong answer, for the right reason', async () => {
  const variant = (mutate, type = 'agent') => { const g = JSON.parse(JSON.stringify(reference)); mutate(g.nodes.find((n) => n.type === type).parameters); return g; };
  const withoutParser = JSON.parse(JSON.stringify(reference));
  const parserId = withoutParser.nodes.find((n) => n.type === 'outputParser').id;
  withoutParser.nodes = withoutParser.nodes.filter((n) => n.id !== parserId);
  withoutParser.connections = withoutParser.connections.filter((c) => c.from !== parserId);

  const cases = [
    ['expensive model', variant((p) => { p.model = 'gpt-5'; }), 'one-cheap-call-per-ticket'],
    ['hardcoded prompt', variant((p) => { p.userPrompt = 'Classify: Card declined'; }), 'prompt-includes-the-ticket'],
    ['one call for all', variant((p) => { p.mode = 'runOnceForAllItems'; }), 'one-cheap-call-per-ticket'],
    ['missing field', variant((p) => { p.fields = ['category']; }, 'outputParser'), 'asks-for-severity'],
    ['text, no parser', withoutParser, 'answers-in-fields'],
  ];

  for (const [name, graph, expectedFailure] of cases) {
    const trace = await run(scenario, graph);
    const fails = evaluateAssertions(scenario, graph, trace).filter((r) => !r.pass).map((r) => r.id);
    assert.ok(fails.includes(expectedFailure),
      `"${name}" should fail ${expectedFailure}; it failed ${fails.join(', ') || 'nothing'}`);
  }

  // And the reference still passes, so the above is discrimination, not strictness.
  const ok = await run(scenario, reference);
  assert.deepStrictEqual(evaluateAssertions(scenario, reference, ok).filter((r) => !r.pass), []);
});

/* ── authoring guardrails ──────────────────────────────────────────────── */

test('offering an Agent without fixtures or models is refused at authoring time', async () => {
  const report = await validateScenario({
    title: 'x',
    palette: { include: ['manualTrigger', 'agent'] },
    triggerPayload: { manualTrigger: [{}] },
    mockApi: { hosts: {} },
  });
  assert.ok(report.errors.some((e) => /ai\.fixtures` declares nothing/.test(e)));
  assert.ok(report.errors.some((e) => /ai\.models` declares no models/.test(e)));
});

test('a fixture may not match on the prompt, and the error says why', async () => {
  const report = await validateScenario({
    title: 'x',
    palette: { include: ['manualTrigger'] },
    triggerPayload: { manualTrigger: [{}] },
    mockApi: { hosts: {} },
    ai: { mode: 'replay', models: ['m'], fixtures: [{ id: 'a', when: { prompt: 'classify' }, respond: {} }] },
  });
  assert.ok(report.errors.some((e) => /when\."prompt"/.test(e) && /improves their prompt/.test(e)),
    `expected a refusal explaining why, got: ${report.errors.join(' | ')}`);
});

test('fixtures with no catch-all are warned about', async () => {
  const report = await validateScenario({
    title: 'x',
    palette: { include: ['manualTrigger'] },
    triggerPayload: { manualTrigger: [{}] },
    mockApi: { hosts: {} },
    ai: { mode: 'replay', models: ['m'], fixtures: [{ id: 'a', when: { input: { x: 1 } }, respond: { y: 2 } }] },
  });
  assert.ok(report.warnings.some((w) => /catch-all/.test(w)));
});

/* ── Wait For Approval, and resuming by re-running ─────────────────────── */

const APPROVAL_SCENARIO = {
  triggerPayload: { manualTrigger: [{ id: 1 }, { id: 2 }, { id: 3 }] },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
  mockApi: { hosts: {} },
};

const APPROVAL_GRAPH = {
  nodes: [
    { id: 't', name: 'Start', type: 'manualTrigger', position: [0, 0], parameters: {} },
    { id: 'a', name: 'Confirm Send', type: 'approval', position: [1, 0], parameters: { prompt: 'Send these 3 refunds?' } },
    { id: 'y', name: 'Send', type: 'noOp', position: [2, -1], parameters: {} },
    { id: 'n', name: 'Archive', type: 'noOp', position: [2, 1], parameters: {} },
  ],
  connections: [
    { from: 't', fromOutput: 0, to: 'a', toInput: 0 },
    { from: 'a', fromOutput: 0, to: 'y', toInput: 0 },
    { from: 'a', fromOutput: 1, to: 'n', toInput: 0 },
  ],
};

const statusOf = (trace, name) => (trace.nodes.find((n) => n.name === name) || {}).status;

test('an interactive run stops at the approval and says what it is waiting for', async () => {
  const trace = await executeWorkflow(APPROVAL_SCENARIO, APPROVAL_GRAPH, { interactive: true });

  assert.strictEqual(trace.status, 'paused');
  assert.strictEqual(statusOf(trace, 'Confirm Send'), 'paused');
  assert.strictEqual(trace.awaiting.node, 'Confirm Send');
  assert.strictEqual(trace.awaiting.prompt, 'Send these 3 refunds?');
  assert.strictEqual(trace.awaiting.items.length, 3, 'the decision is about these items');
  assert.strictEqual(statusOf(trace, 'Send'), undefined, 'nothing past the pause ran');
});

test('approve and reject each send the items down their own branch', async () => {
  const approved = await executeWorkflow(APPROVAL_SCENARIO, APPROVAL_GRAPH,
    { interactive: true, decisions: { 'Confirm Send': 'approve' } });
  assert.strictEqual(approved.status, 'completed');
  assert.strictEqual(statusOf(approved, 'Send'), 'success');
  assert.strictEqual(statusOf(approved, 'Archive'), 'noItems');

  const rejected = await executeWorkflow(APPROVAL_SCENARIO, APPROVAL_GRAPH,
    { interactive: true, decisions: { 'Confirm Send': 'reject' } });
  assert.strictEqual(rejected.status, 'completed');
  assert.strictEqual(statusOf(rejected, 'Send'), 'noItems');
  assert.strictEqual(statusOf(rejected, 'Archive'), 'success');
});

test('resuming is re-running with one more answer, and the counts do not double', async () => {
  const paused = await executeWorkflow(APPROVAL_SCENARIO, APPROVAL_GRAPH, { interactive: true });
  const resumed = await executeWorkflow(APPROVAL_SCENARIO, APPROVAL_GRAPH,
    { interactive: true, decisions: { 'Confirm Send': 'approve' } });

  assert.strictEqual(paused.status, 'paused');
  assert.strictEqual(resumed.status, 'completed');

  // The trace is rebuilt from scratch, so the nodes before the pause appear once
  // with their real counts — the thing a state-snapshot design has to work for.
  assert.strictEqual(resumed.nodes.filter((n) => n.name === 'Start').length, 1);
  assert.strictEqual(resumed.nodes.find((n) => n.name === 'Send').itemsIn, 3);
});

test('a headless run uses scenario.approvals; an interactive one ignores it and asks', async () => {
  const scripted = { ...APPROVAL_SCENARIO, approvals: { 'Confirm Send': 'approve' } };

  const headless = await executeWorkflow(scripted, APPROVAL_GRAPH, {});
  assert.strictEqual(headless.status, 'completed', 'the validator and run.js must get past it');

  const interactive = await executeWorkflow(scripted, APPROVAL_GRAPH, { interactive: true });
  assert.strictEqual(interactive.status, 'paused',
    'a candidate is asked even when the task scripts an answer for headless runs');
});

test('the decision is recorded on the node, so a grader can see which way it went', async () => {
  const trace = await executeWorkflow(APPROVAL_SCENARIO, APPROVAL_GRAPH,
    { interactive: true, decisions: { 'Confirm Send': 'reject' } });
  const record = trace.nodes.find((n) => n.name === 'Confirm Send');
  assert.strictEqual(record.decision, 'reject');
  assert.deepStrictEqual(record.outputsByPort, [
    { port: 0, name: 'approved', count: 0 },
    { port: 1, name: 'rejected', count: 3 },
  ]);
});

test('a paused run is never the graded run', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /!trace\.partial && trace\.status !== 'paused'/,
    'execution.json must not be written for a run that stopped at an approval');
});

test('the AI scenario runs end to end through its approval', async () => {
  const trace = await run(scenario, reference);
  assert.strictEqual(trace.status, 'completed');
  const results = evaluateAssertions(scenario, reference, trace);
  assert.deepStrictEqual(results.filter((r) => !r.pass), []);

  // And an unwired rejection path is caught.
  const unwired = JSON.parse(JSON.stringify(reference));
  unwired.connections = unwired.connections.filter((c) => !(c.fromOutput === 1 && c.from === 'n8'));
  const bad = evaluateAssertions(scenario, unwired, await run(scenario, unwired));
  assert.ok(bad.some((r) => r.id === 'rejection-goes-somewhere' && !r.pass));
});
