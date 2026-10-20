#!/usr/bin/env node
'use strict';

/**
 * Record AI fixtures from a real model — the authoring tool the engine refers to.
 *
 *   node scripts/record-fixtures.js <scenario.json> <solution.json>              # dry run
 *   node scripts/record-fixtures.js <scenario.json> <solution.json> \
 *        --provider anthropic [--model claude-sonnet-5-5] [--write]
 *   node scripts/record-fixtures.js <scenario.json> <solution.json> \
 *        --provider openai [--model gpt-5-mini] [--write]
 *
 * `openai` speaks to any OpenAI-compatible endpoint — OpenAI itself, or the LLM
 * Proxy from inside a session — through live/openai.js, the same client a session
 * uses for live answers, so recorded and live answers are asked the same way. It
 * reads OPENAI_API_KEY and OPENAI_BASE_URL (default https://api.openai.com/v1/).
 *
 * WHY THIS LIVES HERE AND NOT IN engine/
 *
 * The engine can only replay: `test/transport.test.js` fails the build if any
 * file under engine/ imports a network module, so a candidate's session can
 * never reach a model. Recording a fixture means calling a model once, which is
 * an author's job on an author's machine — so it is this script, run by hand,
 * and nothing a scenario's configuration can switch on.
 *
 * WHAT IT DOES
 *
 * Runs the workflow headlessly against the scenario. Every agent call no
 * fixture answers is a miss, and the trace records what was asked. Each miss is
 * put to the model; the answer becomes a fixture keyed on the input item —
 * never the prompt — and the run repeats until nothing misses.
 *
 * Catch-all fixtures are set aside while recording, or they would answer every
 * call and nothing would be recorded. They go back afterwards, AFTER the new
 * fixtures, because the first match wins.
 *
 * Subagents are offered to the model as real tools. When it calls one, the
 * subagent is asked in turn — its prompt built from the arguments the model
 * chose — and its answer goes back into the conversation, so the parent decides
 * with real tool results. Both are recorded: the parent's fixture with the
 * `calls` it made, the subagent's keyed on `when.tool` and its input.
 *
 * WHAT LEAVES YOUR MACHINE
 *
 * With `--provider anthropic`: each missed call's system prompt, user prompt,
 * declared output fields, and the descriptions of any attached tools — which is
 * to say the scenario's fixture data as it appears in those prompts. The default
 * is a dry run that prints exactly that and sends nothing. Read it first.
 */

const fs = require('fs');
const path = require('path');

const { run } = require('../engine');
const { resolveParameters, initSandbox } = require('../engine/expression');
const { makeItem } = require('../engine/items');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';
// A per-item agent stops at its first unanswered item, so one pass may record
// a single call. Passes continue until nothing misses, or a pass adds nothing.
const MAX_PASSES = 200;
const MAX_DEPTH = 4;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A catch-all matches on nothing but, at most, which tool it answers. */
const isCatchAll = (f) => !f.when || Object.keys(f.when).every((k) => k === 'tool');

/**
 * @param scenario  the scenario object; not modified
 * @param graph     a workflow that reaches every agent call worth recording —
 *                  usually the reference solution
 * @param provider  async ({ system, user, outputFields, model, tools, callTool })
 *                  => answer object; `label` and `model` properties are recorded
 * @returns {{ fixtures, recorded, passes, unanswered }}
 */
