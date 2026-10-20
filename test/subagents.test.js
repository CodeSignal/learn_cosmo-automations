'use strict';

/**
 * Subagents: an AI Agent Tool attached to an agent's Tools port.
 *
 * The parent's fixture records which tools the model called and with what input;
 * each subagent answers from its own fixture. Nothing here reaches a model, so
 * every behaviour below is exact and repeatable.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('../engine');
const { evaluateAssertions } = require('../grading/assertions');
const { validateScenario } = require('../engine/validate');
const { grade } = require('../parse_automation_solution');

const DIR = path.join(__dirname, '..', 'scenarios', 'refund-desk-agents');
const SCENARIO = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));
const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'reference_solution.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const node = (g, id) => g.nodes.find((n) => n.id === id);
const AGENT = 'n4';
const TOOL = 'n5';

test('the reference solution delegates three lookups and passes every assertion', async () => {
  const trace = await run(SCENARIO, REF);
  assert.strictEqual(trace.status, 'completed');

  const lookups = trace.aiCalls.filter((c) => c.tool === 'lookup_order');
  assert.strictEqual(lookups.length, 3);
  assert.ok(lookups.every((c) => c.via === 'Decide Refund' && c.model === 'gpt-5-mini'));
  assert.strictEqual(trace.aiCalls.filter((c) => !c.tool).length, 4);

  const record = trace.nodes.find((r) => r.id === TOOL);
  assert.deepStrictEqual([record.status, record.itemsIn, record.itemsOut], ['success', 3, 3]);

  const failed = evaluateAssertions(SCENARIO, REF, trace).filter((a) => !a.pass);
  assert.deepStrictEqual(failed, []);
});

test('a tool never runs as a step, and carries no items', async () => {
  const trace = await run(SCENARIO, REF);
  assert.ok(!trace.finalPayloads['Look Up Order']);
  // The agent's only data input is the split-out requests.
  assert.strictEqual(trace.nodes.find((r) => r.id === AGENT).itemsIn, 4);
});

test('a tool wired into an ordinary input is refused with the reason', async () => {
  const g = clone(REF);
  g.connections.find((c) => c.from === TOOL).toInput = 0;
  const trace = await run(SCENARIO, g);
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /can only connect to the Tools input/);
});

test('an ordinary node wired into a Tools port is refused with the reason', async () => {
  const g = clone(REF);
  g.connections.push({ from: 'n3', fromOutput: 0, to: AGENT, toInput: 1 });
  const trace = await run(SCENARIO, g);
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /only takes AI Agent Tools/);
});

test('subagents calling each other in a circle are refused, naming the circle', async () => {
  const g = clone(REF);
  g.nodes.push({ ...clone(node(g, TOOL)), id: 'n9', name: 'Second Opinion' });
  g.connections.push({ from: 'n9', fromOutput: 0, to: TOOL, toInput: 0 });
  g.connections.push({ from: TOOL, fromOutput: 0, to: 'n9', toInput: 0 });
  const trace = await run(SCENARIO, g);
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /in a circle: .*Look Up Order.*Second Opinion|in a circle: .*Second Opinion.*Look Up Order/);
});

test('a disabled tool is not available, and the error says so', async () => {
  const g = clone(REF);
  node(g, TOOL).disabled = true;
  const trace = await run(SCENARIO, g);
  const agent = trace.nodes.find((r) => r.id === AGENT);
  assert.strictEqual(agent.status, 'error');
  assert.match(agent.error, /1 attached tool is disabled/);
  assert.strictEqual(trace.nodes.find((r) => r.id === TOOL).status, 'disabled');
});

test('a subagent with no expected fields fails its parent, naming the subagent', async () => {
  const g = clone(REF);
  node(g, TOOL).parameters.outputFields = [];
  const trace = await run(SCENARIO, g);
  assert.match(trace.nodes.find((r) => r.id === AGENT).error, /Subagent "Look Up Order" declares no expected output fields/);
  assert.strictEqual(trace.nodes.find((r) => r.id === TOOL).status, 'error');
});

test('a top-level catch-all never answers a subagent', async () => {
  const s = clone(SCENARIO);
  s.ai.fixtures = s.ai.fixtures.filter((f) => !(f.when && f.when.tool));
  const trace = await run(s, REF);
  const agent = trace.nodes.find((r) => r.id === AGENT);
  assert.strictEqual(agent.status, 'error');
  assert.match(agent.error, /subagent "Look Up Order" \(tool lookup_order\)/);
});

test('a subagent can have a subagent of its own', async () => {
  const s = clone(SCENARIO);
  s.ai.fixtures = s.ai.fixtures.map((f) => (f.id === 'lookup-O-1001'
    ? { ...f, calls: [{ tool: 'check_carrier', input: { orderId: 'O-1001' } }] } : f));
  s.ai.fixtures.push({ id: 'carrier', when: { tool: 'check_carrier' }, respond: { carrier: 'DHL' } });
  s.palette.include.push('agentTool');

  const g = clone(REF);
  g.nodes.push({
    id: 'n10', name: 'Check Carrier', type: 'agentTool', position: [380, 400],
    parameters: { toolName: 'check_carrier', description: 'Which carrier shipped an order.', model: 'gpt-5-mini', systemPrompt: '', userPrompt: '=Carrier for {{ $json.orderId }}', outputFields: ['carrier'] },
  });
  g.connections.push({ from: 'n10', fromOutput: 0, to: TOOL, toInput: 0 });

  const trace = await run(s, g);
  assert.strictEqual(trace.status, 'completed');
  const nested = trace.aiCalls.filter((c) => c.tool === 'check_carrier');
  assert.strictEqual(nested.length, 1);
  assert.strictEqual(nested[0].via, 'Look Up Order');
});

test('a tool nobody called is reported as never run', async () => {
  const s = clone(SCENARIO);
  s.ai.fixtures = s.ai.fixtures.map((f) => { const { calls, ...rest } = f; return rest; });
  const trace = await run(s, REF);
  assert.strictEqual(trace.nodes.find((r) => r.id === TOOL).status, 'notRun');
});

test('Execute Node on a tool is refused — it only runs when called', async () => {
  const trace = await run(SCENARIO, REF, { untilNode: TOOL });
  assert.strictEqual(trace.status, 'error');
  assert.match(trace.errors[0].message, /runs only when an agent calls it/);
});

test('grading re-runs a subagent workflow to the same trace', async () => {
  const trace = await run(SCENARIO, REF, { interactive: true, decisions: {}, simulateLatency: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-sub-'));
  const at = (f) => path.join(dir, f);
  fs.writeFileSync(at('config.json'), JSON.stringify(SCENARIO));
  fs.writeFileSync(at('solution.json'), JSON.stringify(REF));
  fs.writeFileSync(at('execution.json'), JSON.stringify(trace));
  const report = await grade({
    scenarioFile: at('config.json'), solutionFile: at('solution.json'), executionFile: at('execution.json'),
  });
  assert.match(report, /^RESULT: PASS/m);
  assert.match(report, /## TRACE SIGNATURE\nVALID/);
  assert.match(report, /Look Up Order → Decide Refund \[tool\]/);
  assert.match(report, /called by "Decide Refund"/);
});

/* ── validator ──────────────────────────────────────────────────────────── */

