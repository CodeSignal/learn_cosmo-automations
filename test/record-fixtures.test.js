'use strict';

/**
 * The fixture recorder. No test here reaches a network: the provider is
 * either scripted or a stubbed `fetch`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run } = require('../engine');
const { evaluateAssertions } = require('../grading/assertions');
const { validateScenario } = require('../engine/validate');
const { recordFixtures, anthropicProvider } = require('../scripts/record-fixtures');

const DIR = path.join(__dirname, '..', 'scenarios', 'refund-desk-agents');
const SCENARIO = JSON.parse(fs.readFileSync(path.join(DIR, 'scenario.json'), 'utf8'));
const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'reference_solution.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

/** The scenario with every specific fixture removed; catch-alls stay. */
function bare() {
  const s = clone(SCENARIO);
  s.ai.fixtures = s.ai.fixtures.filter((f) => f.id === 'decide-catch-all' || f.id === 'lookup-catch-all');
  return s;
}

const DELIVERY = { 'O-1001': 3, 'O-1002': 12, 'O-1003': 5 };

/**
 * Behaves like a model would on this task: looks the order up when the reason
 * depends on delivery, decides under a 10-day rule, and answers lookups from a
 * table. Reads only the prompts and tools it is given — as a real one must.
 */
function scriptedModel() {
  const asked = [];
  const provider = async ({ user, tools, callTool, outputFields }) => {
    asked.push(user);
    if (outputFields.includes('daysSinceDelivery')) {
      const id = /O-\d+/.exec(user)[0];
      return { status: 'delivered', daysSinceDelivery: DELIVERY[id] };
    }
    const order = /Order: (O-\d+)/.exec(user)[1];
    if (/changed my mind/.test(user) || !tools.some((t) => t.name === 'lookup_order')) {
      return { decision: 'deny' };
    }
    const looked = await callTool('lookup_order', { orderId: order });
    return { decision: looked.daysSinceDelivery < 10 ? 'refund' : 'deny' };
  };
  provider.label = 'scripted';
  provider.model = 'test-model';
  return { provider, asked };
}

test('records every call, including the subagent the model chose to call', async () => {
  const { provider, asked } = scriptedModel();
  const { fixtures, recorded, unanswered } = await recordFixtures({ scenario: bare(), graph: REF, provider });

  assert.deepStrictEqual(unanswered, []);
  const top = recorded.filter((f) => !f.when.tool);
  const sub = recorded.filter((f) => f.when.tool === 'lookup_order');
  assert.strictEqual(top.length, 4);
  assert.strictEqual(sub.length, 3);
  assert.strictEqual(asked.length, 7, 'each distinct question asked once');

  const r1 = top.find((f) => f.when.input.request === 'R-01');
  assert.deepStrictEqual(r1.calls, [{ tool: 'lookup_order', input: { orderId: 'O-1001' } }]);
  assert.deepStrictEqual(r1.respond, { decision: 'refund' });
  assert.ok(!top.find((f) => f.when.input.request === 'R-04').calls, 'no lookup where none was needed');
  assert.deepStrictEqual(r1.recorded, { provider: 'scripted', model: 'test-model' });

  // Catch-alls go back last, or they would shadow everything recorded.
  assert.deepStrictEqual(fixtures.slice(-2).map((f) => f.id), ['decide-catch-all', 'lookup-catch-all']);
});

test('the recorded fixtures replay into a scenario that validates and the reference passes', async () => {
  const { provider } = scriptedModel();
  const scenario = bare();
  scenario.ai.fixtures = (await recordFixtures({ scenario, graph: REF, provider })).fixtures;

  const { ok, errors } = await validateScenario(scenario, { referenceSolution: REF });
  assert.deepStrictEqual(errors, []);
  assert.ok(ok);

  const trace = await run(scenario, REF);
  assert.deepStrictEqual(evaluateAssertions(scenario, REF, trace).filter((a) => !a.pass), []);
});

test('existing specific fixtures are kept and never asked again', async () => {
  const { provider, asked } = scriptedModel();
  const { recorded } = await recordFixtures({ scenario: clone(SCENARIO), graph: REF, provider });
  assert.strictEqual(recorded.length, 0);
  assert.strictEqual(asked.length, 0);
});

