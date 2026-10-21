'use strict';

const { getNode } = require('./nodes');
const { resolveParameters } = require('./expression');
const { initSandbox } = require('./sandbox');
const { cloneItems, concatPort, makeItem } = require('./items');
const { resolveRequest } = require('./mock/resolver');
const { resolveAgentCall } = require('./ai/resolver');
const { credentialTypes, credentialsFor } = require('./credentials');
const { effectiveOutputs } = require('../shared/node-ports.mjs');
const { effectiveMode } = require('../shared/node-mode.mjs');

/**
 * Execution engine.
 *
 * Topological order; a node fires once every connected input has resolved.
 * Branch nodes route items to different output ports and items landing on an
 * unconnected port are dropped, exactly as in the tools candidates know.
 *
 * The engine owns expression evaluation, so nodes never see raw `={{ }}`
 * strings — one evaluator, every node gets it for free.
 */

const DEFAULT_LIMITS = {
  maxNodes: 40,
  maxItems: 5000,
  maxExecutionMs: 5000,
  // Ceiling on *simulated* waiting for one run, so a wide fan-out cannot leave
  // someone staring at a spinner.
  maxSimulatedMs: 4000,
  // Wall-clock ceiling for a single `{{ }}` span, enforced by the isolate's
  // interrupt handler. Generous for anything sane, fatal to a runaway loop.
  maxExpressionMs: 100,
  // The Code node gets a larger budget than a `{{ }}` span: it is meant to do
  // real work, and a candidate looping over a few thousand items is legitimate.
  maxCodeMs: 1000,
  // A loop whose batch size is smaller than the author expected can turn a
  // 500-item list into 500 passes. This is the backstop; it fails loudly rather
  // than running until the execution budget expires with no explanation.
  maxLoopIterations: 200,
  // Ceiling on time spent WAITING for live model answers in one run. Like
  // simulated latency it is not compute, so it does not count against
  // maxExecutionMs; past it, the remaining calls answer from recordings.
  maxLiveMs: 60000,
};

