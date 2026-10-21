'use strict';

/**
 * Live AI answers through the LLM Proxy (Learn only).
 *
 * Every test runs against scripts/fake-llm-proxy.js on 127.0.0.1 — no key, no
 * network. What must hold: live answers reach the canvas, every failure falls
 * back to the recorded answer and says why, Hire never answers live, and the
 * graded verdict never depends on a live answer.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { run } = require('../engine');
const { validateScenario } = require('../engine/validate');
const { createLiveAgent } = require('../live/openai');
const { startFakeProxy, toolCall, text } = require('../scripts/fake-llm-proxy');
const { grade } = require('../parse_automation_solution');

const ROOT = path.join(__dirname, '..');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

const TRIAGE = read('scenarios', 'ticket-triage-ai', 'scenario.json');
const TRIAGE_REF = read('scenarios', 'ticket-triage-ai', 'reference_solution.json');
const REFUNDS = read('scenarios', 'refund-desk-agents', 'scenario.json');
const REFUNDS_REF = read('scenarios', 'refund-desk-agents', 'reference_solution.json');

const LIVE = { enabled: true, provider: 'openai', models: { 'gpt-5': 'gpt-5', 'gpt-5-mini': 'gpt-5-mini' } };
const withLive = (scenario, extra = {}) => {
  const s = clone(scenario);
  s.ai.live = { ...LIVE, ...extra };
  return s;
};

/** The fields the respond function asks for in this request. */
const requiredFields = (body) => {
  const respond = (body.tools || []).find((t) => t.function.name === 'respond');
  return respond ? respond.function.parameters.required : [];
};

async function withProxy(handler, fn) {
  const proxy = await startFakeProxy({ handler });
  try {
    return await fn(proxy, createLiveAgent({ apiKey: 'test-session-key', baseUrl: proxy.url }));
  } finally {
    await proxy.close();
  }
}

const ask = (agent, extra = {}) => agent({
  model: 'gpt-5-mini', systemPrompt: 'sys', userPrompt: 'Classify T-01', input: { ticket: 'T-01' },
  outputFields: ['category', 'severity'], tools: [], live: LIVE, ...extra,
});

/* ── the client ─────────────────────────────────────────────────────────── */

test('no proxy in the environment means no live agent', () => {
  assert.strictEqual(createLiveAgent({}), null);
  assert.strictEqual(createLiveAgent({ apiKey: 'k' }), null);
  assert.strictEqual(createLiveAgent({ baseUrl: 'http://x/' }), null);
});

test('asks for the declared fields through a required respond function', async () => {
  await withProxy(() => toolCall('respond', { category: 'billing', severity: 4 }), async (proxy, agent) => {
    const res = await ask(agent);
    assert.deepStrictEqual(res.output, { category: 'billing', severity: 4 });
    assert.strictEqual(res.model, 'gpt-5-mini');
    assert.deepStrictEqual(res.usage, { prompt: 120, completion: 30 });

    const sent = proxy.requests[0];
    assert.strictEqual(sent.authorization, 'Bearer test-session-key');
    assert.strictEqual(sent.body.model, 'gpt-5-mini');
    assert.strictEqual(sent.body.tool_choice, 'required');
    assert.deepStrictEqual(requiredFields(sent.body), ['category', 'severity']);
    assert.deepStrictEqual(sent.body.messages.map((m) => m.role), ['system', 'user']);
  });
});

test('without an output parser it asks for a plain answer and returns the text', async () => {
  await withProxy(() => text('Billing, fairly urgent.'), async (proxy, agent) => {
    const res = await ask(agent, { outputFields: [] });
    assert.strictEqual(res.output, 'Billing, fairly urgent.');
    const sent = proxy.requests[0];
    assert.strictEqual(sent.body.tools, undefined, 'no respond function, and no tools to offer');
    assert.strictEqual(sent.body.tool_choice, undefined);
  });
});

test('an empty text answer falls back rather than passing nothing on', async () => {
  await withProxy(() => text('  '), async (_proxy, agent) => {
    const res = await ask(agent, { outputFields: [] });
    assert.deepStrictEqual([res.ok, res.reason], [false, 'bad-answer']);
  });
});