test('recorded ids are unique and never collide with existing ones', async () => {
  const { provider } = scriptedModel();
  const s = bare();
  s.ai.fixtures.unshift({ id: 'rec-decide-refund-1', when: { input: { request: 'nobody' } }, respond: { decision: 'deny' } });
  const { fixtures } = await recordFixtures({ scenario: s, graph: REF, provider });
  const ids = fixtures.map((f) => f.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('the recorder imports no network module — it uses the global fetch, and only when asked', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'record-fixtures.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](node:)?(http|https|net|tls|dgram|undici)['"]\)/);
});

test('the Anthropic provider needs a key, and speaks tool use correctly', async () => {
  assert.throws(() => anthropicProvider({}), /ANTHROPIC_API_KEY/);

  const sent = [];
  const replies = [
    { content: [{ type: 'tool_use', id: 't1', name: 'lookup_order', input: { orderId: 'O-1001' } }] },
    { content: [{ type: 'tool_use', id: 't2', name: 'respond', input: { decision: 'refund' } }] },
  ];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, json: async () => replies.shift() };
  };
  try {
    const ask = anthropicProvider({ apiKey: 'test-key', model: 'claude-test' });
    const toolCalls = [];
    const out = await ask({
      system: 'sys', user: 'decide R-01', outputFields: ['decision'],
      tools: [{ name: 'lookup_order', description: 'Looks up an order.' }],
      callTool: async (name, input) => { toolCalls.push({ name, input }); return { daysSinceDelivery: 3 }; },
    });
    assert.deepStrictEqual(out, { decision: 'refund' });
    assert.deepStrictEqual(toolCalls, [{ name: 'lookup_order', input: { orderId: 'O-1001' } }]);

    const first = sent[0];
    assert.strictEqual(first.url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(first.init.headers['x-api-key'], 'test-key');
    assert.strictEqual(first.body.model, 'claude-test');
    assert.deepStrictEqual(first.body.tool_choice, { type: 'any' });
    assert.deepStrictEqual(first.body.tools.map((t) => t.name), ['lookup_order', 'respond']);
    assert.deepStrictEqual(first.body.tools[1].input_schema.required, ['decision']);
    // The tool result goes back into the conversation on the second request.
    const last = sent[1].body.messages.at(-1);
    assert.strictEqual(last.content[0].type, 'tool_result');
    assert.strictEqual(last.content[0].tool_use_id, 't1');
  } finally {
    global.fetch = realFetch;
  }
});

test('the openai provider records through the same live client sessions use', async () => {
  const { openaiProvider } = require('../scripts/record-fixtures');
  const { startFakeProxy, toolCall } = require('../scripts/fake-llm-proxy');
  const proxy = await startFakeProxy({
    handler: (body) => {
      const respond = body.tools.find((t) => t.function.name === 'respond');
      const fields = respond.function.parameters.required;
      if (fields.includes('daysSinceDelivery')) return toolCall('respond', { status: 'delivered', daysSinceDelivery: 3 });
      const asked = body.messages.find((m) => m.role === 'tool');
      if (!asked && !/changed my mind/.test(body.messages.find((m) => m.role === 'user').content)) {
        return toolCall('lookup_order', { orderId: /Order: (O-\d+)/.exec(body.messages.find((m) => m.role === 'user').content)[1] });
      }
      return toolCall('respond', { decision: asked ? 'refund' : 'deny' });
    },
  });
  try {
    assert.throws(() => openaiProvider({}), /OPENAI_API_KEY/);
    const provider = openaiProvider({ apiKey: 'k', baseUrl: proxy.url, model: 'gpt-5-mini' });
    const { recorded, unanswered } = await recordFixtures({ scenario: bare(), graph: REF, provider });
    assert.deepStrictEqual(unanswered, []);
    assert.strictEqual(recorded.filter((f) => !f.when.tool).length, 4);
    assert.strictEqual(recorded.filter((f) => f.when.tool === 'lookup_order').length, 3);
    assert.deepStrictEqual(recorded[0].recorded, { provider: 'openai', model: 'gpt-5-mini' });
    assert.ok(proxy.requests.every((r) => r.body.model === 'gpt-5-mini'));
  } finally {
    await proxy.close();
  }
});

