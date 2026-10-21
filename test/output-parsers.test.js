'use strict';

/**
 * Output parsers: what shape an AI Agent's answer takes.
 *
 * No parser means text. A Structured Output Parser asks for named fields — by a
 * list, a JSON example or a JSON Schema. An Item List Output Parser turns one
 * answer into one item per entry. An Auto-fixing Output Parser wraps either and
 * has a model fix an answer that does not fit, as a model call of its own.
 */

const test = require('node:test');
const assert = require('node:assert');

const { executeWorkflow } = require('../engine/scheduler');
const { createLiveAgent } = require('../live/openai');
const { startFakeProxy, toolCall, text } = require('../scripts/fake-llm-proxy');

const PARAMS = {
  mode: 'runOncePerItem', model: 'm1', systemPrompt: 'You read emails.', userPrompt: '=Read {{ $json.email }}',
};

const scenarioWith = (fixtures, extra = {}) => ({
  triggerPayload: { manualTrigger: [{ email: 'E-1' }] },
  limits: { maxNodes: 40, maxItems: 5000, maxExecutionMs: 5000 },
  mockApi: { hosts: {} },
  ai: { mode: 'replay', models: ['m1', 'fixer'], fixtures },
  ...extra,
});

/**
 * Trigger → agent, with `parsers` attached: the first to the agent's Output
 * Parser port, each further one to the Output Parser port of the one before.
 */
function graphWith(parsers, agentParams = PARAMS) {
  const nodes = [
    { id: 't', name: 'T', type: 'manualTrigger', position: [0, 0], parameters: {} },
    { id: 'a', name: 'Agent', type: 'agent', position: [1, 0], parameters: agentParams },
  ];
  const connections = [{ from: 't', fromOutput: 0, to: 'a', toInput: 0 }];
  let owner = { id: 'a', port: 2 };
  parsers.forEach((p, i) => {
    const id = `p${i}`;
    nodes.push({ id, name: p.name || `Parser ${i}`, type: p.type, position: [1, i + 1], parameters: p.parameters || {} });
    connections.push({ from: id, fromOutput: 0, to: owner.id, toInput: owner.port });
    owner = { id, port: 0 };
  });
  return { nodes, connections };
}

async function runWith(fixtures, parsers, options = {}, extra = {}) {
  const trace = await executeWorkflow(scenarioWith(fixtures, extra), graphWith(parsers, options.agentParams), options.run || {});
  const agent = trace.nodes.find((n) => n.id === 'a');
  return { trace, agent, out: (agent.output || []).map((i) => i.json) };
}

const STRUCTURED = (parameters) => ({ type: 'outputParser', parameters });
const LIST = (parameters = {}) => ({ type: 'listOutputParser', parameters });
const FIXER = (model = 'fixer', name = 'Fixer') => ({ type: 'autoFixingOutputParser', name, parameters: { model } });

/* ── Structured Output Parser ──────────────────────────────────────────── */

test('a JSON example defines the fields by its keys', async () => {
  const { out } = await runWith([{ id: 'f', when: {}, respond: { urgent: true, topic: 'billing', extra: 'x' } }],
    [STRUCTURED({ mode: 'example', jsonExample: '{ "urgent": false, "topic": "text" }' })]);
  assert.deepStrictEqual(out[0].output, { urgent: true, topic: 'billing' });
});

test('a JSON Schema defines the fields by its properties', async () => {
  const schema = { type: 'object', properties: { topic: { type: 'string' }, people: { type: 'array', items: { type: 'string' } } } };
  const { out } = await runWith([{ id: 'f', when: {}, respond: { topic: 'hiring', people: ['Ana', 'Ben'] } }],
    [STRUCTURED({ mode: 'schema', jsonSchema: JSON.stringify(schema) })]);
  assert.deepStrictEqual(out[0].output, { topic: 'hiring', people: ['Ana', 'Ben'] });
});