test('a label with no mapped model never calls the proxy', async () => {
  await withProxy(() => toolCall('respond', {}), async (proxy, agent) => {
    const res = await ask(agent, { model: 'gpt-9' });
    assert.deepStrictEqual([res.ok, res.reason], [false, 'no-model']);
    assert.strictEqual(proxy.requests.length, 0);
  });
});

for (const [label, handler, reason] of [
  ['429', () => ({ status: 429, body: { error: 'rate limited' } }), 'rate-limit'],
  ['a spent budget', () => ({ status: 400, body: { error: 'Budget has been exceeded! Current cost: 2.01' } }), 'budget'],
  ['a server error', () => ({ status: 502, body: 'bad gateway' }), 'error'],
  ['no tool call', () => ({ content: 'Sure, here you go.' }), 'bad-answer'],
  ['none of the fields', () => toolCall('respond', { mood: 'calm' }), 'bad-answer'],
  ['an unreadable body', () => ({ status: 200, body: 'not json' }), 'error'],
]) {
  test(`${label} is a fallback reason, never a throw`, async () => {
    await withProxy(handler, async (_proxy, agent) => {
      const res = await ask(agent);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.reason, reason);
    });
  });
}

test('a slow model times out', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(toolCall('respond', { category: 'x' })), 400));
  await withProxy(slow, async (_proxy, agent) => {
    const res = await ask(agent, { live: { ...LIVE, timeoutMs: 50 } });
    assert.deepStrictEqual([res.ok, res.reason], [false, 'timeout']);
  });
});

test('a tool call runs the subagent and the answer goes back to the model', async () => {
  const handler = (body, { index }) => (index === 0
    ? toolCall('lookup_order', { orderId: 'O-1001' })
    : toolCall('respond', { decision: 'refund' }));
  await withProxy(handler, async (proxy, agent) => {
    const calls = [];
    const res = await ask(agent, {
      outputFields: ['decision'],
      tools: [{ name: 'lookup_order', description: 'Looks up an order.' }],
      runTool: async (name, args) => { calls.push({ name, args }); return { daysSinceDelivery: 3 }; },
    });
    assert.deepStrictEqual(res.output, { decision: 'refund' });
    assert.deepStrictEqual(calls, [{ name: 'lookup_order', args: { orderId: 'O-1001' } }]);
    const second = proxy.requests[1].body.messages;
    assert.strictEqual(second.at(-1).role, 'tool');
    assert.deepStrictEqual(JSON.parse(second.at(-1).content), { daysSinceDelivery: 3 });
    assert.deepStrictEqual(proxy.requests[0].body.tools.map((t) => t.function.name), ['lookup_order', 'respond']);
  });
});

test('the same question twice is asked once', async () => {
  await withProxy(() => toolCall('respond', { category: 'billing', severity: 2 }), async (proxy, agent) => {
    await ask(agent);
    const again = await ask(agent);
    assert.strictEqual(again.cached, true);
    assert.strictEqual(proxy.requests.length, 1);
  });
});

/* ── the engine ─────────────────────────────────────────────────────────── */

/** Every ticket comes back severity 5 — so a live run escalates all six, not three. */
const allSevere = (body) => toolCall('respond', Object.fromEntries(requiredFields(body)
  .map((f) => [f, f === 'severity' ? 5 : 'technical'])));

test('live answers flow through the workflow', async () => {
  await withProxy(allSevere, async (_proxy, liveAgent) => {
    const trace = await run(withLive(TRIAGE), TRIAGE_REF, { liveAgent });
    const agentCalls = trace.aiCalls.filter((c) => c.node === 'Classify Ticket');
    assert.strictEqual(agentCalls.length, 6);
    assert.ok(agentCalls.every((c) => c.source === 'live' && c.liveModel === 'gpt-5-mini' && c.tokens === 150));
    assert.deepStrictEqual(trace.live, { calls: 6, answered: 6, fallbacks: 0, tokens: 900 });
    assert.strictEqual(trace.nodes.find((n) => n.name === 'Needs A Human').itemsOut, 6,
      'the live severities, not the recorded ones, reached the Filter');
  });
});