/** node name -> json[], the shape the isolate's helpers expect. */
function nodeOutputsForCode(byName) {
  const out = {};
  for (const name of Object.keys(byName)) {
    out[name] = (byName[name] || []).map((item) => item.json);
  }
  return out;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * How long a node pretends to take.
 *
 * Instant results make a workflow feel like a spreadsheet rather than something
 * calling out to services, and they hide the per-item cost of a node that runs
 * once per item — which is exactly the intuition worth building. Talking to a
 * service is slow; rearranging fields is not.
 *
 * This is wall-clock theatre only. It never touches what a node produces, so
 * grading stays byte-for-byte reproducible, and it is off unless a caller asks
 * for it — tests and the headless runner stay fast.
 */
/**
 * A node's execution mode. Usually a fixed property; the Code node lets the
 * candidate choose it outright, and an integration's mode follows its operation.
 * Delegated to the shared module so the mode the canvas promises is the mode the
 * engine runs.
 */
function modeOf(def, node) {
  return effectiveMode(def, node);
}

/**
 * A node's output ports for THIS node's configuration. Fixed for almost
 * everything; Switch names one port per routing rule. Delegates to the shared
 * module so the canvas draws exactly the ports the engine routes to.
 */
function portsOf(def, node) {
  return effectiveOutputs({ ...def, type: def.type }, node);
}

function latencyFor(def, itemCount) {
  const spec = def.latency || { base: 12, perItem: 2 };
  const perItem = spec.perItem === undefined ? 0 : spec.perItem;
  return Math.round(spec.base + perItem * Math.max(0, itemCount - 1));
}

async function executeWorkflow(scenario, graph, options = {}) {
  // Loads the QuickJS WASM once per process. Awaited here rather than at import
  // time so that requiring the engine stays synchronous and cheap.
  await initSandbox();

  const limits = { ...DEFAULT_LIMITS, ...(scenario.limits || {}) };
  // Fixed clock: $now must be reproducible or grading is not.
  const now = options.now ? new Date(options.now) : new Date('2026-07-31T09:00:00.000Z');
  const startedAt = Date.now();

  /**
   * Approval decisions already known for this run.
   *
   * Supplied by the caller (the candidate clicked Approve, and the client
   * re-sends every decision so far), falling back to `scenario.approvals` so a
   * HEADLESS run — the validator's solvability check, `run.js`, a test — can get
   * past an approval without a human. Interactive runs have no fallback: they
   * pause, which is the whole point of the node.
   */
  const decisions = { ...(options.interactive ? {} : (scenario.approvals || {})), ...(options.decisions || {}) };

  const simulate = Boolean(options.simulateLatency);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  let simulatedMs = 0;
  let liveWaitMs = 0;

  /** Waiting — simulated, or on a live model — is not work; it must not eat the time budget. */
  const elapsedReal = () => Date.now() - startedAt - simulatedMs - liveWaitMs;

  const pause = async (ms) => {
    if (!simulate || ms <= 0) return;
    const remaining = Math.max(0, limits.maxSimulatedMs - simulatedMs);
    const capped = Math.min(ms, remaining);
    if (capped <= 0) return;
    simulatedMs += capped;
    await delay(capped);
  };

  const nodes = graph.nodes || [];
  const allConnections = graph.connections || [];

  const trace = {
    version: 1,
    status: 'completed',
    startedAt: now.toISOString(),
    nodes: [],
    httpCalls: [],
    aiCalls: [],
    sinks: {},
    errors: [],
  };

  /*
   * The approval decisions this run was given, so grading can reproduce it.
   * A trace is a pure function of (scenario, graph, decisions); the first two
   * are on disk, and this is the third. Only interactive runs record it —
   * headless runs take theirs from the scenario, which grading also has.
   */
  if (options.interactive) trace.decisions = cleanDecisions(options.decisions);

  if (nodes.length > limits.maxNodes) {
    return fail(trace, `Workflow has ${nodes.length} nodes, over the limit of ${limits.maxNodes}.`);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byName = new Map(nodes.map((n) => [n.name, n]));

  /**
   * Subagents: a wire from an AI Agent Tool is not data flow.
   *
   * It says "this agent may call that one", so it never carries items, never
   * orders the walk, and the tool node never runs as a step of its own — it runs
   * when, and as often as, an agent calls it. So tool wires come out of the
   * connection list here, before anything is ordered, and become `toolsOf`.
   *
   * Both ends must agree. A tool's output into an ordinary input, or an ordinary
   * node into a Tools input, is a wiring mistake with a plain explanation —
   * silently treating either as data would be a much harder failure to read.
   */
  const toolDef = (n) => getNode(n.type, scenario);
  const isToolNode = (n) => Boolean(toolDef(n) && toolDef(n).toolOutput);
  const toolsOf = new Map();
  const connections = [];
  for (const c of allConnections) {
    const from = byId.get(c.from);
    const to = byId.get(c.to);
    if (!from || !to) { connections.push(c); continue; }
    const toDef = toolDef(to);
    const fromTool = isToolNode(from);
    const intoTools = Boolean(toDef && toDef.toolInput && (c.toInput || 0) === toDef.inputs);
    if (fromTool !== intoTools) {
      return fail(trace, fromTool
        ? `"${from.name}" is an AI Agent Tool. It can only connect to the Tools input of an AI Agent — the port on the bottom of the agent.`
        : `The Tools input of "${to.name}" only takes AI Agent Tools, and "${from.name}" is not one.`);
    }
    if (fromTool) {
      if (!toolsOf.has(to.id)) toolsOf.set(to.id, []);
      toolsOf.get(to.id).push(from);
    } else {
      connections.push(c);
    }
  }

  const circle = toolCycle(toolsOf, byId);
  if (circle) {
    return fail(trace, `These subagents call each other in a circle: ${circle.join(' → ')}. `
      + 'An agent that can reach itself through its tools could call itself forever. Remove one of the tool connections.');
  }

  const duplicateName = findDuplicate(nodes.map((n) => n.name));
  if (duplicateName) {
    return fail(trace, `Two nodes are both named "${duplicateName}". Node names must be unique — expressions reference nodes by name.`);
  }

  // Adjacency: incoming[nodeId][inputPort] = [{from, fromOutput}]
  const incoming = new Map();
  const outgoing = new Map();
  for (const n of nodes) { incoming.set(n.id, new Map()); outgoing.set(n.id, new Map()); }
  for (const c of connections) {
    if (!byId.has(c.from) || !byId.has(c.to)) continue;
    const inPort = c.toInput || 0;
    const outPort = c.fromOutput || 0;
    if (!incoming.get(c.to).has(inPort)) incoming.get(c.to).set(inPort, []);
    incoming.get(c.to).get(inPort).push({ from: c.from, fromOutput: outPort });
    if (!outgoing.get(c.from).has(outPort)) outgoing.get(c.from).set(outPort, []);
    outgoing.get(c.from).get(outPort).push({ to: c.to, toInput: inPort });
  }

  /**
   * Loops first: the back-edges have to come out before anything can be ordered.
   * A cycle that is NOT a loop's back-edge is still an error — this engine has
   * exactly one legal way to revisit a node, and it is Loop Over Items.
   */
  const { bodies, backEdges, nested } = loopStructure(nodes, connections, scenario);
  if (nested) {
    return fail(trace, `"${nested}" is a Loop Over Items node inside another loop's body. Nested loops are not supported — give the inner work its own workflow, or use a larger batch size.`);
  }

  const acyclic = connections.filter((c) => !backEdges.has(c));
  const order = topologicalOrder(nodes, acyclic);
  if (!order) {
    return fail(trace, 'The workflow contains a cycle. The only supported way back to an earlier node is the loop output of a Loop Over Items node.');
  }

  /** Every node that some loop drives, so the outer walk leaves them alone. */
  const insideALoop = new Set();
  for (const body of bodies.values()) for (const id of body) insideALoop.add(id);

  /**
   * "Execute Node" runs one node and everything it depends on, and nothing else.
   * The trace it produces is therefore partial by construction and is flagged as
   * such — the server refuses to save it as the graded run.
   */
  let runList = order.filter((n) => !insideALoop.has(n.id) && !isToolNode(n));
  let untilNode = null;
  if (options.untilNode) {
    if (!byId.has(options.untilNode)) {
      return fail(trace, 'That node is no longer part of the workflow.');
    }
    if (isToolNode(byId.get(options.untilNode))) {
      return fail(trace, 'An AI Agent Tool runs only when an agent calls it. Execute the agent it is attached to instead.');
    }
    const needed = ancestorsOf(options.untilNode, acyclic);
    needed.add(options.untilNode);

    /**
     * A node inside a loop body cannot run on its own: it only has input because
     * the loop handed it a batch. So asking for one of them means running the loop
     * that drives it, up to and including that node.
     */
    for (const [loopId, body] of bodies) {
      if (body.has(options.untilNode) || needed.has(loopId)) needed.add(loopId);
    }

    runList = order.filter((n) => needed.has(n.id) && !insideALoop.has(n.id) && !isToolNode(n));
    untilNode = options.untilNode;
    trace.partial = true;
    trace.untilNode = options.untilNode;
    if (options.inputOnly) trace.inputOnly = true;
  }

  /**
   * "Execute previous nodes" runs everything the node depends on and stops at the
   * node itself: it records what would arrive there, so the input panel can show
   * it, and runs nothing else. Without this the button was Execute Node under
   * another name, and ran the node it was meant to prepare.
   */
  const inputOnly = Boolean(untilNode && options.inputOnly);

  /**
   * Nodes that run without being shown running: no simulated latency and no
   * progress events. Every node the result depends on still runs, so the trace is
   * exactly what a full replay produces and grading can reproduce it — only what
   * the candidate watches changes, and it now matches what they asked for:
   *
   *  · Execute Node — only that node is seen running; what feeds it replays
   *    silently.
   *  · Execute previous nodes — only the nodes directly before it are seen
   *    running.
   *  · Answering an approval (`resumeFrom`) — the run carries on from the
   *    approval; what came before replays silently instead of running again on
   *    screen. Identical live model calls are answered from the session's cache,
   *    so nothing is asked twice.
   */
  const quietIds = new Set();
  if (untilNode) {
    for (const id of ancestorsOf(untilNode, acyclic)) quietIds.add(id);
    if (inputOnly) {
      for (const c of acyclic) if (c.to === untilNode) quietIds.delete(c.from);
      // The target only has its input recorded; it must not light up as if it ran.
      quietIds.add(untilNode);
    }
  } else if (options.resumeFrom) {
    const from = byId.get(options.resumeFrom)
      || nodes.find((n) => n.name === options.resumeFrom);
    if (from) for (const id of ancestorsOf(from.id, acyclic)) quietIds.add(id);
  }

  /** nodeId -> Item[][] (outer array = output port) */
  const outputsById = new Map();
  /** node name -> Item[] on its first output, for $node[...] lookups */
  const nodeOutputsByName = {};

  /**
   * The candidate's own credentials, from their graph, resolved against the types
   * the scenario declares. A scenario may still ship ready-made ones for a task
   * that is not about credentials.
   */
  const credentials = credentialsFor(scenario, graph);
  const credTypes = credentialTypes(scenario);

  /**
   * Run the tool calls a model made, replayed from its fixture's `calls`.
   *
   * In production the model decides to call a tool, the tool runs, and its
   * answer goes back into the conversation. Here the decision is recorded in the
   * parent's fixture — which tool, with what input — and the subagent answers
   * from its own fixture, matched on that input and its tool name. So every
   * subagent is a real, gradable node: its prompt, its declared fields, its model
   * and how often it was called are all the candidate's, exactly as for a
   * top-level agent. What it cannot change is what the parent then says, which
   * the parent's fixture already holds.
   *
   * Returns an error message, or null. A failing subagent fails its parent: in
   * production a broken tool breaks the agent's answer, and the message names the
   * tool so the candidate knows where to look.
   */
  const toolUse = new Map();
  /*
   * `recorded` marks a live run whose agent fell back to its recording: these
   * subagent answers are recorded too, and say so, rather than looking like an
   * ordinary replay run.
   */
  const RECORDED_WITH_AGENT = {
    source: 'recorded',
    fallback: 'agent-recorded',
    fallbackMessage: 'Its agent answered from recordings, so this subagent did too.',
  };
  const runToolCalls = async (parent, calls, chain, recorded = false) => {
    const attached = (toolsOf.get(parent.id) || []).filter((t) => !t.disabled);
    for (const call of calls) {
      const want = String((call && call.tool) || '');
      const input = call && call.input && typeof call.input === 'object' && !Array.isArray(call.input)
        ? call.input : {};
      const exprCtx = {
        json: input, itemIndex: 0, items: [makeItem(input)], nodeOutputs: nodeOutputsByName,
        vars: scenario.vars || {}, env: scenario.env || {}, now, timeoutMs: limits.maxExpressionMs,
      };
      const offered = attached.map((t) => ({ node: t, params: resolveParameters(t.parameters || {}, exprCtx).value }));
      const hit = offered.find((o) => String(o.params.toolName || '').trim() === want);
      if (!hit) {
        const names = offered.map((o) => String(o.params.toolName || '').trim()).filter(Boolean);
        const off = (toolsOf.get(parent.id) || []).filter((t) => t.disabled).length;
        return `The model asked to use a tool called "${want}", but "${parent.name}" has no tool by that name. `
          + (names.length ? `Its tools are: ${names.join(', ')}. ` : 'It has no tools attached. ')
          + (off ? `${off} attached tool${off === 1 ? ' is' : 's are'} disabled. ` : '')
          + 'A tool\'s name is its Tool Name parameter.';
      }

      const use = toolUse.get(hit.node.id) || { calls: 0, ok: 0, via: new Set(), error: null };
      toolUse.set(hit.node.id, use);
      use.calls += 1;
      use.via.add(parent.name);

      const fields = (hit.params.outputFields || []).filter(Boolean);
      const problem = !fields.length
        ? 'declares no expected output fields, so its answer cannot be read'
        : (!String(hit.params.userPrompt || '').trim() ? 'has an empty user prompt' : null);
      if (problem) {
        use.error = `"${hit.node.name}" ${problem}.`;
        return `Subagent "${hit.node.name}" ${problem}.`;
      }

      const res = resolveAgentCall(scenario, {
        nodeName: hit.node.name, tool: want, input, model: hit.params.model, outputFields: fields, perItem: true,
      });
      trace.aiCalls.push({
        node: hit.node.name,
        via: parent.name,
        tool: want,
        model: hit.params.model || null,
        perItem: true,
        fixture: res.ok ? res.fixtureId : null,
        denied: Boolean(res.denied),
        outputFields: fields,
        ...missedRequest(res, {
          input, systemPrompt: hit.params.systemPrompt, userPrompt: hit.params.userPrompt,
        }),
        ...(recorded ? RECORDED_WITH_AGENT : {}),
      });
      if (!res.ok) {
        use.error = res.explanation;
        return `Subagent "${hit.node.name}": ${res.explanation}`;
      }
      if (fields.every((f) => res.output[f] === undefined)) {
        use.error = `returned none of the fields it asked for (${fields.join(', ')})`;
        return `Subagent "${hit.node.name}" returned none of the fields it asked for (${fields.join(', ')}). `
          + `It returned: ${Object.keys(res.output).join(', ') || '(nothing)'}.`;
      }

      if (res.calls.length) {
        // The run-time half of the cycle check, and a depth bound for fixtures
        // that nest further than any sensible task should.
        if (chain.includes(hit.node.id) || chain.length >= MAX_TOOL_DEPTH) {
          return `Subagent "${hit.node.name}" is nested more than ${MAX_TOOL_DEPTH} levels deep.`;
        }
        const nested = await runToolCalls(hit.node, res.calls, [...chain, hit.node.id], recorded);
        if (nested) { use.error = nested; return nested; }
      }
      use.ok += 1;
    }
    return null;
  };

  /**
   * Live answers (Learn only). When the server injects `options.liveAgent` and
   * the scenario opts in with `ai.live.enabled`, an agent call goes to a real
   * model through the session's LLM Proxy, and so do the subagents it calls.
   * Anything that goes wrong answers from the recorded fixture instead, and the
   * trace says why. Nothing else ever passes a liveAgent — run.js, the
   * validator, the tests, the grader — so those always replay, and the graded
   * verdict never depends on a live answer.
   *
   * Private grading is the Hire profile, and Hire is replay-only: a scenario
   * with grading.private never answers live, whatever else it says.
   */
  const liveConfig = scenario.ai && scenario.ai.live;
  const liveOn = typeof options.liveAgent === 'function'
    && Boolean(liveConfig && liveConfig.enabled === true)
    && !(scenario.grading && scenario.grading.private === true);
  const live = { calls: 0, answered: 0, fallbacks: 0, tokens: 0 };
  if (liveOn) trace.live = live;
  const maxLiveCalls = Number(liveConfig && liveConfig.maxCallsPerRun) > 0
    ? Number(liveConfig.maxCallsPerRun) : 30;

  const askLive = async (request) => {
    if (live.calls >= maxLiveCalls) {
      return { ok: false, reason: 'call-limit', message: `This run reached its limit of ${maxLiveCalls} live answers.` };
    }
    if (liveWaitMs >= limits.maxLiveMs) {
      return { ok: false, reason: 'time-limit', message: 'This run spent its time budget waiting for live answers.' };
    }
    live.calls += 1;
    const started = Date.now();
    let res;
    try {
      res = await options.liveAgent({ ...request, live: liveConfig });
    } catch (err) {
      res = { ok: false, reason: 'error', message: err.message };
    } finally {
      liveWaitMs += Date.now() - started;
    }
    const usage = (res && res.usage) || {};
    live.tokens += (Number(usage.prompt) || 0) + (Number(usage.completion) || 0);
    if (res && res.ok) live.answered += 1;
    else live.fallbacks += 1;
    return res || { ok: false, reason: 'error', message: 'No answer.' };
  };

  /** What a live call records, so the run log can say where each answer came from. */
  const liveFields = (res) => (res.ok
    ? { source: 'live', liveModel: res.model || null, cached: Boolean(res.cached),
      tokens: (Number(res.usage && res.usage.prompt) || 0) + (Number(res.usage && res.usage.completion) || 0) }
    : { source: 'recorded', fallback: res.reason, fallbackMessage: res.message });

  /** The parent's attached tools, as the live model sees them: a name and a description. */
  const resolveTools = (parent, json) => (toolsOf.get(parent.id) || [])
    .filter((t) => !t.disabled)
    .map((t) => ({
      node: t,
      params: resolveParameters(t.parameters || {}, {
        json, itemIndex: 0, items: [makeItem(json)], nodeOutputs: nodeOutputsByName,
        vars: scenario.vars || {}, env: scenario.env || {}, now, timeoutMs: limits.maxExpressionMs,
      }).value,
    }));
  const liveToolsFor = (parent) => resolveTools(parent, {})
    .map((o) => ({ name: String(o.params.toolName || '').trim(), description: String(o.params.description || '') }))
    .filter((t) => t.name);

  /**
   * A live model called one of its tools. Run that subagent — live, with its own
   * tools — and hand back its answer, or its recorded answer when live fails.
   * Same checks, same bookkeeping and the same depth/circle bound as replay.
   */
  const runToolLive = async (parent, name, args, chain) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const hit = resolveTools(parent, input).find((o) => String(o.params.toolName || '').trim() === name);
    if (!hit) return { error: `There is no tool named ${name}.` };

    const use = toolUse.get(hit.node.id) || { calls: 0, ok: 0, via: new Set(), error: null };
    toolUse.set(hit.node.id, use);
    use.calls += 1;
    use.via.add(parent.name);

    const fields = (hit.params.outputFields || []).filter(Boolean);
    const problem = !fields.length
      ? 'declares no expected output fields, so its answer cannot be read'
      : (!String(hit.params.userPrompt || '').trim() ? 'has an empty user prompt' : null);
    if (problem) {
      use.error = `"${hit.node.name}" ${problem}.`;
      return { error: use.error };
    }
    if (chain.includes(hit.node.id) || chain.length >= MAX_TOOL_DEPTH) {
      use.error = `Subagent "${hit.node.name}" is nested more than ${MAX_TOOL_DEPTH} levels deep.`;
      return { error: use.error };
    }

    const res = await askLive({
      model: hit.params.model,
      systemPrompt: String(hit.params.systemPrompt || ''),
      userPrompt: String(hit.params.userPrompt || ''),
      input,
      outputFields: fields,
      tools: liveToolsFor(hit.node),
      runTool: (n, a) => runToolLive(hit.node, n, a, [...chain, hit.node.id]),
    });
    const base = { node: hit.node.name, via: parent.name, tool: name, model: hit.params.model || null, perItem: true };

    if (res.ok) {
      trace.aiCalls.push({ ...base, fixture: null, denied: false, outputFields: fields, ...liveFields(res) });
      use.ok += 1;
      return res.output;
    }

    const rec = resolveAgentCall(scenario, {
      nodeName: hit.node.name, tool: name, input, model: hit.params.model, outputFields: fields, perItem: true,
    });
    trace.aiCalls.push({
      ...base, fixture: rec.ok ? rec.fixtureId : null, denied: Boolean(rec.denied), outputFields: fields,
      ...liveFields(res),
    });
    if (!rec.ok) {
      use.error = rec.explanation;
      return { error: rec.explanation };
    }
    if (rec.calls.length) {
      const nested = await runToolCalls(hit.node, rec.calls, [...chain, hit.node.id], true);
      if (nested) { use.error = nested; return { error: nested }; }
    }
    use.ok += 1;
    return rec.output;
  };

  /**
   * Record a node's outcome and tell whoever is watching. Every exit path in the
   * loop below goes through here, so a node can never light up in the UI and
   * then never light down.
   */
  /** nodeId -> its record, so a loop body's second pass merges into the first. */
  const recordById = new Map();

  const emitEnd = (record) => {
    if (!onProgress || quietIds.has(record.id)) return;
    onProgress({
      type: 'nodeEnd',
      id: record.id,
      name: record.name,
      status: record.status,
      itemsIn: record.itemsIn,
      itemsOut: record.itemsOut,
      error: record.error,
    });
  };

  const pushRecord = (record) => {
    const existing = recordById.get(record.id);
    if (existing) {
      /**
       * A loop body node runs once per batch, but the trace has one record per
       * node — grading looks nodes up by name, and three records called "Call API"
       * would make `itemCount` ambiguous. So the passes are summed, and `runs`
       * says how many there were, which is the number a reader actually wants.
       */
      existing.runs = (existing.runs || 1) + 1;
      existing.itemsIn += record.itemsIn;
      existing.itemsOut += record.itemsOut;
      existing.ms += record.ms;
      existing.notes.push(...record.notes);
      if (record.status === 'error') {
        existing.status = 'error';
        existing.error = record.error;
      }
      // The last pass's items are what a candidate opening the node will see.
      if (record.output) existing.output = record.output;
      if (record.outputSamples) existing.outputSamples = record.outputSamples;
      if (record.inputSample) existing.inputSample = record.inputSample;
      if (record.outputsByPort) {
        existing.outputsByPort = existing.outputsByPort
          ? existing.outputsByPort.map((p, i) => ({
            ...p, count: p.count + (record.outputsByPort[i] ? record.outputsByPort[i].count : 0),
          }))
          : record.outputsByPort;
      }
      emitEnd(existing);
      return;
    }

    recordById.set(record.id, record);
    trace.nodes.push(record);
    emitEnd(record);
  };

  /**
   * Run one node: gather its inputs, resolve its parameters, call it, record what
   * happened. Extracted from the walk below because Loop Over Items has to run
   * the same code again for each batch — the loop body is not a separate kind of
   * execution, it is the same execution happening more than once.
   */
  let outOfTime = false;
  let paused = false;

  const runOneNode = async (node) => {
    const def = getNode(node.type, scenario);
    const record = {
      id: node.id,
      name: node.name,
      type: node.type,
      itemsIn: 0,
      itemsOut: 0,
      status: 'success',
      ms: 0,
      notes: [],
      diagnostics: [],
      error: null,
    };

    if (!def) {
      record.status = 'error';
      record.error = `Unknown node type "${node.type}".`;
      pushRecord(record);
      trace.errors.push({ node: node.name, message: record.error });
      trace.status = 'error';
      outputsById.set(node.id, []);
      return;
    }

    const quiet = quietIds.has(node.id);
    if (onProgress && !quiet) {
      onProgress({ type: 'nodeStart', id: node.id, name: node.name, nodeType: node.type });
    }

    const ports = portsOf(def, node);

    // Gather inputs, one array per declared input port.
    const inputPorts = [];
    for (let port = 0; port < Math.max(def.inputs, 1); port++) {
      const sources = incoming.get(node.id).get(port) || [];
      const arrays = sources.map((s) => {
        const upstream = outputsById.get(s.from);
        return upstream ? (upstream[s.fromOutput] || []) : [];
      });
      inputPorts[port] = concatPort(arrays);
    }
    if (def.inputs === 0) inputPorts[0] = [];

    /**
     * `itemsIn` counts EVERY input, not just the first.
     *
     * Merge has two, and reporting only input 1 would print `in=5 out=8` on a
     * correct workflow — an unexplained increase, which is the same
     * false-negative shape as the branch-node bug. `inputsByPort` lets the report
     * show where the items came from.
     */
    record.itemsIn = def.inputs === 0
      ? 0
      : inputPorts.slice(0, def.inputs).reduce((a, p) => a + (p ? p.length : 0), 0);
    if (def.inputs > 1) {
      record.inputsByPort = inputPorts.slice(0, def.inputs)
        .map((p, i) => ({ port: i, count: p ? p.length : 0 }));
    }

    // Disabled nodes pass their input straight through.
    if (node.disabled) {
      record.status = 'disabled';
      record.itemsOut = inputPorts[0].length;
      record.outputSamples = [inputPorts[0].slice(0, 50)];
      outputsById.set(node.id, [inputPorts[0]]);
      nodeOutputsByName[node.name] = inputPorts[0];
      pushRecord(record);
      return;
    }

    // An upstream failure or an empty branch means there is nothing to do.
    // Skips propagate, so the trace reads "one node broke, the rest never ran"
    // rather than scattering misleading noItems down the chain.
    const upstreamFailed = [...(incoming.get(node.id).values())]
      .flat()
      .some((s) => {
        const r = trace.nodes.find((t) => t.id === s.from);
        return r && (r.status === 'error' || r.status === 'skipped');
      });
    if (upstreamFailed) {
      record.status = 'skipped';
      record.error = 'Skipped because an upstream node failed.';
      outputsById.set(node.id, []);
      pushRecord(record);
      return;
    }
    // Nothing on ANY input means nothing to do. Merge with items on only one of
    // its two inputs still has work — in append mode that is the whole point.
    if (def.inputs > 0 && record.itemsIn === 0) {
      record.status = 'noItems';
      record.itemsOut = 0;
      outputsById.set(node.id, ports.map(() => []));
      nodeOutputsByName[node.name] = [];
      pushRecord(record);
      return;
    }

    if (inputOnly && node.id === untilNode) {
      record.status = 'notRun';
      record.inputSample = inputPorts[0] ? inputPorts[0].slice(0, 50) : [];
      record.notes.push({ inputOnly: true });
      outputsById.set(node.id, ports.map(() => []));
      pushRecord(record);
      return;
    }

    const nodeStart = Date.now();
    const credential = node.credentialId ? credentials.get(node.credentialId) : null;

    if (!quiet) await pause(latencyFor(def, modeOf(def, node) === 'runOncePerItem' ? inputPorts[0].length : 1));

    /**
     * An approval either has its answer already or stops the run here.
     *
     * A paused trace is explicitly NOT a finished one: the server refuses to save
     * it as the graded run, exactly as it refuses a partial "Execute Node" run.
     */
    if (def.pauses) {
      const decision = decisions[node.name] !== undefined
        ? decisions[node.name]
        : decisions[node.id];

      if (decision !== 'approve' && decision !== 'reject') {
        record.status = 'paused';
        record.itemsOut = 0;
        outputsById.set(node.id, ports.map(() => []));
        trace.status = 'paused';
        trace.awaiting = {
          node: node.name,
          nodeId: node.id,
          prompt: String(node.parameters && node.parameters.prompt ? node.parameters.prompt : '')
            || `Approve ${inputPorts[0].length} item(s) at "${node.name}"?`,
          items: inputPorts[0].slice(0, 20).map((i) => i.json),
        };
        record.ms = Date.now() - nodeStart;
        pushRecord(record);
        paused = true;
        return;
      }

      const approved = decision === 'approve';
      const outputs = approved ? [inputPorts[0], []] : [[], inputPorts[0]];
      record.itemsOut = inputPorts[0].length;
      record.decision = decision;
      record.outputsByPort = [
        { port: 0, name: 'approved', count: outputs[0].length },
        { port: 1, name: 'rejected', count: outputs[1].length },
      ];
      record.output = outputs[approved ? 0 : 1].slice(0, 50);
      record.outputSamples = outputs.map((p) => p.slice(0, 50));
      record.inputSample = inputPorts[0].slice(0, 50);
      record.notes.push({ decision });

      outputsById.set(node.id, outputs);
      nodeOutputsByName[node.name] = outputs[0];
      record.ms = Date.now() - nodeStart;
      pushRecord(record);
      return;
    }

    // Loop Over Items is control flow, not computation: the scheduler runs it.
    if (def.loop) {
      await runLoop(node, def, record, inputPorts[0], nodeStart);
      return;
    }

    const makeCtx = (json, itemIndex, items, params) => ({
      params,
      now,
      credential,
      credentialTypes: credTypes,
      nodeName: node.name,
      triggerPayload: scenario.triggerPayload || {},
      request: async (req) => {
        const res = resolveRequest(scenario, req);
        trace.httpCalls.push({
          node: node.name,
          method: String(req.method || 'GET').toUpperCase(),
          path: res.loopbackPath,
          status: res.status,
          denied: Boolean(res.denied),
          matchedRoute: res.matchedRoute || null,
        });
        return res;
      },
      /**
       * An agent call is transport, so it goes through the same shape as an HTTP
       * one: resolved in-process against fixtures, recorded in the trace, and
       * default-deny. See engine/ai/resolver.js — the engine can only replay.
       */
      agent: async (call) => {
        let liveMiss = null;
        if (liveOn) {
          const answer = await askLive({
            model: call.model,
            systemPrompt: call.systemPrompt,
            userPrompt: call.userPrompt,
            input: call.input,
            outputFields: call.outputFields || [],
            tools: liveToolsFor(node),
            runTool: (name, args) => runToolLive(node, name, args, [node.id]),
          });
          if (answer.ok) {
            trace.aiCalls.push({
              node: node.name,
              model: call.model || null,
              perItem: Boolean(call.perItem),
              fixture: null,
              denied: false,
              outputFields: call.outputFields || [],
              ...liveFields(answer),
            });
            return { ok: true, output: answer.output, fixtureId: null, calls: [] };
          }
          liveMiss = answer;
        }

        const res = resolveAgentCall(scenario, { ...call, nodeName: node.name });
        trace.aiCalls.push({
          node: node.name,
          model: call.model || null,
          perItem: Boolean(call.perItem),
          fixture: res.ok ? res.fixtureId : null,
          denied: Boolean(res.denied),
          outputFields: call.outputFields || [],
          ...missedRequest(res, call),
          ...(liveMiss ? liveFields(liveMiss) : {}),
        });
        if (res.ok && res.calls.length) {
          const failed = await runToolCalls(node, res.calls, [node.id], Boolean(liveMiss));
          if (failed) return { ok: false, denied: false, explanation: failed };
        }
        return res;
      },
      sink: (payload) => {
        if (!trace.sinks[node.name]) trace.sinks[node.name] = [];
        trace.sinks[node.name].push(payload);
      },
      note: (note) => record.notes.push(note),
      json,
      itemIndex,
      items,
      // The Code node runs candidate JavaScript in the same isolate, and wants the
      // same context an expression gets.
      nodeOutputs: nodeOutputsForCode(nodeOutputsByName),
      vars: scenario.vars || {},
      env: scenario.env || {},
      codeTimeoutMs: limits.maxCodeMs,
    });

    try {
      let outputs;

      const nodeMode = modeOf(def, node);
      if (nodeMode === 'runOnceForAllItems' || def.inputs === 0) {
        const items = inputPorts[0];
        const exprCtx = {
          json: items[0] ? items[0].json : {},
          itemIndex: 0,
          items,
          nodeOutputs: nodeOutputsByName,
          vars: scenario.vars || {},
          env: scenario.env || {},
          now,
          timeoutMs: limits.maxExpressionMs,
        };
        const { value: params, diagnostics } = resolveParameters(node.parameters || {}, exprCtx);
        record.diagnostics = diagnostics;
        const ctx = makeCtx(exprCtx.json, 0, items, params);
        outputs = await def.run(ctx, inputPorts.map(cloneItems));
      } else {
        // runOncePerItem: the engine loops, the node sees one item.
        const items = inputPorts[0];
        const collected = ports.map(() => []);
        for (let i = 0; i < items.length; i++) {
          const exprCtx = {
            json: items[i].json,
            itemIndex: i,
            items,
            nodeOutputs: nodeOutputsByName,
            vars: scenario.vars || {},
            env: scenario.env || {},
            now,
            timeoutMs: limits.maxExpressionMs,
          };
          const { value: params, diagnostics } = resolveParameters(node.parameters || {}, exprCtx);
          if (i === 0) record.diagnostics = diagnostics;
          const ctx = makeCtx(items[i].json, i, items, params);
          const res = await def.run(ctx, [[{ ...items[i], pairedItem: i }]]);
          (res || []).forEach((portItems, port) => {
            if (!collected[port]) collected[port] = [];
            collected[port].push(...(portItems || []));
          });
          if (countItems(collected) > limits.maxItems) {
            throw new Error(`Produced more than ${limits.maxItems} items — check for an unintended fan-out.`);
          }
          if (elapsedReal() > limits.maxExecutionMs) {
            throw new Error(`Execution exceeded ${limits.maxExecutionMs}ms.`);
          }
        }
        outputs = collected;
      }

      outputs = (outputs || []).map((port) => port || []);
      while (outputs.length < ports.length) outputs.push([]);

      record.itemsOut = countItems(outputs);
      record.outputsByPort = outputs.map((p, i) => ({
        port: i, name: ports[i] ? ports[i].name : String(i), count: p.length,
      }));
      record.output = outputs[0] ? outputs[0].slice(0, 50) : [];
      record.outputSamples = outputs.map((p) => p.slice(0, 50));
      record.inputSample = inputPorts[0] ? inputPorts[0].slice(0, 50) : [];

      outputsById.set(node.id, outputs);
      nodeOutputsByName[node.name] = outputs[0] || [];
    } catch (err) {
      record.status = 'error';
      record.error = err.message;
      record.inputSample = inputPorts[0] ? inputPorts[0].slice(0, 50) : [];
      trace.errors.push({ node: node.name, message: err.message });
      trace.status = 'error';
      outputsById.set(node.id, ports.map(() => []));
    }

    record.ms = Date.now() - nodeStart;
    pushRecord(record);

    if (elapsedReal() > limits.maxExecutionMs) {
      trace.status = 'error';
      trace.errors.push({ node: node.name, message: `Execution exceeded ${limits.maxExecutionMs}ms.` });
      outOfTime = true;
    }
  
  };

  /**
   * Loop Over Items.
   *
   * Slice the input into batches; for each one, put the batch on the `loop` port
   * and run the body in topological order, exactly as the outer walk would. Items
   * that come back along a back-edge accumulate, and that accumulation is what
   * leaves on `done` when the batches run out.
   *
   * The body's nodes are excluded from the outer walk, so each of them runs here
   * and only here — once per batch, merged into a single trace record carrying a
   * `runs` count.
   */
  const runLoop = async (loopNode, def, record, items, nodeStart) => {
    const body = bodies.get(loopNode.id) || new Set();
    const bodyOrder = order.filter((n) => body.has(n.id));
    /**
     * Read straight off the node rather than through the expression resolver: a
     * batch size that changed between passes would make the loop's shape depend
     * on the data flowing through it, which is not something anyone could debug.
     */
    const size = Math.max(1, Math.floor(Number((loopNode.parameters || {}).batchSize) || 1));

    const closesTheLoop = [...backEdges].filter((c) => c.to === loopNode.id);
    const accumulated = [];
    let batches = 0;

    /**
     * Claim the loop's place in the trace BEFORE running the body, then fill the
     * record in at the end. Pushing it afterwards would list the loop below its
     * own body in the run log, which reads as though the body ran first.
     */
    recordById.set(record.id, record);
    trace.nodes.push(record);

    for (let start = 0; start < items.length; start += size) {
      batches++;
      if (batches > limits.maxLoopIterations) {
        record.status = 'error';
        record.error = `The loop ran ${limits.maxLoopIterations} times without finishing. `
          + 'Check the batch size — a batch size of 0 or a very large input can do this.';
        trace.errors.push({ node: loopNode.name, message: record.error });
        trace.status = 'error';
        outputsById.set(loopNode.id, [[], []]);
        record.ms = Date.now() - nodeStart;
        emitEnd(record);
        return;
      }

      const batch = items.slice(start, start + size);

      // Publish the batch on the `loop` port, so the body's nodes gather it the
      // ordinary way — the body does not know it is in a loop.
      outputsById.set(loopNode.id, [[], batch]);
      nodeOutputsByName[loopNode.name] = batch;

      let bodyFailed = null;
      for (const bodyNode of bodyOrder) {
        await runOneNode(bodyNode);
        const bodyRecord = recordById.get(bodyNode.id);
        if (bodyRecord && bodyRecord.status === 'error') bodyFailed = bodyNode.name;
        if (outOfTime || paused || bodyFailed) break;
        if (untilNode && bodyNode.id === untilNode) break;
      }

      for (const edge of closesTheLoop) {
        const out = outputsById.get(edge.from);
        const returned = out ? (out[edge.fromOutput || 0] || []) : [];
        accumulated.push(...returned);
      }

      if (accumulated.length > limits.maxItems) {
        record.status = 'error';
        record.error = `The loop produced more than ${limits.maxItems} items.`;
        trace.errors.push({ node: loopNode.name, message: record.error });
        trace.status = 'error';
        break;
      }
      /**
       * One failing pass stops the loop. Letting it run every remaining batch
       * would produce the same error N times and bury the first one, and a body
       * that is broken on batch 1 is broken on batch 40.
       */
      if (bodyFailed) {
        record.status = 'error';
        record.error = `Stopped on pass ${batches}: "${bodyFailed}" failed.`;
        trace.status = 'error';
        break;
      }
      if (outOfTime) break;
      if (untilNode && body.has(untilNode)) break;
    }

    /**
     * With a back-edge, `done` carries what came back — the loop's whole point is
     * that the body changed something. Without one, the body is a side-effect (a
     * message per batch, say) and `done` passes the original items through, which
     * is what makes a loop with nothing wired back still useful.
     */
    const doneItems = closesTheLoop.length ? accumulated : items;
    const outputs = [];
    outputs[DONE_PORT] = doneItems;
    outputs[LOOP_PORT] = [];

    record.itemsOut = doneItems.length;
    record.batches = batches;
    record.outputsByPort = [
      { port: DONE_PORT, name: 'done', count: doneItems.length },
      { port: LOOP_PORT, name: 'loop', count: items.length },
    ];
    record.output = doneItems.slice(0, 50);
    record.outputSamples = outputs.map((p) => p.slice(0, 50));
    record.inputSample = items.slice(0, 50);
    record.notes.push({ batches, batchSize: size, returned: accumulated.length });

    outputsById.set(loopNode.id, outputs);
    nodeOutputsByName[loopNode.name] = doneItems;
    record.ms = Date.now() - nodeStart;
    emitEnd(record);
  };

  for (const node of runList) {
    await runOneNode(node);
    if (outOfTime || paused) break;
  }

  /*
   * One record per tool node, so a subagent shows up in the run log, on the
   * canvas and in the report like every other node: `in` is how often it was
   * called, `out` how often it answered. A tool nobody called is `notRun`, which
   * is worth seeing — it usually means the parent's fixture never reaches it.
   */
  for (const node of nodes) {
    if (!isToolNode(node)) continue;
    const use = toolUse.get(node.id);
    pushRecord({
      id: node.id,
      name: node.name,
      type: node.type,
      itemsIn: use ? use.calls : 0,
      itemsOut: use ? use.ok : 0,
      status: node.disabled ? 'disabled' : (!use ? 'notRun' : (use.error ? 'error' : 'success')),
      ms: 0,
      notes: use ? [{ calledBy: [...use.via] }] : [],
      diagnostics: [],
      error: use && use.error ? use.error : null,
      tool: true,
    });
  }

  // A node with no outgoing connection on any port is a leaf; report its
  // final payload so the STDOUT can show what the workflow actually produced.
  trace.finalPayloads = {};
  // A `notRun` record (an unused tool, or the target of Execute previous nodes)
  // produced nothing, so it does not stop the node before it being a leaf.
  const executed = new Set(trace.nodes.filter((r) => r.status !== 'notRun').map((r) => r.id));
  for (const node of nodes) {
    if (!executed.has(node.id)) continue;
    // A node counts as a leaf when nothing downstream of it actually ran, which
    // makes the requested node the leaf of an Execute Node run.
    const downstream = [...(outgoing.get(node.id) || new Map()).values()].flat();
    const hasOut = downstream.some((d) => executed.has(d.to));
    if (hasOut) continue;
    const out = outputsById.get(node.id);
    if (out && out[0] && out[0].length) {
      trace.finalPayloads[node.name] = out[0].slice(0, 20).map((i) => i.json);
    }
  }

  trace.durationMs = Date.now() - startedAt;
  trace.simulatedMs = simulatedMs;
  return trace;
}

const MAX_TOOL_DEPTH = 4;

/**
 * On a fixture miss, what was asked — so `scripts/record-fixtures.js` can put
 * the same question to a real model and record the answer. Only on a miss: a
 * matched call needs nothing more, and the trace stays lean.
 */
function missedRequest(res, call) {
  if (res.ok) return {};
  return {
    request: {
      input: call.input || {},
      systemPrompt: String(call.systemPrompt || ''),
      userPrompt: String(call.userPrompt || ''),
    },
  };
}

/**
 * A circle in the "may call" graph, as node names, or null.
 *
 * The canvas already refuses a wire that closes a loop, but solution.json can
 * be written by other means, and an agent that can reach itself through its
 * tools is the one way a replayed workflow could recurse without end.
 */
function toolCycle(toolsOf, byId) {
  const state = new Map(); // id -> 1 visiting, 2 done
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const tool of toolsOf.get(id) || []) {
      if (state.get(tool.id) === 1) {
        const from = stack.indexOf(tool.id);
        return [...stack.slice(from), tool.id].map((x) => byId.get(x).name);
      }
      if (!state.has(tool.id)) {
        const found = visit(tool.id);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of toolsOf.keys()) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function countItems(outputs) {
  return outputs.reduce((a, p) => a + (p ? p.length : 0), 0);
}

function findDuplicate(names) {
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return null;
}

/** Every node whose output can reach `target`, directly or transitively. */
function ancestorsOf(target, connections) {
  const parents = new Map();
  for (const c of connections) {
    if (!parents.has(c.to)) parents.set(c.to, []);
    parents.get(c.to).push(c.from);
  }
  const seen = new Set();
  const stack = [...(parents.get(target) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parents.get(id) || []));
  }
  return seen;
}

/** Loop Over Items' two output ports, by index. */
const DONE_PORT = 0;
const LOOP_PORT = 1;

/**
 * Where each loop's body is, and which connections close the loop.
 *
 * A workflow with a loop is not a DAG, so the topological walk cannot see it as
 * one. Rather than making the whole scheduler iterative, the loop is treated as
 * a single step in the outer order that internally runs its body several times —
 * so exactly one part of the engine knows about cycles.
 *
 * The body is everything reachable from the `loop` port. The back-edges are the
 * connections from inside that body back into the loop node's input; they are
 * removed before ordering, which is what makes the rest of the graph a DAG again.
 *
 * @returns {{ bodies: Map<string, Set<string>>, backEdges: Set<object>, nested: string|null }}
 */
function loopStructure(nodes, connections, scenario) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const bodies = new Map();
  const backEdges = new Set();
  let nested = null;

  const loopNodes = nodes.filter((n) => {
    const def = getNode(n.type, scenario);
    return def && def.loop;
  });

  for (const loopNode of loopNodes) {
    const body = new Set();
    const stack = connections
      .filter((c) => c.from === loopNode.id && (c.fromOutput || 0) === LOOP_PORT)
      .map((c) => c.to);

    while (stack.length) {
      const id = stack.pop();
      // Stop at the loop node: arriving back at it is the back-edge, not more body.
      if (id === loopNode.id || body.has(id) || !byId.has(id)) continue;
      body.add(id);
      for (const c of connections) if (c.from === id) stack.push(c.to);
    }

    bodies.set(loopNode.id, body);

    for (const c of connections) {
      if (c.to === loopNode.id && body.has(c.from)) backEdges.add(c);
    }
  }

  // A loop inside another loop's body would need its inner body excluded from the
  // outer body's run list, and its counts nested two deep in the trace. Rejected
  // outright rather than half-supported: a wrong answer here is items silently
  // processed twice, which is the kind of bug nobody finds by looking.
  for (const loopNode of loopNodes) {
    for (const other of loopNodes) {
      if (other.id === loopNode.id) continue;
      if (bodies.get(loopNode.id).has(other.id)) nested = other.name;
    }
  }

  return { bodies, backEdges, nested };
}