test('invalid JSON in the parser is named, not a crash', async () => {
  const { agent } = await runWith([{ id: 'f', when: {}, respond: {} }],
    [STRUCTURED({ mode: 'example', jsonExample: '{ topic: ' })]);
  assert.strictEqual(agent.status, 'error');
  assert.match(agent.error, /The JSON example in "Parser 0" is not valid JSON/);
});

/* ── Item List Output Parser ───────────────────────────────────────────── */

test('a list answer becomes one item per entry, each keeping its input', async () => {
  const { out, agent } = await runWith(
    [{ id: 'f', when: {}, respond: '1. Send the contract\n2. Book the room\n- Call Dana back\n\n' }], [LIST()]);
  assert.deepStrictEqual(out, [
    { email: 'E-1', output: 'Send the contract' },
    { email: 'E-1', output: 'Book the room' },
    { email: 'E-1', output: 'Call Dana back' },
  ]);
  assert.deepStrictEqual([agent.itemsIn, agent.itemsOut], [1, 3]);
});

test('a recorded list is used as is, and the cap keeps the first entries', async () => {
  const { out } = await runWith([{ id: 'f', when: {}, respond: ['a', 'b', 'c', 'd'] }], [LIST({ maxItems: 2 })]);
  assert.deepStrictEqual(out.map((o) => o.output), ['a', 'b']);
});

test('a custom separator splits a one-line answer', async () => {
  const { out } = await runWith([{ id: 'f', when: {}, respond: 'red; green ;blue' }], [LIST({ separator: ';' })]);
  assert.deepStrictEqual(out.map((o) => o.output), ['red', 'green', 'blue']);
});

test('once for all items, the entries carry nothing from the inputs', async () => {
  const { out } = await runWith([{ id: 'f', when: {}, respond: ['x', 'y'] }], [LIST()],
    { agentParams: { ...PARAMS, mode: 'runOnceForAllItems' } });
  assert.deepStrictEqual(out, [{ output: 'x' }, { output: 'y' }]);
});

/* ── Auto-fixing Output Parser ─────────────────────────────────────────── */

test('an answer that does not fit is fixed from the recording, as a call of its own', async () => {
  const fixtures = [{ id: 'f', when: {}, respond: 'topic is billing, urgent yes', fixed: { topic: 'billing', urgent: true } }];
  const { out, trace, agent } = await runWith(fixtures, [FIXER(), STRUCTURED({ fields: ['topic', 'urgent'] })]);
  assert.strictEqual(agent.status, 'success');
  assert.deepStrictEqual(out[0].output, { topic: 'billing', urgent: true });
  const fix = trace.aiCalls.find((c) => c.fixer);
  assert.deepStrictEqual([fix.node, fix.via, fix.model, fix.fixture], ['Fixer', 'Agent', 'fixer', 'f']);
  assert.strictEqual(trace.aiCalls.length, 2, 'the agent\'s call and the fix');
});

test('an answer that already fits passes through without a fix', async () => {
  const fixtures = [{ id: 'f', when: {}, respond: { topic: 'billing', urgent: false }, fixed: { topic: 'never used' } }];
  const { out, trace } = await runWith(fixtures, [FIXER(), STRUCTURED({ fields: ['topic', 'urgent'] })]);
  assert.deepStrictEqual(out[0].output, { topic: 'billing', urgent: false });
  assert.ok(!trace.aiCalls.some((c) => c.fixer));
});

test('with nothing recorded to fix it with, the agent fails and says why', async () => {
  const { agent, trace } = await runWith([{ id: 'f', when: {}, respond: 'just text' }],
    [FIXER(), STRUCTURED({ fields: ['topic'] })]);
  assert.strictEqual(agent.status, 'error');
  assert.match(agent.error, /"Fixer" could not fix it: the task records no fixed answer/);
  assert.ok(trace.aiCalls.some((c) => c.fixer && c.denied));
});