test('a failing proxy falls back to the recorded answers, and says why', async () => {
  await withProxy(() => ({ status: 429, body: {} }), async (_proxy, liveAgent) => {
    const trace = await run(withLive(TRIAGE), TRIAGE_REF, { liveAgent });
    const replay = await run(TRIAGE, TRIAGE_REF);
    const agentCalls = trace.aiCalls.filter((c) => c.node === 'Classify Ticket');
    assert.ok(agentCalls.every((c) => c.source === 'recorded' && c.fallback === 'rate-limit' && c.fixture));
    assert.deepStrictEqual(trace.sinks, replay.sinks, 'the run is exactly the replay run');
    assert.deepStrictEqual(trace.live, { calls: 6, answered: 0, fallbacks: 6, tokens: 0 });
  });
});

test('maxCallsPerRun stops live calls and the rest replay', async () => {
  await withProxy(allSevere, async (proxy, liveAgent) => {
    const trace = await run(withLive(TRIAGE, { maxCallsPerRun: 2 }), TRIAGE_REF, { liveAgent });
    const sources = trace.aiCalls.filter((c) => c.node === 'Classify Ticket').map((c) => c.fallback || c.source);
    assert.deepStrictEqual(sources, ['live', 'live', 'call-limit', 'call-limit', 'call-limit', 'call-limit']);
    assert.strictEqual(proxy.requests.length, 2);
  });
});

test('private grading (Hire) never answers live', async () => {
  await withProxy(allSevere, async (proxy, liveAgent) => {
    const hire = withLive(TRIAGE);
    hire.grading = { private: true };
    const trace = await run(hire, TRIAGE_REF, { liveAgent });
    assert.strictEqual(proxy.requests.length, 0);
    assert.strictEqual(trace.live, undefined);
    assert.ok(trace.aiCalls.every((c) => c.source === undefined));
  });
});

test('without a liveAgent — run.js, the validator, the grader — nothing changes', async () => {
  const trace = await run(withLive(TRIAGE), TRIAGE_REF);
  const replay = await run(TRIAGE, TRIAGE_REF);
  assert.strictEqual(trace.live, undefined);
  assert.deepStrictEqual(trace.aiCalls, replay.aiCalls);
});

test('subagents answer live too, called by the live parent', async () => {
  const handler = (body) => {
    // The subagent has no output parser, so no respond function: it answers in text.
    if (!body.tools || !body.tools.some((t) => t.function.name === 'respond')) return text('Delivered 2 days ago.');
    const user = body.messages.find((m) => m.role === 'user').content;
    const toolResult = body.messages.find((m) => m.role === 'tool');
    if (!toolResult) return toolCall('lookup_order', { orderId: /Order: (O-\d+)/.exec(user)[1] });
    return toolCall('respond', { decision: 'refund' });
  };
  await withProxy(handler, async (_proxy, liveAgent) => {
    const trace = await run(withLive(REFUNDS), REFUNDS_REF, { liveAgent });
    assert.strictEqual(trace.status, 'completed');
    const lookups = trace.aiCalls.filter((c) => c.tool === 'lookup_order');
    assert.strictEqual(lookups.length, 4, 'the live parent looked up every order');
    assert.ok(lookups.every((c) => c.source === 'live' && c.via === 'Decide Refund'));
    const tool = trace.nodes.find((n) => n.name === 'Look Up Order');
    assert.deepStrictEqual([tool.status, tool.itemsIn, tool.itemsOut], ['success', 4, 4]);
    assert.deepStrictEqual(trace.sinks['Tell Finance'].map((p) => p.text), ['4 refunds approved'],
      'the live decisions, not the recorded ones, reached Slack');
  });
});