async function recordFixtures({ scenario, graph, provider, log = () => {} }) {
  await initSandbox();

  const existing = ((scenario.ai || {}).fixtures || []).map(clone);
  const catchAlls = existing.filter(isCatchAll);
  const specific = existing.filter((f) => !isCatchAll(f));
  const recorded = [];
  const ids = new Set(existing.map((f) => f.id).filter(Boolean));

  const working = clone(scenario);
  working.ai = { ...(working.ai || {}), mode: 'replay' };

  const byName = new Map((graph.nodes || []).map((n) => [n.name, n]));
  const byId = new Map((graph.nodes || []).map((n) => [n.id, n]));

  /** The enabled AI Agent Tools wired into a node's Tools port. */
  const toolsOf = (node) => (graph.connections || [])
    .filter((c) => c.to === node.id)
    .map((c) => byId.get(c.from))
    .filter((n) => n && n.type === 'agentTool' && !n.disabled)
    .map((n) => ({ node: n, name: String((n.parameters || {}).toolName || '').trim(),
      description: String((n.parameters || {}).description || '').trim() }))
    .filter((t) => t.name);

  const uniqueId = (base) => {
    const stem = `rec-${base}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+$/, '');
    let id = stem;
    for (let n = 2; ids.has(id); n += 1) id = `${stem}-${n}`;
    ids.add(id);
    return id;
  };

  const known = (tool, input) => [...specific, ...recorded].find((f) => f.when
    && (f.when.tool || undefined) === (tool || undefined) && same(f.when.input, input));

  /** Ask the model one question, recursing into any subagent it calls. */
  const answer = async ({ nodeName, tool, request, outputFields, model }, depth = 0) => {
    const hit = known(tool, request.input);
    if (hit) return hit.respond;
    if (depth > MAX_DEPTH) throw new Error(`subagents nest deeper than ${MAX_DEPTH} levels at "${nodeName}"`);

    const node = byName.get(nodeName);
    const tools = node ? toolsOf(node) : [];
    for (const t of tools) {
      if (!TOOL_NAME.test(t.name)) {
        throw new Error(`tool name "${t.name}" on "${t.node.name}" must be letters, digits, _ or - (64 max)`);
      }
    }
    const calls = [];

    const result = await provider({
      system: request.systemPrompt,
      user: request.userPrompt,
      outputFields,
      model,
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      callTool: async (name, input) => {
        const t = tools.find((x) => x.name === name);
        if (!t) return { error: `no tool named ${name}` };
        const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
        calls.push({ tool: name, input: args });
        const params = resolveParameters(t.node.parameters || {}, {
          json: args, itemIndex: 0, items: [makeItem(args)], nodeOutputs: {},
          vars: scenario.vars || {}, env: scenario.env || {},
          now: new Date('2026-07-31T09:00:00.000Z'), timeoutMs: 100,
        }).value;
        return answer({
          nodeName: t.node.name,
          tool: name,
          request: { input: args, systemPrompt: String(params.systemPrompt || ''), userPrompt: String(params.userPrompt || '') },
          outputFields: (params.outputFields || []).filter(Boolean),
          model: params.model,
        }, depth + 1);
      },
    });

    const respond = {};
    for (const field of outputFields) {
      if (result && result[field] !== undefined) respond[field] = result[field];
    }
    const fixture = {
      id: uniqueId(`${tool || nodeName}-${recorded.length + 1}`),
      when: tool ? { tool, input: request.input } : { input: request.input },
      ...(calls.length ? { calls } : {}),
      respond,
      recorded: { provider: provider.label || 'custom', model: provider.model || null },
    };
    recorded.push(fixture);
    log(`  recorded ${fixture.id}${calls.length ? ` (${calls.length} tool call${calls.length === 1 ? '' : 's'})` : ''}`);
    return respond;
  };

  let passes = 0;
  let unanswered = [];
  for (; passes < MAX_PASSES; passes += 1) {
    working.ai.fixtures = [...specific, ...recorded];
    const trace = await run(working, graph);
    const misses = (trace.aiCalls || []).filter((c) => c.denied && c.request);
    const fresh = misses.filter((m, i) => misses.findIndex((o) => o.tool === m.tool
      && same(o.request.input, m.request.input)) === i);
    unanswered = fresh;
    if (!fresh.length) break;
    const before = recorded.length;
    log(`pass ${passes + 1}: ${fresh.length} call${fresh.length === 1 ? '' : 's'} with no fixture`);
    for (const miss of fresh) {
      await answer({
        nodeName: miss.node, tool: miss.tool, request: miss.request,
        outputFields: miss.outputFields || [], model: miss.model,
      });
    }
    if (recorded.length === before) break; // answered from what is known; no progress possible
  }

  return { fixtures: [...specific, ...recorded, ...catchAlls], recorded, passes, unanswered };
}

/* ── providers ────────────────────────────────────────────────────────── */

/**
 * Anthropic's Messages API, with tool use. The declared output fields become a
 * `respond` tool the model must finish with, which is how a structured answer
 * is asked for; attached subagents are the other tools.
 */
function anthropicProvider({ apiKey, model = DEFAULT_MODEL }) {
  if (!apiKey) throw new Error('--provider anthropic needs ANTHROPIC_API_KEY in the environment');
  const ask = async ({ system, user, outputFields, tools, callTool }) => {
    const respondTool = {
      name: 'respond',
      description: 'Give your final answer. Call this exactly once, when you are done.',
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(outputFields.map((f) => [f, {}])),
        required: outputFields,
      },
    };
    const toolDefs = [
      ...tools.map((t) => ({
        name: t.name,
        description: t.description || t.name,
        input_schema: { type: 'object', additionalProperties: true },
      })),
      respondTool,
    ];
    const messages = [{ role: 'user', content: user || '(empty prompt)' }];

    for (let turn = 0; turn < 8; turn += 1) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model, max_tokens: 1024, system: system || undefined,
          tools: toolDefs, tool_choice: { type: 'any' }, messages,
        }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      const body = await res.json();
      messages.push({ role: 'assistant', content: body.content });

      const uses = (body.content || []).filter((b) => b.type === 'tool_use');
      const final = uses.find((u) => u.name === 'respond');
      if (final) return final.input;

      const results = [];
      for (const use of uses) {
        const out = await callTool(use.name, use.input);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out) });
      }
      if (!results.length) throw new Error('the model answered without using a tool or responding');
      messages.push({ role: 'user', content: results });
    }
    throw new Error('the model gave no final answer within 8 turns');
  };
  ask.label = 'anthropic';
  ask.model = model;
  return ask;
}

/**
 * Any OpenAI-compatible endpoint, through the session's live client. The recorder
 * names a real model id directly, so it hands the client a one-entry model map.
 */
function openaiProvider({ apiKey, baseUrl = 'https://api.openai.com/v1/', model = DEFAULT_OPENAI_MODEL, fetchImpl }) {
  if (!apiKey) throw new Error('--provider openai needs OPENAI_API_KEY in the environment');
  const { createLiveAgent } = require('../live/openai');
  const agent = createLiveAgent({ apiKey, baseUrl, fetchImpl });
  const ask = async ({ system, user, outputFields, tools, callTool }) => {
    const res = await agent({
      model: 'recording',
      live: { models: { recording: model }, timeoutMs: 120000 },
      systemPrompt: system,
      userPrompt: user,
      input: {},
      outputFields,
      tools,
      runTool: callTool,
    });
    if (!res.ok) throw new Error(`${res.reason}: ${res.message}`);
    return res.output;
  };
  ask.label = 'openai';
  ask.model = model;
  return ask;
}

/** Sends nothing: prints each request and answers with placeholders. */
function dryRunProvider(write) {
  const ask = async ({ system, user, outputFields, tools, model }) => {
    write(`\n── would send (${model || 'task model unset'}) ──\n`);
    if (system) write(`system: ${system}\n`);
    write(`user:   ${user}\n`);
    write(`fields: ${outputFields.join(', ') || '(none)'}\n`);
    if (tools.length) write(`tools:  ${tools.map((t) => `${t.name} — ${t.description || '(no description)'}`).join('\n        ')}\n`);
    return Object.fromEntries(outputFields.map((f) => [f, `<${f}>`]));
  };
  ask.label = 'dry-run';
  ask.model = null;
  return ask;
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const VALUED = new Set(['--provider', '--model']);
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUED.has(args[i])) i += 1;
    else if (!args[i].startsWith('--')) files.push(args[i]);
  }
  const [scenarioFile, solutionFile] = files;
  if (!scenarioFile || !solutionFile) {
    process.stderr.write('usage: node scripts/record-fixtures.js <scenario.json> <solution.json> '
      + '[--provider anthropic|openai] [--model id] [--write]\n');
    process.exit(2);
  }

  const providerName = flag('--provider') || 'dry-run';
  const providers = {
    anthropic: () => anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: flag('--model') }),
    openai: () => openaiProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || undefined,
      model: flag('--model') || undefined,
    }),
    'dry-run': () => dryRunProvider((s) => process.stdout.write(s)),
  };
  const provider = providers[providerName] ? providers[providerName]() : null;
  if (!provider) {
    process.stderr.write(`unknown provider "${providerName}" — use anthropic or openai, or leave it out for a dry run\n`);
    process.exit(2);
  }

  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const graph = JSON.parse(fs.readFileSync(solutionFile, 'utf8'));

  const { fixtures, recorded, unanswered } = await recordFixtures({
    scenario, graph, provider, log: (line) => process.stdout.write(`${line}\n`),
  });

  if (!recorded.length) {
    process.stdout.write('\nEvery agent call already has a fixture; nothing to record.\n');
    return;
  }
  if (unanswered.length) {
    process.stdout.write(`\n! ${unanswered.length} call(s) still unanswered — the run stopped making progress.\n`);
  }

  if (providerName === 'dry-run') {
    process.stdout.write(`\nDry run: ${recorded.length} fixture(s) would be recorded. Nothing was sent `
      + 'and nothing was written. Add --provider openai or anthropic to record for real.\n');
    return;
  }

  if (args.includes('--write')) {
    scenario.ai = { ...(scenario.ai || {}), mode: 'replay', fixtures };
    fs.writeFileSync(scenarioFile, `${JSON.stringify(scenario, null, 2)}\n`);
    process.stdout.write(`\nWrote ${recorded.length} fixture(s) to ${path.relative(process.cwd(), scenarioFile)}. `
      + 'Now run: npm run validate ' + path.relative(process.cwd(), scenarioFile) + '\n');
  } else {
    process.stdout.write(`\n${JSON.stringify(recorded, null, 2)}\n\nAdd --write to save them into the scenario.\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\n✗ ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { recordFixtures, anthropicProvider, openaiProvider, dryRunProvider, isCatchAll };