test('an auto-fixer needs a parser to fix towards, and cannot wrap another', async () => {
  const lone = await runWith([{ id: 'f', when: {}, respond: {} }], [FIXER()]);
  assert.match(lone.agent.error, /"Fixer" has no parser to fix answers for/);
  const nested = await runWith([{ id: 'f', when: {}, respond: {} }], [FIXER(), FIXER('fixer', 'Inner Fixer'), STRUCTURED({ fields: ['a'] })]);
  assert.match(nested.agent.error, /wraps another Auto-fixing Output Parser/);
});

test('the same workflow fixes the same way every run', async () => {
  const fixtures = [{ id: 'f', when: {}, respond: 'oops', fixed: { topic: 'billing' } }];
  const a = await runWith(fixtures, [FIXER(), STRUCTURED({ fields: ['topic'] })]);
  const b = await runWith(fixtures, [FIXER(), STRUCTURED({ fields: ['topic'] })]);
  assert.deepStrictEqual(a.trace.aiCalls, b.trace.aiCalls);
  assert.deepStrictEqual(a.out, b.out);
});

/* ── live ──────────────────────────────────────────────────────────────── */

const LIVE = { enabled: true, provider: 'openai', models: { m1: 'model-1', fixer: 'model-fix' } };

async function withLive(handler, fn) {
  const proxy = await startFakeProxy({ handler });
  try {
    await fn(proxy, createLiveAgent({ apiKey: 'k', baseUrl: proxy.url }));
  } finally {
    await proxy.close();
  }
}

test('live, a JSON example becomes a typed schema for the model', async () => {
  await withLive(() => toolCall('respond', { urgent: true, topic: 'billing' }), async (proxy, liveAgent) => {
    const { out } = await runWith([{ id: 'f', when: {}, respond: {} }],
      [STRUCTURED({ mode: 'example', jsonExample: '{ "urgent": false, "topic": "text", "count": 2 }' })],
      { run: { liveAgent } }, { ai: { mode: 'replay', models: ['m1'], live: LIVE, fixtures: [{ id: 'f', when: {}, respond: {} }] } });
    assert.deepStrictEqual([out[0].output.urgent, out[0].output.topic], [true, 'billing']);
    assert.ok('count' in out[0].output, 'the field the model left out is present and empty');
    const respond = proxy.requests[0].body.tools.find((t) => t.function.name === 'respond');
    assert.deepStrictEqual(respond.function.parameters.properties,
      { urgent: { type: 'boolean' }, topic: { type: 'string' }, count: { type: 'integer' } });
  });
});

test('live, a list parser asks for one entry per line and splits the answer', async () => {
  await withLive(() => text('- one\n- two'), async (proxy, liveAgent) => {
    const { out } = await runWith([], [LIST({ maxItems: 5 })], { run: { liveAgent } },
      { ai: { mode: 'replay', models: ['m1'], live: LIVE, fixtures: [{ id: 'f', when: {}, respond: [] }] } });
    assert.deepStrictEqual(out.map((o) => o.output), ['one', 'two']);
    const user = proxy.requests[0].body.messages.find((m) => m.role === 'user').content;
    assert.match(user, /one entry per line, nothing else\. Give at most 5 entries\./);
  });
});

test('live, an answer through the respond function always fits, so no fix is paid for', async () => {
  let calls = 0;
  await withLive(() => { calls += 1; return toolCall('respond', { topic: 'billing' }); }, async (_proxy, liveAgent) => {
    const fixtures = [{ id: 'f', when: {}, respond: { topic: 'billing' } }];
    const { out, trace } = await runWith(fixtures, [FIXER(), STRUCTURED({ fields: ['topic'] })], { run: { liveAgent } },
      { ai: { mode: 'replay', models: ['m1', 'fixer'], live: LIVE, fixtures } });
    assert.deepStrictEqual(out[0].output, { topic: 'billing' });
    assert.ok(!trace.aiCalls.some((c) => c.fixer));
    assert.strictEqual(calls, 1, 'one call: the agent\'s');
  });
});