/** Kahn's algorithm. Returns null on a cycle. */
function topologicalOrder(nodes, connections) {
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  const edges = new Map(nodes.map((n) => [n.id, []]));
  const ids = new Set(nodes.map((n) => n.id));

  for (const c of connections) {
    if (!ids.has(c.from) || !ids.has(c.to) || c.from === c.to) continue;
    edges.get(c.from).push(c.to);
    indegree.set(c.to, indegree.get(c.to) + 1);
  }

  // Stable: preserve authoring order among ready nodes so runs are reproducible.
  const ready = nodes.filter((n) => indegree.get(n.id) === 0);
  const order = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));

  while (ready.length) {
    const node = ready.shift();
    order.push(node);
    for (const next of edges.get(node.id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(byId.get(next));
    }
  }

  return order.length === nodes.length ? order : null;
}

function fail(trace, message) {
  trace.status = 'error';
  trace.errors.push({ node: null, message });
  trace.finalPayloads = {};
  trace.durationMs = 0;
  return trace;
}

module.exports = { executeWorkflow, topologicalOrder, ancestorsOf, modeOf, loopStructure };

function cleanDecisions(decisions) {
  const out = {};
  for (const [node, decision] of Object.entries(decisions || {})) {
    if (decision === 'approve' || decision === 'reject') out[node] = decision;
  }
  return out;
}