test('the validator refuses a call to a tool no fixture answers', async () => {
  const s = clone(SCENARIO);
  s.ai.fixtures = s.ai.fixtures.filter((f) => !(f.when && f.when.tool));
  const { ok, errors } = await validateScenario(s, {});
  assert.strictEqual(ok, false);
  assert.ok(errors.some((e) => /calls the tool "lookup_order", but no fixture/.test(e)));
});

test('the validator refuses a subagent with no agent to attach to', async () => {
  const s = clone(SCENARIO);
  s.palette.include = s.palette.include.filter((t) => t !== 'agent');
  s.assertions = s.assertions.filter((a) => a.nodeType !== 'agent' && a.toType !== 'agent');
  const { errors } = await validateScenario(s, {});
  assert.ok(errors.some((e) => /AI Agent Tool but not the AI Agent/.test(e)));
});

test('the validator checks the shape of calls and when.tool', async () => {
  const s = clone(SCENARIO);
  s.ai.fixtures[0].calls = [{ input: { orderId: 'x' } }];
  s.ai.fixtures[5].when.tool = '';
  const { errors } = await validateScenario(s, {});
  assert.ok(errors.some((e) => /calls\[0\] needs a `tool` name/.test(e)));
  assert.ok(errors.some((e) => /when\.tool must be a tool name/.test(e)));
});