test('when the agent falls back, its subagents are labelled recorded too', async () => {
  await withProxy(() => ({ status: 429, body: {} }), async (_proxy, liveAgent) => {
    const trace = await run(withLive(REFUNDS), REFUNDS_REF, { liveAgent });
    const lookups = trace.aiCalls.filter((c) => c.tool === 'lookup_order');
    assert.strictEqual(lookups.length, 3, 'the recorded parent answers call the subagent three times');
    assert.ok(lookups.every((c) => c.source === 'recorded' && c.fallback === 'agent-recorded' && c.fixture));
    // An ordinary replay run is untouched.
    const replay = await run(REFUNDS, REFUNDS_REF);
    assert.ok(replay.aiCalls.every((c) => c.source === undefined && c.fallback === undefined));
  });
});

/* ── grading ────────────────────────────────────────────────────────────── */

test('a live run is graded on the recorded answers, and the report says so', async () => {
  await withProxy(allSevere, async (_proxy, liveAgent) => {
    const scenario = withLive(TRIAGE);
    const trace = await run(scenario, TRIAGE_REF, {
      interactive: true, decisions: { 'Confirm Escalation': 'approve' }, liveAgent,
    });
    // Live, six tickets were escalated — the recorded answers escalate three,
    // and the assertions expect three. The verdict must follow the recording.
    assert.strictEqual(trace.sinks['Tell Support'][0].text, '6 tickets need a human today');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo-live-'));
    const at = (f) => path.join(dir, f);
    fs.writeFileSync(at('config.json'), JSON.stringify(scenario));
    fs.writeFileSync(at('solution.json'), JSON.stringify(TRIAGE_REF));
    fs.writeFileSync(at('execution.json'), JSON.stringify(trace));
    const report = await grade({
      scenarioFile: at('config.json'), solutionFile: at('solution.json'), executionFile: at('execution.json'),
    });
    assert.match(report, /^RESULT: PASS/m);
    assert.match(report, /## TRACE SIGNATURE\nVALID/);
    assert.match(report, /^Note: Answers were live during the session; this report replays the recorded answers\.$/m);
    assert.match(report, /3 tickets need a human today/);
  });
});

test('the proxy key never reaches the report', async () => {
  const before = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-proxy-session-SECRET-123';
  try {
    const graph = clone(TRIAGE_REF);
    graph.nodes.find((n) => n.type === 'slack').parameters.text = 'key sk-proxy-session-SECRET-123';
    const trace = await run(TRIAGE, graph);
    const { formatReport } = require('../grading/format');
    const report = formatReport({ scenario: TRIAGE, graph, trace, assertions: [], signature: 'VALID' });
    assert.ok(!report.includes('sk-proxy-session-SECRET-123'));
  } finally {
    if (before === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = before;
  }
});

/* ── the boundary ───────────────────────────────────────────────────────── */

test('only the server can make a run live', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(path.join(ROOT, 'engine')).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /require\([^)]*live\//, `${file} imports live/`);
  }
  for (const file of ['parse_automation_solution.js', 'run.js', 'scripts/validate-scenario.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /liveAgent|live\/openai/,
      `${file} must never answer live`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), /require\('\.\/live\/openai'\)/);
});

/* ── the validator ──────────────────────────────────────────────────────── */

test('the validator checks the live block', async () => {
  const errorsFor = async (mutate) => {
    const s = withLive(TRIAGE);
    mutate(s);
    return (await validateScenario(s, {})).errors;
  };
  assert.deepStrictEqual(await errorsFor(() => {}), []);
  assert.ok((await errorsFor((s) => { delete s.ai.live.models['gpt-5']; }))
    .some((e) => /no model id for "gpt-5"/.test(e)));
  assert.ok((await errorsFor((s) => { s.ai.live.provider = 'anthropic'; }))
    .some((e) => /provider/.test(e)));
  assert.ok((await errorsFor((s) => { s.grading = { private: true }; }))
    .some((e) => /cannot be combined with `grading.private`/.test(e)));
  assert.ok((await errorsFor((s) => { s.ai.fixtures = s.ai.fixtures.filter((f) => f.id !== 'catch-all'); }))
    .some((e) => /needs a catch-all/.test(e)));
  assert.ok((await errorsFor((s) => { s.ai.live.maxCallsPerRun = 0; }))
    .some((e) => /maxCallsPerRun/.test(e)));
});
